// Live bearer resolver for `oauth:<provider>` model credentials.

use xai_grok_sampler::config::BearerResolver;

use super::login::blocking_fresh_credentials;
use super::{ProviderKind, google_antigravity};

#[derive(Debug)]
pub struct ProviderOAuthBearerResolver {
    kind: ProviderKind,
}

impl ProviderOAuthBearerResolver {
    pub fn new(kind: ProviderKind) -> Self {
        Self { kind }
    }
}

impl BearerResolver for ProviderOAuthBearerResolver {
    fn current_bearer(&self) -> Option<String> {
        match blocking_fresh_credentials(self.kind) {
            Ok(creds) => match self.kind {
                ProviderKind::OpenAi => Some(creds.access),
                ProviderKind::GoogleAntigravity => {
                    Some(google_antigravity::encode_structured_credential(&creds))
                }
            },
            Err(e) => {
                tracing::error!(
                    provider = self.kind.as_str(),
                    error = %e,
                    "resolving live provider OAuth bearer"
                );
                eprintln!("error: {e}");
                None
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn resolver_is_named_for_its_provider() {
        let resolver = ProviderOAuthBearerResolver::new(ProviderKind::OpenAi);
        assert!(format!("{resolver:?}").contains("OpenAi"));
        let ag = ProviderOAuthBearerResolver::new(ProviderKind::GoogleAntigravity);
        assert!(format!("{ag:?}").contains("GoogleAntigravity"));
    }
}
