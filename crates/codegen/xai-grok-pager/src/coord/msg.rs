//! Addressed message envelope (UUIDv7 msgid, kind dispatch, field identity).

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Disposition {
    Woken,
    Enqueued,
    Inbox,
    Deferred,
}

impl Disposition {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Woken => "woken",
            Self::Enqueued => "enqueued",
            Self::Inbox => "inbox",
            Self::Deferred => "deferred",
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct Party {
    pub seat: String,
    pub harness: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub session_id: Option<String>,
}

impl Party {
    pub fn ident(&self) -> String {
        format!(
            "{}/{}/{}",
            self.seat,
            self.harness,
            self.session_id.as_deref().unwrap_or("-")
        )
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct Envelope {
    pub msgid: String,
    #[serde(default = "default_kind")]
    pub kind: String,
    pub ts: String,
    pub from: Party,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub to: Option<Party>,
    pub text: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub in_reply_to: Option<String>,
}

fn default_kind() -> String {
    "message".into()
}

impl Envelope {
    pub fn new_message(text: impl Into<String>, to: Option<Party>) -> Self {
        Self {
            msgid: uuid::Uuid::now_v7().to_string(),
            kind: "message".into(),
            ts: chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Secs, true),
            from: Party {
                seat: super::seat(),
                harness: super::HARNESS.into(),
                model: std::env::var("HOUSE_MODEL").ok().filter(|s| !s.is_empty()),
                session_id: super::this_session_id(),
            },
            to,
            text: text.into(),
            in_reply_to: None,
        }
    }

    pub fn is_message(&self) -> bool {
        self.kind == "message"
    }
}

/// Injected turn body. The tags are the receive-contract surface the model sees.
pub fn wrap_prompt(env: &Envelope) -> String {
    format!(
        "<cross-session-message from=\"{}\">\n{}\n</cross-session-message>",
        env.from.ident(),
        env.text
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn wrap_prompt_carries_from_and_body() {
        let env = Envelope {
            msgid: "m1".into(),
            kind: "message".into(),
            ts: "2026-08-25T00:00:00Z".into(),
            from: Party {
                seat: "peer-one".into(),
                harness: "amore".into(),
                model: None,
                session_id: Some("abc".into()),
            },
            to: None,
            text: "pull before writing".into(),
            in_reply_to: None,
        };
        let w = wrap_prompt(&env);
        assert!(w.contains("peer-one/amore/abc"));
        assert!(w.contains("pull before writing"));
        assert!(w.starts_with("<cross-session-message"));
    }

    #[test]
    fn unknown_kind_is_not_a_message() {
        let mut env = Envelope::new_message("x", None);
        env.kind = "notice".into();
        assert!(!env.is_message());
    }
}
