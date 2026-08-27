//! Encoding JSON values into `google.protobuf.Value` wire bytes.
//!
//! Cursor's `McpArgs.args` map carries each argument pre-encoded as a
//! protobuf `google.protobuf.Value` message. The vendored agent.proto
//! does not model the well-known types, so the encoding is done here
//! directly against the Value wire format (field numbers and types are
//! stable parts of the well-known-type contract).

use serde_json::Value as Json;

// google.protobuf.Value fields.
const FIELD_NULL: u32 = 1; // NullValue (enum, value 0)
const FIELD_NUMBER: u32 = 2; // double
const FIELD_STRING: u32 = 3; // string
const FIELD_BOOL: u32 = 4; // bool
const FIELD_STRUCT: u32 = 5; // Struct
const FIELD_LIST: u32 = 6; // ListValue

// Struct: map<string, Value> fields = 1; entry = {1: key, 2: value}.
const STRUCT_FIELD_FIELDS: u32 = 1;
// ListValue: repeated Value values = 1.
const LIST_FIELD_VALUES: u32 = 1;

fn put_tag(buf: &mut Vec<u8>, field: u32, wire_type: u32) {
    let tag = (field << 3) | wire_type;
    let mut tag_buf = [0u8; 5];
    let mut len = 0;
    let mut tag = tag;
    loop {
        let byte = (tag & 0x7f) as u8;
        tag >>= 7;
        if tag == 0 {
            tag_buf[len] = byte;
            len += 1;
            break;
        }
        tag_buf[len] = byte | 0x80;
        len += 1;
    }
    buf.extend_from_slice(&tag_buf[..len]);
}

fn put_len_delimited(buf: &mut Vec<u8>, field: u32, payload: &[u8]) {
    put_tag(buf, field, 2);
    let mut len_buf = [0u8; 5];
    let mut len = 0;
    let mut n = payload.len() as u64;
    loop {
        let byte = (n & 0x7f) as u8;
        n >>= 7;
        if n == 0 {
            len_buf[len] = byte;
            len += 1;
            break;
        }
        len_buf[len] = byte | 0x80;
        len += 1;
    }
    buf.extend_from_slice(&len_buf[..len]);
    buf.extend_from_slice(payload);
}

fn encode_struct(json: &serde_json::Map<String, Json>) -> Vec<u8> {
    let mut out = Vec::new();
    for (key, value) in json {
        let mut entry = Vec::new();
        put_len_delimited(&mut entry, 1, key.as_bytes());
        put_len_delimited(&mut entry, 2, &encode_value(value));
        put_len_delimited(&mut out, STRUCT_FIELD_FIELDS, &entry);
    }
    out
}

fn encode_list(json: &[Json]) -> Vec<u8> {
    let mut out = Vec::new();
    for value in json {
        put_len_delimited(&mut out, LIST_FIELD_VALUES, &encode_value(value));
    }
    out
}

fn encode_value(json: &Json) -> Vec<u8> {
    let mut out = Vec::new();
    match json {
        Json::Null => {
            // NullValue: enum zero — the tag alone encodes the default value.
            put_tag(&mut out, FIELD_NULL, 0);
        }
        Json::Bool(b) => {
            put_tag(&mut out, FIELD_BOOL, 0);
            out.push(u8::from(*b));
        }
        Json::Number(n) => {
            // Value only carries f64; non-finite JSON numbers are not
            // representable and degrade to null.
            let as_f64 = n.as_f64().unwrap_or_default();
            put_tag(&mut out, FIELD_NUMBER, 1);
            out.extend_from_slice(&as_f64.to_bits().to_le_bytes());
        }
        Json::String(s) => put_len_delimited(&mut out, FIELD_STRING, s.as_bytes()),
        Json::Object(map) => put_len_delimited(&mut out, FIELD_STRUCT, &encode_struct(map)),
        Json::Array(items) => put_len_delimited(&mut out, FIELD_LIST, &encode_list(items)),
    }
    out
}

/// Encode a JSON value into `google.protobuf.Value` wire bytes.
pub fn encode_proto_value(json: &Json) -> Vec<u8> {
    encode_value(json)
}

#[cfg(test)]
mod tests;
