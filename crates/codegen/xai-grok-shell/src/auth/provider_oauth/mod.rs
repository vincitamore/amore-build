// provider_oauth — third-party OAuth login (Anthropic Claude Code, Cursor).
//
// Ported from the omp harness's OAuth methods (pi-ai registry/oauth): the same
// authorize/token endpoints, PKCE shape, callback-server UX, refresh semantics,
// and the ~30-day Anthropic grant-family re-login deadline. Credentials live in
// their own file (`oauth-credentials.json` under the harness home), separate
// from the first-party `auth.json` store.
//
// Consumption: a model entry sets `api_key = "oauth:anthropic"` (or
// `"oauth:cursor"`); `resolve_credentials` swaps the reference for a live
// access token and a per-model bearer resolver keeps it fresh across
// long-running sessions. On the Anthropic Messages backend the sampler applies
// the Claude Code OAuth wire fingerprint when the credential is an
// `sk-ant-oat…` token.

mod anthropic;
mod callback;
mod cursor;
mod login;
mod pkce;
pub mod resolver;
mod store;

pub use login::{resolve_api_key_reference, run_provider_login_cli};
pub use resolver::ProviderOAuthBearerResolver;

/// Live access credentials for a provider's stored login (sync; refreshes
/// on the dedicated thread when stale). Used by provider model discovery.
pub(crate) use login::blocking_fresh_credentials;

/// Whether a provider's stored credential exists (file read only; never
/// refreshes). Seeds discovery without touching the network.
pub(crate) fn has_stored_credentials(kind: ProviderKind) -> bool {
    store::load(&store::default_store_path(), kind).is_some()
}

/// The provider an `oauth:<provider>` model `api_key` value references, if any.
pub fn oauth_reference_kind(key: &str) -> Option<ProviderKind> {
    oauth_reference(key)
}

/// The providers this module can log in with.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ProviderKind {
    /// Claude Pro/Max via the Claude Code OAuth client (Anthropic).
    Anthropic,
    /// Cursor account OAuth (login + refresh; no first-party wire backend).
    Cursor,
}

impl ProviderKind {
    pub fn as_str(self) -> &'static str {
        match self {
            ProviderKind::Anthropic => "anthropic",
            ProviderKind::Cursor => "cursor",
        }
    }

    pub fn parse(value: &str) -> Option<ProviderKind> {
        match value {
            "anthropic" => Some(ProviderKind::Anthropic),
            "cursor" => Some(ProviderKind::Cursor),
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
/// Two spellings are accepted for convenience: `oauth:anthropic` and the
/// colon-terminated canonical form produced by [`ProviderKind::reference_prefix`]
/// (`oauth:anthropic:`). Returns the provider when `key` references one.
pub(crate) fn oauth_reference(key: &str) -> Option<ProviderKind> {
    let value = key.strip_prefix("oauth:")?;
    let name = value.trim_end_matches(':');
    ProviderKind::parse(name)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_reference_spellings() {
        assert_eq!(
            oauth_reference("oauth:anthropic"),
            Some(ProviderKind::Anthropic)
        );
        assert_eq!(
            oauth_reference("oauth:anthropic:"),
            Some(ProviderKind::Anthropic)
        );
        assert_eq!(oauth_reference("oauth:cursor"), Some(ProviderKind::Cursor));
        assert_eq!(oauth_reference("oauth:unknown"), None);
        assert_eq!(oauth_reference("sk-ant-oat-example"), None);
        assert_eq!(oauth_reference("plain-key"), None);
    }

    #[test]
    fn provider_kind_strings_round_trip() {
        for kind in [ProviderKind::Anthropic, ProviderKind::Cursor] {
            assert_eq!(ProviderKind::parse(kind.as_str()), Some(kind));
        }
    }
}
