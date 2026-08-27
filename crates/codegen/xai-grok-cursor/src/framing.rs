//! Connect protocol envelope framing.
//!
//! Every message on the Run stream (either direction) is a single
//! envelope: 1 flag byte + 4-byte big-endian payload length + payload.
//! Flag `0b01` = compressed (this client negotiates no compression and
//! rejects such frames), flag `0b10` = end-of-stream; its payload is a
//! JSON `{error: {code, message, details}}` document when the server
//! failed the RPC and may be absent when it merely closes the stream.

use bytes::{BufMut, Bytes, BytesMut};

pub const FLAG_COMPRESSED: u8 = 0b0000_0001;
pub const FLAG_END_STREAM: u8 = 0b0000_0010;

/// Errors carried by a Connect end-of-stream envelope.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ConnectEndStreamError {
    pub code: String,
    pub message: String,
    /// Raw JSON document, for diagnostics.
    pub raw: String,
}

impl ConnectEndStreamError {
    /// gRPC status number for this Connect code, when it is one of the
    /// codes this backend branches on.
    pub fn grpc_status(&self) -> Option<u32> {
        connect_code_to_grpc(&self.code)
    }

    /// True for the bare conversation-poison signal: gRPC
    /// `resource_exhausted` (8) in the code or anywhere in the message
    /// (the gRPC text spells it without the underscore).
    pub fn is_resource_exhausted(&self) -> bool {
        self.grpc_status() == Some(8) || {
            let normalized = self.message.to_lowercase().replace('_', "");
            normalized.contains("resourceexhausted")
        }
    }

    /// True for the model-resolution failures retried with the wire id
    /// the caller configured (Connect `not_found` / gRPC 5).
    pub fn is_model_not_found(&self) -> bool {
        self.grpc_status() == Some(5)
    }

    /// True when the server rejected the credential (Connect
    /// `unauthenticated` / gRPC 16); triggers the token-refresh lane.
    pub fn is_unauthenticated(&self) -> bool {
        self.grpc_status() == Some(16)
    }
}

impl std::fmt::Display for ConnectEndStreamError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "Connect error {}: {}", self.code, self.message)
    }
}

impl std::error::Error for ConnectEndStreamError {}

/// Connect code → gRPC status, for the codes this backend branches on.
fn connect_code_to_grpc(code: &str) -> Option<u32> {
    Some(match code {
        "canceled" => 1,
        "unknown" => 2,
        "invalid_argument" => 3,
        "deadline_exceeded" => 4,
        "not_found" => 5,
        "already_exists" => 6,
        "permission_denied" => 7,
        "resource_exhausted" => 8,
        "failed_precondition" => 9,
        "aborted" => 10,
        "out_of_range" => 11,
        "unimplemented" => 12,
        "internal" => 13,
        "unavailable" => 14,
        "data_loss" => 15,
        "unauthenticated" => 16,
        _ => return None,
    })
}

/// Wire one payload into a Connect envelope.
pub fn frame_connect_message(payload: &[u8], flags: u8) -> Bytes {
    let mut buf = BytesMut::with_capacity(5 + payload.len());
    buf.put_u8(flags);
    // 4-byte big-endian length; a payload past u32::MAX is not a legal
    // frame on this protocol.
    buf.put_u32(
        u32::try_from(payload.len()).expect("connect frame payload fits in u32"),
    );
    buf.put_slice(payload);
    buf.freeze()
}

/// Envelope-parse outcome for one buffer scan.
#[derive(Debug)]
pub enum Frame {
    /// flags == 0: a binary protobuf message.
    Message(Bytes),
    /// flags & END_STREAM: JSON end-of-stream document.
    EndStream(Bytes),
}

#[derive(Debug)]
pub enum FrameError {
    /// flags & COMPRESSED: no compression is negotiated on this stream.
    Compressed,
    /// Length field exceeds the guard limit.
    TooLarge { len: u32, limit: u32 },
}

/// Payload guard for recv-side framing. Real agent frames are protobuf
/// messages and JSON error documents, both far below this bound; a
/// length field past it means a desynchronized stream.
pub const MAX_FRAME_LEN: u32 = 64 * 1024 * 1024;

/// Parse one envelope from the head of `buf`. Returns the frame and the
/// number of bytes consumed, or `None` when more bytes are needed.
pub fn parse_frame(buf: &[u8]) -> Result<Option<(Frame, usize)>, FrameError> {
    if buf.len() < 5 {
        return Ok(None);
    }
    let flags = buf[0];
    let len = u32::from_be_bytes([buf[1], buf[2], buf[3], buf[4]]);
    if flags & FLAG_COMPRESSED != 0 {
        return Err(FrameError::Compressed);
    }
    if len > MAX_FRAME_LEN {
        return Err(FrameError::TooLarge {
            len,
            limit: MAX_FRAME_LEN,
        });
    }
    let total = 5usize + len as usize;
    if buf.len() < total {
        return Ok(None);
    }
    let frame = if flags & FLAG_END_STREAM != 0 {
        Frame::EndStream(Bytes::copy_from_slice(&buf[5..total]))
    } else {
        Frame::Message(Bytes::copy_from_slice(&buf[5..total]))
    };
    Ok(Some((frame, total)))
}

/// Decode an end-of-stream JSON payload. `Ok(None)` = clean close (no
/// error document, including a zero-length marker); `Ok(Some(err))` =
/// the RPC failed; `Err(())` = unparseable payload, treated by the
/// caller as a failed stream.
pub fn parse_end_stream(payload: &[u8]) -> Result<Option<ConnectEndStreamError>, ()> {
    if payload.iter().all(|b| b.is_ascii_whitespace()) {
        return Ok(None);
    }
    let Ok(doc) = serde_json::from_slice::<serde_json::Value>(payload) else {
        return Err(());
    };
    let Some(error) = doc.get("error") else {
        return Ok(None);
    };
    let code = match error.get("code") {
        Some(serde_json::Value::String(s)) => s.clone(),
        _ => "unknown".to_string(),
    };
    let message = match error.get("message") {
        Some(serde_json::Value::String(s)) => s.clone(),
        _ => "Unknown error".to_string(),
    };
    Ok(Some(ConnectEndStreamError {
        code,
        message,
        raw: String::from_utf8_lossy(payload).into_owned(),
    }))
}

#[cfg(test)]
mod tests;
