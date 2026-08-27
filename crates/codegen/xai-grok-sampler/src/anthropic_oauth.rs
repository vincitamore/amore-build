// Anthropic OAuth wire fingerprint for the Messages backend.
//
// When a model credential is an Anthropic OAuth access token (`sk-ant-oat…`,
// minted by `amore login --provider anthropic`), requests must carry the
// Claude Code client shape the OAuth endpoint expects: bearer auth, the CC
// beta set and client headers, the CC system-instruction blocks with the
// billing header + `cch` attestation, CC-shaped `metadata.user_id`, and the
// 64k output clamp. This ports the method omp (`@oh-my-pi/pi-ai`,
// `providers/anthropic.ts` + `providers/claude-code-fingerprint.ts`) uses;
// API-key credentials never enter this path.

use sha2::{Digest, Sha256};
use xai_grok_sampling_types::messages::{
    Message, MessageContent, MessageRole, MessagesRequest, SystemParam, TextBlock,
};

pub(crate) const CLAUDE_CODE_VERSION: &str = "2.1.246";
const CLAUDE_CODE_SDK_VERSION: &str = "0.112.1";

/// Claude Code caps requested output at 64k tokens even when the model
/// ceiling is higher; OAuth requests clamp to match the wire fingerprint.
pub(crate) const CLAUDE_CODE_MAX_OUTPUT_TOKENS: u32 = 64_000;

const CC_SYSTEM_INSTRUCTION: &str =
    "You are a Claude agent, built on Anthropic's Claude Agent SDK.";

const CC_USER_AGENT: &str = "claude-cli/2.1.246 (external, claude-desktop)";

/// Anthropic `anthropic-beta` values for an OAuth agent request, in Claude
/// Code's header order. The `fallback-credit` beta follows the effort beta on
/// every OAuth agent request (matching the current fingerprint).
pub(crate) const CC_AGENT_BETAS: &[&str] = &[
    "claude-code-20250219",
    "oauth-2025-04-20",
    "interleaved-thinking-2025-05-14",
    "thinking-token-count-2026-05-13",
    "context-management-2025-06-27",
    "prompt-caching-scope-2026-01-05",
    "mid-conversation-system-2026-04-07",
    "advanced-tool-use-2025-11-20",
];
const EFFORT_BETA: &str = "effort-2025-11-24";
const FALLBACK_CREDIT_BETA: &str = "fallback-credit-2026-06-01";

/// Anthropic OAuth tokens are recognizable by prefix (omp's
/// `isAnthropicOAuthToken`); API keys never take the OAuth shape.
pub fn is_anthropic_oauth_token(key: &str) -> bool {
    key.starts_with("sk-ant-oat")
}

/// The credential riding a header set (bearer or x-api-key, per the scheme),
/// for fingerprint activation: `ClientDefaults` carries the key only as a
/// pre-built header, so both the activation check and the fallback bearer
/// read it back out of the headers.
pub fn credential_from_headers(
    headers: &reqwest::header::HeaderMap,
    scheme: crate::config::AuthScheme,
) -> Option<String> {
    use reqwest::header::{HeaderName, AUTHORIZATION};
    match scheme {
        crate::config::AuthScheme::Bearer => headers
            .get(AUTHORIZATION)?
            .to_str()
            .ok()?
            .strip_prefix("Bearer ")
            .map(str::to_owned),
        crate::config::AuthScheme::XApiKey => headers
            .get(HeaderName::from_static("x-api-key"))?
            .to_str()
            .ok()
            .map(str::to_owned),
    }
    .filter(|k| !k.is_empty())
}

