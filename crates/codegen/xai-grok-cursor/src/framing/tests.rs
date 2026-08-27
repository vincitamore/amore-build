use super::*;

fn frame(bytes: &[u8], flags: u8) -> Vec<u8> {
    frame_connect_message(bytes, flags).to_vec()
}

#[test]
fn round_trips_a_plain_message_frame() {
    let payload = b"\x0a\x05hello";
    let wire = frame(payload, 0);
    assert_eq!(wire.len(), 5 + payload.len());
    assert_eq!(wire[0], 0);
    assert_eq!(&wire[1..5], &(payload.len() as u32).to_be_bytes());
    let Some((Frame::Message(msg), consumed)) = parse_frame(&wire).unwrap() else {
        panic!("expected a message frame");
    };
    assert_eq!(consumed, wire.len());
    assert_eq!(msg.as_ref(), payload);
}

#[test]
fn round_trips_an_end_stream_frame() {
    let payload = b"{}";
    let wire = frame(payload, FLAG_END_STREAM);
    assert_eq!(wire[0], FLAG_END_STREAM);
    let Some((Frame::EndStream(doc), _)) = parse_frame(&wire).unwrap() else {
        panic!("expected an end-stream frame");
    };
    assert_eq!(doc.as_ref(), payload);
}

#[test]
fn partial_buffers_wait_for_the_full_envelope() {
    let wire = frame(b"\x01\x02\x03", 0);
    // Header only: no frame yet.
    assert!(matches!(parse_frame(&wire[..4]).unwrap(), None));
    // Header + partial payload: still waiting.
    assert!(matches!(parse_frame(&wire[..6]).unwrap(), None));
    // Complete: one frame, whole envelope consumed.
    let Some((Frame::Message(msg), consumed)) = parse_frame(&wire).unwrap() else {
        panic!("expected a message frame");
    };
    assert_eq!(msg.as_ref(), b"\x01\x02\x03");
    assert_eq!(consumed, wire.len());
}

#[test]
fn parses_frames_back_to_back_from_one_buffer() {
    let a = frame(b"aaaa", 0);
    let b = frame(b"bb", 0);
    let mut wire = a.clone();
    wire.extend_from_slice(&b);
    let mut rest = wire.as_slice();
    let (first, n) = parse_frame(rest).unwrap().unwrap();
    assert!(matches!(first, Frame::Message(m) if m.as_ref() == b"aaaa"));
    rest = &rest[n..];
    let (second, n) = parse_frame(rest).unwrap().unwrap();
    assert!(matches!(second, Frame::Message(m) if m.as_ref() == b"bb"));
    assert_eq!(n, b.len());
    assert!(rest[n..].is_empty());
}

#[test]
fn rejects_compressed_frames() {
    let err = parse_frame(&frame(b"x", FLAG_COMPRESSED)).unwrap_err();
    assert!(matches!(err, FrameError::Compressed));
}

#[test]
fn rejects_absurd_length_fields() {
    let mut wire = vec![0u8; 5];
    wire[1..5].copy_from_slice(&(MAX_FRAME_LEN as u32 + 1).to_be_bytes());
    let err = parse_frame(&wire).unwrap_err();
    assert!(matches!(err, FrameError::TooLarge { .. }));
}

#[test]
fn empty_end_stream_payload_is_a_clean_close() {
    assert_eq!(parse_end_stream(b"{}"), Ok(None));
    assert_eq!(parse_end_stream(b""), Ok(None));
}

#[test]
fn error_end_stream_documents_decode_with_fields() {
    let doc = br#"{"error":{"code":"unauthenticated","message":"token expired","details":[]}}"#;
    let err = parse_end_stream(doc).unwrap().expect("error present");
    assert_eq!(err.code, "unauthenticated");
    assert_eq!(err.message, "token expired");
    assert_eq!(err.grpc_status(), Some(16));
    assert!(err.is_unauthenticated());
}

#[test]
fn malformed_end_stream_payload_is_an_error() {
    assert_eq!(parse_end_stream(b"not json"), Err(()));
}

#[test]
fn error_code_predicates_classify_the_branches_the_transport_uses() {
    let mut err = ConnectEndStreamError {
        code: "resource_exhausted".into(),
        message: "quota".into(),
        raw: String::new(),
    };
    assert!(err.is_resource_exhausted());
    assert!(!err.is_model_not_found());
    assert!(!err.is_unauthenticated());

    // The poison signal also arrives as gRPC text inside the message body.
    err = ConnectEndStreamError {
        code: "unknown".into(),
        message: "rpc error: code = ResourceExhausted ...".into(),
        raw: String::new(),
    };
    assert!(err.is_resource_exhausted());

    err = ConnectEndStreamError {
        code: "not_found".into(),
        message: "model not found".into(),
        raw: String::new(),
    };
    assert!(err.is_model_not_found());
    assert!(!err.is_resource_exhausted());
}

#[test]
fn display_names_the_connect_code() {
    let err = ConnectEndStreamError {
        code: "resource_exhausted".into(),
        message: "quota".into(),
        raw: String::new(),
    };
    assert_eq!(err.to_string(), "Connect error resource_exhausted: quota");
}

#[test]
fn unknown_codes_have_no_grpc_status() {
    let err = ConnectEndStreamError {
        code: "totally_new_code".into(),
        message: String::new(),
        raw: String::new(),
    };
    assert_eq!(err.grpc_status(), None);
}
