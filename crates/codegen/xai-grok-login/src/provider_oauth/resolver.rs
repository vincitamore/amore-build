// Live bearer resolver for `oauth:<provider>` model credentials.

use xai_grok_sampler::config::BearerResolver;

use super::ProviderKind;
use super::login::blocking_fresh_credentials;

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
            Ok(creds) => Some(creds.access),
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
    }
}