/// Replace the fork's own default headers with the Claude Code OAuth set.
/// `fallback_key` seeds the bearer when no live resolver supplied one.
pub fn apply_oauth_headers(headers: &mut reqwest::header::HeaderMap, fallback_key: Option<&str>) {
    use reqwest::header::{HeaderName, HeaderValue, ACCEPT, AUTHORIZATION};

    // Strip fork-identifying defaults: x-grok-* telemetry headers, the fork
    // User-Agent, and any x-api-key (OAuth requests authenticate with a
    // bearer only).
    let strip: Vec<HeaderName> = headers
        .keys()
        .filter(|k| k.as_str().starts_with("x-grok") || **k == reqwest::header::USER_AGENT)
        .cloned()
        .collect();
    for name in strip {
        headers.remove(&name);
    }
    headers.remove(HeaderName::from_static("x-api-key"));
    headers.remove(ACCEPT);

    if !headers.contains_key(AUTHORIZATION) {
        if let Some(key) = fallback_key {
            if let Ok(value) = HeaderValue::from_str(&format!("Bearer {key}")) {
                headers.insert(AUTHORIZATION, value);
            }
        }
    }

    let mut insert = |name: &'static str, value: &str| {
        if let Ok(v) = HeaderValue::from_str(value) {
            headers.insert(HeaderName::from_static(name), v);
        }
    };
    let os = "Linux"; // the current fingerprint pins X-Stainless-OS statically
    insert("accept", "application/json");
    insert("anthropic-version", "2023-06-01");
    insert("anthropic-dangerous-direct-browser-access", "true");
    insert("x-app", "cli");
    insert("anthropic-beta", &cc_beta_header());
    insert("user-agent", CC_USER_AGENT);
    insert("x-stainless-retry-count", "0");
    insert("x-stainless-runtime-version", "v26.3.0");
    insert("x-stainless-package-version", CLAUDE_CODE_SDK_VERSION);
    insert("x-stainless-runtime", "node");
    insert("x-stainless-lang", "js");
    insert("x-stainless-arch", stainless_arch());
    insert("x-stainless-os", os);
    insert("x-stainless-timeout", "600");
    insert(
        "x-client-request-id",
        &uuid::Uuid::new_v4().to_string(),
    );
}

fn cc_beta_header() -> String {
    let mut betas: Vec<&str> = CC_AGENT_BETAS.to_vec();
    betas.push(EFFORT_BETA);
    betas.push(FALLBACK_CREDIT_BETA);
    betas.join(",")
}

fn stainless_arch() -> &'static str {
    match std::env::consts::ARCH {
        "x86_64" => "x64",
        "aarch64" => "arm64",
        _ => "other",
    }
}

/// Apply the OAuth payload shape to a Messages request: billing + CC
/// instruction system blocks, CC-shaped `metadata.user_id`, and the 64k
/// output clamp. `session_id` keys the user_id across a session's requests.
pub fn apply_oauth_request(request: &mut MessagesRequest, session_id: Option<&str>) {
    request.max_tokens = request.max_tokens.min(CLAUDE_CODE_MAX_OUTPUT_TOKENS);

    let mut blocks: Vec<TextBlock> = match request.system.take() {
        Some(SystemParam::Text(text)) => vec![text_block(text)],
        Some(SystemParam::Blocks(blocks)) => blocks,
        None => Vec::new(),
    };
    let already_applied = blocks
        .iter()
        .any(|b| b.text.starts_with(BILLING_HEADER_PREFIX));
    if !already_applied {
        // system[0] must be the billing block: the cch patcher anchors on
        // `"system":[{"type":"text","text":"x-anthropic-billing-header:`.
        let billing = text_block(billing_header(&first_user_message_text(&request.messages)));
        let instruction = text_block(CC_SYSTEM_INSTRUCTION.to_owned());
        blocks.insert(0, billing);
        blocks.insert(1, instruction);
    }
    request.system = Some(SystemParam::Blocks(blocks));

    request.metadata = Some(xai_grok_sampling_types::messages::Metadata {
        user_id: Some(cc_metadata_user_id(session_id)),
    });
}

fn text_block(text: String) -> TextBlock {
    TextBlock {
        r#type: "text".to_owned(),
        text,
        cache_control: None,
    }
}

const BILLING_HEADER_PREFIX: &str = "x-anthropic-billing-header:";
/// Salt matching Claude Code's `computeFingerprint` (ported via omp).
const BILLING_FINGERPRINT_SALT: &str = "59cf53e54c78";

/// `x-anthropic-billing-header: cc_version=<ver>.<f3>; cc_entrypoint=claude-desktop; cch=00000;`
///
/// fingerprint = sha256(salt + msg[4] + msg[7] + msg[20] + version)[:3] over
/// characters of the first user message. The `cch` placeholder is replaced
/// with the real attestation hash by [`patch_cch`] after serialization.
fn billing_header(first_user_message_text: &str) -> String {
    let chars: Vec<char> = first_user_message_text.chars().collect();
    let k: String = [4usize, 7, 20]
        .iter()
        .map(|i| chars.get(*i).copied().unwrap_or('0'))
        .collect();
    let mut hasher = Sha256::new();
    hasher.update(BILLING_FINGERPRINT_SALT.as_bytes());
    hasher.update(k.as_bytes());
    hasher.update(CLAUDE_CODE_VERSION.as_bytes());
    let digest = hasher.finalize();
    let suffix = to_hex(&digest)[..3].to_owned();
    format!("{BILLING_HEADER_PREFIX} cc_version={CLAUDE_CODE_VERSION}.{suffix}; cc_entrypoint=claude-desktop; cch=00000;")
}

