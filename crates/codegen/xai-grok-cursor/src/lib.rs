//! Cursor agent wire backend.
//!
//! Speaks the Connect protocol over raw HTTP/2 to Cursor's
//! `agent.v1.AgentService/Run` endpoint: protobuf request envelopes,
//! server-pushed blob (KV) traffic, the mandatory request-context
//! handshake, and mid-stream client writes (heartbeats, KV replies,
//! exec rejections) on the single request stream. Raw transport only —
//! mapping server messages onto the sampler's event model lives in the
//! sampler crate, which consumes [`crate::run`].

pub mod framing;
pub mod json_value;
pub mod proto {
    include!(concat!(env!("OUT_DIR"), "/agent.v1.rs"));
}
pub mod request;
pub mod responder;
pub mod transport;

use std::collections::{HashMap, HashSet};
use std::sync::Mutex;

pub use transport::RunStreamConfig;

/// Conversation-id rotation registry (`base wire id → rotated wire id`).
///
/// Cursor's backend can pin a per-conversation rejection (bare
/// `resource_exhausted`, zero tokens) to one conversationId forever, so
/// on such a failure the wire id is rotated and the next attempt
/// rebuilds a fresh conversation. One rotation per failure streak: a
/// fresh rotation is allowed only after the current rotated id has
/// completed a turn.
#[derive(Default)]
struct RotationRegistry {
    rotated: HashMap<String, String>,
    /// Rotated ids that completed a turn; a later poison of one of them
    /// may rotate again.
    completed: HashSet<String>,
}

static ROTATIONS: Mutex<Option<RotationRegistry>> = Mutex::new(None);

fn with_rotations<T>(f: impl FnOnce(&mut RotationRegistry) -> T) -> T {
    let mut guard = ROTATIONS.lock().expect("rotation registry lock");
    f(guard.get_or_insert_with(RotationRegistry::default))
}

/// Wire conversation id for a base id, honoring a registered rotation.
pub fn conversation_id_for(base: &str) -> String {
    with_rotations(|r| r.rotated.get(base).cloned().unwrap_or_else(|| base.to_string()))
}

/// Record a rotation: `base` now maps to a fresh uuid.
pub fn rotate_conversation_id(base: &str) -> String {
    let rotated = uuid::Uuid::new_v4().to_string();
    with_rotations(|r| {
        r.rotated.insert(base.to_string(), rotated.clone());
    });
    rotated
}

/// Mark the current wire id for `base` as having completed a turn.
pub fn mark_conversation_completed(base: &str) {
    with_rotations(|r| {
        if let Some(current) = r.rotated.get(base) {
            let current = current.clone();
            r.completed.insert(current);
        }
    });
}

/// Whether the wire id currently mapped for `base` has completed a turn.
pub fn rotation_completed(wire_id: &str) -> bool {
    with_rotations(|r| r.completed.contains(wire_id))
}

/// Whether `base` may rotate again: no rotation yet, or the current
/// rotated id has completed a turn.
pub fn can_rotate(base: &str) -> bool {
    with_rotations(|r| match r.rotated.get(base) {
        None => true,
        Some(current) => r.completed.contains(current),
    })
}

#[cfg(test)]
mod rotation_tests;
