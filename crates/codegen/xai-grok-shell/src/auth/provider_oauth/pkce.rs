// PKCE (RFC 7636) helpers for the provider OAuth flows.

use base64::Engine;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use sha2::{Digest, Sha256};

#[derive(Debug, Clone)]
pub(crate) struct Pkce {
    pub code_verifier: String,
    pub code_challenge: String,
}

/// 96 random bytes, base64url — a 128-char verifier (RFC 7636 allows up to
/// 128; omp uses this length for its provider flows).
pub(crate) fn generate_pkce() -> Pkce {
    let random_bytes: [u8; 96] = rand::random();
    let code_verifier = URL_SAFE_NO_PAD.encode(random_bytes);
    let code_challenge = URL_SAFE_NO_PAD.encode(Sha256::digest(code_verifier.as_bytes()));
    Pkce {
        code_verifier,
        code_challenge,
    }
}

/// 16 random bytes as 32 hex chars — the CSRF `state` parameter.
pub(crate) fn generate_state() -> String {
    let random_bytes: [u8; 16] = rand::random();
    random_bytes.iter().map(|b| format!("{b:02x}")).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn challenge_is_sha256_of_verifier() {
        let pkce = generate_pkce();
        assert_eq!(pkce.code_verifier.len(), 128);
        let expected = URL_SAFE_NO_PAD.encode(Sha256::digest(pkce.code_verifier.as_bytes()));
        assert_eq!(pkce.code_challenge, expected);
    }

    #[test]
    fn verifier_charset_is_url_safe() {
        let pkce = generate_pkce();
        assert!(
            pkce.code_verifier
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
        );
    }

    #[test]
    fn state_is_32_hex_chars() {
        let state = generate_state();
        assert_eq!(state.len(), 32);
        assert!(state.bytes().all(|b| b.is_ascii_hexdigit()));
    }

    #[test]
    fn rfc7636_appendix_b_vector() {
        // Known-answer test from RFC 7636 Appendix B.
        let verifier = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk";
        let challenge = URL_SAFE_NO_PAD.encode(Sha256::digest(verifier.as_bytes()));
        assert_eq!(challenge, "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM");
    }
}