/// `metadata.user_id` in the Claude Code JSON envelope:
/// `{"device_id": <64hex>, "session_id": <uuid>}`. The device id is a stable
/// sha256 of a fork-specific domain + the OS home directory, so attribution
/// stays constant per install without a persistent identifier file.
fn cc_metadata_user_id(session_id: Option<&str>) -> String {
    let device_seed = std::env::var_os("USERPROFILE")
        .or_else(|| std::env::var_os("HOME"))
        .map(|p| p.to_string_lossy().into_owned())
        .unwrap_or_default();
    let mut hasher = Sha256::new();
    hasher.update(b"amore-claude-device-id-v1\0");
    hasher.update(device_seed.as_bytes());
    let device_id = to_hex(&hasher.finalize());
    let session_id = session_id
        .filter(|s| !s.is_empty())
        .map(|s| s.to_owned())
        .unwrap_or_else(|| uuid::Uuid::new_v4().to_string());
    serde_json::json!({
        "device_id": device_id,
        "session_id": session_id,
    })
    .to_string()
}

/// First user message text (characters from it key the billing fingerprint).
fn first_user_message_text(messages: &[Message]) -> String {
    for message in messages {
        if !matches!(message.role, MessageRole::User) {
            continue;
        }
        return match &message.content {
            MessageContent::Text(text) => text.clone(),
            MessageContent::Blocks(blocks) => blocks
                .iter()
                .filter_map(|b| match b {
                    xai_grok_sampling_types::messages::ContentBlock::Text { text, .. } => {
                        Some(text.as_str())
                    }
                    _ => None,
                })
                .collect::<Vec<_>>()
                .join(" "),
        };
    }
    String::new()
}

// ============================================================================
// cch attestation
// ============================================================================

const CCH_SEED: u64 = 0x4d65_9218_e32a_3268;
const CCH_PLACEHOLDER: &[u8] = b"cch=00000";
const CCH_SEARCH_WINDOW: usize = 150;
const BILLING_SYSTEM_MARKER: &[u8] =
    b"\"system\":[{\"type\":\"text\",\"text\":\"x-anthropic-billing-header:";

/// Serialize the request and patch the `cch` attestation into the billing
/// header: XXHash64 of the body-with-placeholder (seed as in Claude Code),
/// low 20 bits, 5 hex chars, written in place over `cch=00000`.
pub fn serialize_patched(request: &MessagesRequest) -> Result<Vec<u8>, serde_json::Error> {
    let mut body = serde_json::to_vec(request)?;
    patch_cch(&mut body);
    Ok(body)
}

/// Returns which outcome the patch had, for tests and diagnostics.
pub(crate) fn patch_cch(body: &mut [u8]) -> &'static str {
    let Some(marker_idx) = find(body, BILLING_SYSTEM_MARKER, 0) else {
        return "no-billing-header";
    };
    let search_from = marker_idx + BILLING_SYSTEM_MARKER.len();
    let Some(placeholder_idx) = find(body, CCH_PLACEHOLDER, search_from) else {
        return "no-billing-header";
    };
    if placeholder_idx - search_from > CCH_SEARCH_WINDOW {
        return "unanchored";
    }
    let hash = xxh64(body, CCH_SEED);
    let cch = format!("{:05x}", hash & 0xF_FFFF);
    for (i, byte) in cch.bytes().enumerate() {
        body[placeholder_idx + 4 + i] = byte;
    }
    "patched"
}

fn find(haystack: &[u8], needle: &[u8], from: usize) -> Option<usize> {
    if needle.is_empty() || from >= haystack.len() {
        return None;
    }
    haystack[from..]
        .windows(needle.len())
        .position(|window| window == needle)
        .map(|i| i + from)
}

fn to_hex(bytes: &[u8]) -> String {
    let mut out = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        out.push_str(&format!("{byte:02x}"));
    }
    out
}

// ============================================================================
// XXHash64 (self-contained; no external dependency)
// ============================================================================

const P1: u64 = 0x9E37_79B1_85EB_CA87;
const P2: u64 = 0xC2B2_AE3D_27D4_EB4F;
const P3: u64 = 0x1656_67B1_9E37_79F9;
const P4: u64 = 0x85EB_CA77_C2B2_AE63;
const P5: u64 = 0x27D4_EB2F_1656_67C5;

