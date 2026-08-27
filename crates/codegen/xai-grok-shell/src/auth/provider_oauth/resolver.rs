// Live bearer resolver for `oauth:<provider>` model credentials.
//
// `sampling_config_for_model` attaches one of these per OAuth-reference model
// so every request reads the credential store: a token refreshed in another
// process (or by a login) is picked up immediately, and a token gone stale
// mid-session is refreshed before it rides the wire. The trait is sync by
// design; the refresh path hops to a dedicated thread (see
// `blocking_fresh_credentials`) so it is safe on tokio workers.

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
        let resolver = ProviderOAuthBearerResolver::new(ProviderKind::Anthropic);
        assert!(format!("{resolver:?}").contains("Anthropic"));
    }
}
