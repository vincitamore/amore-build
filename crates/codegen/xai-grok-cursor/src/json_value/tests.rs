use super::*;

/// Minimal protobuf reader good enough to assert on encoded Value bytes.
fn read_varint(buf: &[u8], pos: &mut usize) -> u64 {
    let mut result = 0u64;
    let mut shift = 0;
    loop {
        let b = buf[*pos];
        *pos += 1;
        result |= u64::from(b & 0x7f) << shift;
        if b & 0x80 == 0 {
            return result;
        }
        shift += 7;
    }
}

fn fields(buf: &[u8]) -> Vec<(u32, u32, Vec<u8>)> {
    let mut out = Vec::new();
    let mut pos = 0;
    while pos < buf.len() {
        let tag = read_varint(buf, &mut pos);
        let field = (tag >> 3) as u32;
        let wire_type = (tag & 7) as u32;
        match wire_type {
            0 => {
                let start = pos;
                // NullValue is a tag-only default (no value bytes).
                if pos < buf.len() {
                    read_varint(buf, &mut pos);
                }
                out.push((field, wire_type, buf[start..pos].to_vec()));
            }
            1 => {
                let payload = buf[pos..pos + 8].to_vec();
                pos += 8;
                out.push((field, wire_type, payload));
            }
            2 => {
                let len = read_varint(buf, &mut pos) as usize;
                let payload = buf[pos..pos + len].to_vec();
                pos += len;
                out.push((field, wire_type, payload));
            }
            other => panic!("unexpected wire type {other}"),
        }
    }
    out
}

#[test]
fn encodes_primitives_to_the_value_wire_format() {
    // null → tag-only NullValue (field 1, varint).
    let null = encode_proto_value(&Json::Null);
    assert_eq!(null, vec![0x08]);

    // true → field 4, varint 1.
    assert_eq!(encode_proto_value(&Json::Bool(true)), vec![0x20, 0x01]);
    assert_eq!(encode_proto_value(&Json::Bool(false)), vec![0x20, 0x00]);

    // 42 → field 2, 64-bit little-endian double.
    let num = encode_proto_value(&Json::Number(42.into()));
    let (f, wt, payload) = &fields(&num)[0];
    assert_eq!((*f, *wt), (2, 1));
    assert_eq!(
        f64::from_le_bytes(payload.as_slice().try_into().unwrap()),
        42.0
    );

    // "hi" → field 3, length-delimited.
    let s = encode_proto_value(&Json::String("hi".into()));
    assert_eq!(s, vec![0x1A, 0x02, b'h', b'i']);
}

#[test]
fn encodes_nested_structs_and_lists() {
    let json: Json = serde_json::from_str(r#"{"a": [1, null], "b": {"c": "d"}}"#).unwrap();
    // An object rides the Value wrapper (field 5) around the Struct.
    let wrapper = fields(&encode_proto_value(&json));
    assert_eq!((wrapper[0].0, wrapper[0].1), (5, 2));
    let top = fields(&wrapper[0].2);
    assert_eq!(top.len(), 2, "two map entries");

    // Entry 1: key "a", value = list (Value field 6 wraps ListValue).
    let entry = &top[0];
    let entry_fields = fields(&entry.2);
    assert_eq!(String::from_utf8(entry_fields[0].2.clone()).unwrap(), "a");
    let list = fields(&entry_fields[1].2);
    assert_eq!((list[0].0, list[0].1), (6, 2), "Value.list_value entry");
    let list_items = fields(&list[0].2);
    assert_eq!(list_items.len(), 2);
    // Each list item is itself a Value message.
    let item0 = fields(&list_items[0].2);
    assert_eq!((item0[0].0, item0[0].1), (2, 1), "double");
    let item1 = fields(&list_items[1].2);
    assert_eq!((item1[0].0, item1[0].1), (1, 0), "NullValue");

    // Entry 2: key "b", value = nested struct (Value field 5 wraps
    // Struct; Struct.fields entries are field-1 map entries).
    let b_entry = fields(&top[1].2);
    assert_eq!(String::from_utf8(b_entry[0].2.clone()).unwrap(), "b");
    let inner = fields(&b_entry[1].2);
    assert_eq!((inner[0].0, inner[0].1), (5, 2), "Value.struct_value entry");
    let kv = fields(&inner[0].2);
    // The map entry is itself a message: key (1) + Value (2); the
    // string rides field 3 inside that Value.
    let kv_entry = fields(&kv[0].2);
    assert_eq!(String::from_utf8(kv_entry[0].2.clone()).unwrap(), "c");
    let value_string = fields(&kv_entry[1].2);
    assert_eq!((value_string[0].0, value_string[0].1), (3, 2));
    assert_eq!(String::from_utf8(value_string[0].2.clone()).unwrap(), "d");
    assert_eq!(entry_fields[1].0, 2, "map entry value rides field 2");
}

#[test]
fn multi_byte_varint_tags_round_trip() {
    // Field number ≥ 16 needs a two-byte varint tag.
    let long_string = encode_proto_value(&Json::String("x".repeat(200)));
    let (f, wt, payload) = &fields(&long_string)[0];
    assert_eq!((*f, *wt), (3, 2));
    assert_eq!(payload.len(), 200);
}

#[test]
fn empty_containers_encode_to_empty_payloads() {
    let empty_obj = encode_proto_value(&serde_json::json!({}));
    assert_eq!(empty_obj, vec![0x2A, 0x00], "field 5, len 0");
    let empty_arr = encode_proto_value(&serde_json::json!([]));
    assert_eq!(empty_arr, vec![0x32, 0x00], "field 6, len 0");
}