fn read_u64(bytes: &[u8]) -> u64 {
    u64::from_le_bytes(bytes[..8].try_into().expect("u64 slice"))
}

fn read_u32(bytes: &[u8]) -> u32 {
    u32::from_le_bytes(bytes[..4].try_into().expect("u32 slice"))
}

fn round(acc: u64, input: u64) -> u64 {
    acc.wrapping_add(input.wrapping_mul(P2))
        .rotate_left(31)
        .wrapping_mul(P1)
}

fn merge_round(acc: u64, val: u64) -> u64 {
    (acc ^ round(0, val)).wrapping_mul(P1).wrapping_add(P4)
}

pub(crate) fn xxh64(input: &[u8], seed: u64) -> u64 {
    let len = input.len();
    let mut idx = 0usize;
    let mut h64;

    if len >= 32 {
        let mut v1 = seed.wrapping_add(P1).wrapping_add(P2);
        let mut v2 = seed.wrapping_add(P2);
        let mut v3 = seed;
        let mut v4 = seed.wrapping_sub(P1);
        while len - idx >= 32 {
            v1 = round(v1, read_u64(&input[idx..]));
            v2 = round(v2, read_u64(&input[idx + 8..]));
            v3 = round(v3, read_u64(&input[idx + 16..]));
            v4 = round(v4, read_u64(&input[idx + 24..]));
            idx += 32;
        }
        h64 = v1
            .rotate_left(1)
            .wrapping_add(v2.rotate_left(7))
            .wrapping_add(v3.rotate_left(12))
            .wrapping_add(v4.rotate_left(18));
        h64 = merge_round(h64, v1);
        h64 = merge_round(h64, v2);
        h64 = merge_round(h64, v3);
        h64 = merge_round(h64, v4);
    } else {
        h64 = seed.wrapping_add(P5);
    }

    h64 = h64.wrapping_add(len as u64);

    while len - idx >= 8 {
        h64 ^= round(0, read_u64(&input[idx..]));
        h64 = h64.rotate_left(27).wrapping_mul(P1).wrapping_add(P4);
        idx += 8;
    }
    if len - idx >= 4 {
        h64 ^= u64::from(read_u32(&input[idx..])).wrapping_mul(P1);
        h64 = h64.rotate_left(23).wrapping_mul(P2).wrapping_add(P3);
        idx += 4;
    }
    while idx < len {
        h64 ^= u64::from(input[idx]).wrapping_mul(P5);
        h64 = h64.rotate_left(11).wrapping_mul(P1);
        idx += 1;
    }

    h64 ^= h64 >> 33;
    h64 = h64.wrapping_mul(P2);
    h64 ^= h64 >> 29;
    h64 = h64.wrapping_mul(P3);
    h64 ^= h64 >> 32;
    h64
}

#[cfg(test)]
mod tests {
    use super::*;
    use xai_grok_sampling_types::messages::{Message, MessageRole};

    #[test]
    fn oauth_tokens_are_recognized_by_prefix() {
        assert!(is_anthropic_oauth_token("sk-ant-oat01-..."));
        assert!(!is_anthropic_oauth_token("sk-ant-api01-..."));
        assert!(!is_anthropic_oauth_token("oauth:anthropic"));
    }

    #[test]
    fn xxh64_matches_known_seed_zero_vectors() {
        assert_eq!(xxh64(b"", 0), 0xEF46_DB37_51D8_E999);
        assert_eq!(xxh64(b"a", 0), 0xD24E_C4F1_A98C_6E5B);
        assert_eq!(xxh64(b"abc", 0), 0x44BC_2CF5_AD77_0999);
        assert_eq!(
            xxh64(b"Nobody inspects the spammish repetition", 0),
            0xFBCE_A83C_8A37_8BF1
        );
    }

    #[test]
    fn xxh64_seed_changes_the_hash_deterministically() {
        let input = b"Nobody inspects the spammish repetition";
        let seeded = xxh64(input, CCH_SEED);
        assert_eq!(seeded, xxh64(input, CCH_SEED));
        assert_ne!(seeded, xxh64(input, 0));
    }

    #[test]
    fn billing_header_fingerprint_is_stable_and_uses_message_chars() {
        let text = "0123456789012345678901234567890";
        let a = billing_header(text);
        let b = billing_header(text);
        assert_eq!(a, b);
        assert!(a.starts_with(BILLING_HEADER_PREFIX));
        assert!(a.contains(&format!("cc_version={CLAUDE_CODE_VERSION}.")));
        assert!(a.contains("cc_entrypoint=claude-desktop;"));
        assert!(a.contains("cch=00000;"));
        // Different first-user-message chars -> different fingerprint suffix.
        assert_ne!(billing_header(text), billing_header("XXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX"));
    }

