// Third-party OAuth login (OpenAI Codex / ChatGPT Plus & Pro).
//
// Ported from the omp harness's OpenAI Codex OAuth flow: PKCE browser login on
// http://localhost:1455/auth/callback, headless device-code login against
// auth.openai.com/api/accounts/deviceauth/*, JWT identity extraction, and
// compare-and-set refresh into ~/.amore/oauth-credentials.json.
//
// A model entry sets `api_key = "oauth:openai"` (or `"oauth:openai-codex"`):
// `resolve_credentials` resolves a fresh access token, and a per-model
// `BearerResolver` refreshes on expiry across long-running sessions.

mod callback;
mod login;
pub mod openai;
mod pkce;
pub mod resolver;
mod store;

pub use login::{resolve_api_key_reference, run_provider_login_cli};
pub use resolver::ProviderOAuthBearerResolver;

/// The provider an `oauth:<provider>` model `api_key` value references, if any.
pub fn oauth_reference_kind(key: &str) -> Option<ProviderKind> {
    oauth_reference(key)
}

/// Third-party OAuth providers supported by `amore login --provider`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ProviderKind {
    /// ChatGPT Plus/Pro via the OpenAI Codex OAuth client.
    OpenAi,
}

/// Login flow variant selected on the CLI.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LoginFlowKind {
    /// Browser PKCE callback flow (`openai` / `openai-codex`).
    OpenAiBrowser,
    /// Headless device-code flow (`openai-codex-device`, or `--device-auth`).
    OpenAiDevice,
}

impl LoginFlowKind {
    pub fn provider(self) -> ProviderKind {
        match self {
            LoginFlowKind::OpenAiBrowser | LoginFlowKind::OpenAiDevice => ProviderKind::OpenAi,
        }
    }

    pub fn parse(value: &str, force_device: bool) -> Option<LoginFlowKind> {
        match value.trim().to_ascii_lowercase().as_str() {
            "openai" | "openai-codex" => Some(if force_device {
                LoginFlowKind::OpenAiDevice
            } else {
                LoginFlowKind::OpenAiBrowser
            }),
            "openai-codex-device" | "openai-device" => Some(LoginFlowKind::OpenAiDevice),
            _ => None,
        }
    }
}

impl ProviderKind {
    /// Canonical key used in `oauth-credentials.json`.
    pub fn as_str(self) -> &'static str {
        match self {
            ProviderKind::OpenAi => "openai",
        }
    }

    pub fn parse(value: &str) -> Option<ProviderKind> {
        match value.trim().to_ascii_lowercase().as_str() {
            "openai" | "openai-codex" | "openai-codex-device" | "openai-device" => {
                Some(ProviderKind::OpenAi)
            }
            _ => None,
        }
    }

    /// The prefix a model `api_key` value uses to reference this provider's
    /// stored credential.
    pub fn reference_prefix(self) -> String {
        format!("oauth:{}:", self.as_str())
    }
}

/// The `api_key = "oauth:<provider>"` indirection convention.
///
/// Accepts `oauth:openai`, `oauth:openai-codex`, and colon-terminated forms
/// (`oauth:openai:`).
pub(crate) fn oauth_reference(key: &str) -> Option<ProviderKind> {
    let value = key.trim().strip_prefix("oauth:")?;
    let name = value.trim_end_matches(':');
    ProviderKind::parse(name)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_reference_spellings() {
        assert_eq!(oauth_reference("oauth:openai"), Some(ProviderKind::OpenAi));
        assert_eq!(oauth_reference("oauth:openai:"), Some(ProviderKind::OpenAi));
        assert_eq!(
            oauth_reference("oauth:openai-codex"),
            Some(ProviderKind::OpenAi)
        );
        assert_eq!(
            oauth_reference("oauth:openai-codex:"),
            Some(ProviderKind::OpenAi)
        );
        assert_eq!(oauth_reference("oauth:unknown"), None);
        assert_eq!(oauth_reference("sk-proj-example"), None);
        assert_eq!(oauth_reference("plain-key"), None);
    }

    #[test]
    fn provider_kind_and_flow_parse() {
        assert_eq!(
            LoginFlowKind::parse("openai", false),
            Some(LoginFlowKind::OpenAiBrowser)
        );
        assert_eq!(
            LoginFlowKind::parse("openai-codex", false),
            Some(LoginFlowKind::OpenAiBrowser)
        );
        assert_eq!(
            LoginFlowKind::parse("openai", true),
            Some(LoginFlowKind::OpenAiDevice)
        );
        assert_eq!(
            LoginFlowKind::parse("openai-codex-device", false),
            Some(LoginFlowKind::OpenAiDevice)
        );
        assert_eq!(
            ProviderKind::parse(ProviderKind::OpenAi.as_str()),
            Some(ProviderKind::OpenAi)
        );
    }
}