    #[test]
    fn short_messages_fall_back_to_zero_placeholder_chars() {
        let a = billing_header("");
        assert!(a.contains("cch=00000;"));
        // Recompute the expected suffix by hand: k = "000".
        let mut hasher = Sha256::new();
        hasher.update(BILLING_FINGERPRINT_SALT.as_bytes());
        hasher.update(b"000");
        hasher.update(CLAUDE_CODE_VERSION.as_bytes());
        let digest_hex = to_hex(&hasher.finalize());
        assert!(a.contains(&format!(".{};", &digest_hex[..3])));
    }

    fn request_with_user_text(text: &str) -> MessagesRequest {
        MessagesRequest {
            model: "claude-sonnet-4-6".to_owned(),
            messages: vec![Message {
                role: MessageRole::User,
                content: MessageContent::Text(text.to_owned()),
            }],
            max_tokens: 128_000,
            system: Some(SystemParam::Text("You are a house resident.".to_owned())),
            tools: None,
            tool_choice: None,
            temperature: None,
            top_p: None,
            top_k: None,
            stream: None,
            stop_sequences: None,
            thinking: None,
            output_config: None,
            metadata: None,
        }
    }

    #[test]
    fn apply_request_injects_blocks_metadata_and_clamp() {
        let mut request = request_with_user_text("0123456789012345678901234567890");
        apply_oauth_request(&mut request, Some("sess-1"));
        assert_eq!(request.max_tokens, CLAUDE_CODE_MAX_OUTPUT_TOKENS);

        let Some(SystemParam::Blocks(blocks)) = &request.system else {
            panic!("system should be blocks after the OAuth transform");
        };
        assert!(blocks.len() >= 3, "billing + CC instruction + user system");
        assert!(blocks[0].text.starts_with(BILLING_HEADER_PREFIX));
        assert_eq!(blocks[1].text, CC_SYSTEM_INSTRUCTION);
        assert_eq!(blocks[2].text, "You are a house resident.");

        let user_id = request.metadata.as_ref().unwrap().user_id.as_ref().unwrap();
        let parsed: serde_json::Value = serde_json::from_str(user_id).unwrap();
        assert_eq!(parsed["session_id"], "sess-1");
        assert!(parsed["device_id"].as_str().unwrap().len() == 64);
    }

    #[test]
    fn apply_request_is_idempotent() {
        // With a stable session id, a second application is a no-op (the
        // request builder retries paths depend on this). Without one, the
        // metadata session uuid deliberately regenerates per request.
        let mut request = request_with_user_text("hello world, this is long enough");
        apply_oauth_request(&mut request, Some("fixed-session"));
        let once = serialize_patched(&request).unwrap();
        apply_oauth_request(&mut request, Some("fixed-session"));
        let twice = serialize_patched(&request).unwrap();
        assert_eq!(once, twice);
    }

    #[test]
    fn serialize_patches_the_cch_attestation() {
        let mut request = request_with_user_text("0123456789012345678901234567890");
        apply_oauth_request(&mut request, Some("sess-2"));
        let mut body = serde_json::to_vec(&request).unwrap();

        // The serialized body anchors on the marker and carries the
        // placeholder before patching.
        assert!(find(&body, BILLING_SYSTEM_MARKER, 0).is_some());
        let status = patch_cch(&mut body);
        assert_eq!(status, "patched");
        assert!(!find(&body, CCH_PLACEHOLDER, 0).is_some());

        // The patched hash matches a recomputation over the pre-patch bytes.
        let mut unpatched = serde_json::to_vec(&request).unwrap();
        let marker_idx = find(&unpatched, BILLING_SYSTEM_MARKER, 0).unwrap();
        let search_from = marker_idx + BILLING_SYSTEM_MARKER.len();
        let placeholder_idx = find(&unpatched, CCH_PLACEHOLDER, search_from).unwrap();
        let expected = format!("{:05x}", xxh64(&unpatched, CCH_SEED) & 0xF_FFFF);
        assert_eq!(&body[placeholder_idx + 4..placeholder_idx + 9], expected.as_bytes());
    }

    #[test]
    fn body_without_billing_header_reports_no_patch() {
        let mut body = b"{\"model\":\"claude\",\"messages\":[]}".to_vec();
        assert_eq!(patch_cch(&mut body), "no-billing-header");
    }
}
