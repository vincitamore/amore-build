//! Provider model discovery (fork-owned): OpenRouter + Cursor.
//!
//! Synthesizes catalog entries from each provider's own model listing so
//! a BYOK credential is enough to fill the model picker — no manual
//! `[model.*]` block per model. Discovery entries merge into the
//! prefetched layer (config `[model.*]` overrides still win per key) and
//! are cached per source under the grok home, keeping startup off the
//! network path.
//!
//! Seeds (when discovery runs at all):
//! - OpenRouter: a `[model.*]` entry pointing at `openrouter.ai` with a
//!   resolvable credential, or a set `OPENROUTER_API_KEY` environment
//!   variable.
//! - Cursor: stored `oauth:cursor` credentials
//!   (`amore login --provider cursor`).
//!
//! Cache entries carry the seed credential that was current at fetch
//! time; a credential change takes effect on the next refresh (TTL-gated).

use super::*;

use crate::sampling::ApiBackend;

/// Inference base URL for OpenRouter models.
pub(crate) const OPENROUTER_BASE_URL: &str = "https://openrouter.ai/api/v1";
/// Environment variable that seeds OpenRouter discovery without a config entry.
pub(crate) const OPENROUTER_ENV_KEY: &str = "OPENROUTER_API_KEY";
/// Model-entry `api_key` value that references the stored Cursor OAuth
/// credential.
pub(crate) const CURSOR_OAUTH_KEY_REF: &str = "oauth:cursor";

/// Discovery cache TTL; the xAI catalog cache keeps its own shorter TTL.
const DISCOVERY_TTL: std::time::Duration = std::time::Duration::from_secs(3600);

/// Fallback context window when a provider listing carries none
/// (Cursor's `GetUsableModels` carries none).
const DISCOVERY_DEFAULT_CONTEXT_WINDOW: u64 = 200_000;
/// Default completion ceiling for discovered Cursor models (no field in
/// the response).
const CURSOR_DEFAULT_MAX_COMPLETION_TOKENS: u32 = 64_000;
/// Context ceiling recovered from display-name labels and known 1M
/// families Cursor serves unlabeled.
const CURSOR_1M_CONTEXT_WINDOW: u64 = 1_000_000;

/// Which provider a discovery entry came from.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
enum DiscoverySource {
    OpenRouter,
    Cursor,
}

/// A seed credential for one discovery source.
enum SeedCredential {
    /// Literal key from a `[model.*]` entry.
    Literal(String),
    /// Environment variable name holding the key.
    Env(String),
}

impl SeedCredential {
    /// Bearer for the listing request; `None` when a configured env var
    /// is unset (no seed, not a failed fetch).
    fn resolve(&self) -> Option<String> {
        match self {
            Self::Literal(key) => Some(key.clone()),
            Self::Env(name) => std::env::var(name).ok().filter(|v| !v.trim().is_empty()),
        }
    }

    fn origin_tag(&self) -> String {
        match self {
            Self::Literal(_) => "key".to_owned(),
            Self::Env(name) => format!("env:{name}"),
        }
    }
}

struct DiscoverySeed {
    source: DiscoverySource,
    credential: SeedCredential,
}

/// Sources with seeds, in stable merge order.
fn seeded_sources(seeds: &[DiscoverySeed]) -> Vec<DiscoverySource> {
    let mut sources = Vec::new();
    for source in [DiscoverySource::OpenRouter, DiscoverySource::Cursor] {
        if seeds.iter().any(|s| s.source == source) {
            sources.push(source);
        }
    }
    sources
}

fn is_openrouter_url(url: &str) -> bool {
    let host = host_of(url);
    host == "openrouter.ai" || host.ends_with(".openrouter.ai")
}

/// Lowercase host of a URL: scheme stripped, path and port dropped.
fn host_of(url: &str) -> String {
    let rest = url.split_once("://").map(|(_, rest)| rest).unwrap_or(url);
    let authority = rest.split(['/', '?']).next().unwrap_or(rest);
    let host = match authority.rsplit_once(':') {
        Some((host, port)) if !port.is_empty() && port.chars().all(|c| c.is_ascii_digit()) => host,
        _ => authority,
    };
    host.trim().to_ascii_lowercase()
}

/// Scan the config's `[model.*]` entries (plus the environment) for
/// discovery seeds.
fn discovery_seeds(cfg: &config::Config) -> Vec<DiscoverySeed> {
    let mut seeds = Vec::new();

    let mut openrouter_credential: Option<SeedCredential> = None;
    for o in cfg.config_models.values() {
        if openrouter_credential.is_some() {
            break;
        }
        let base = o.base_url.as_deref().or(o.api_base_url.as_deref());
        if !base.is_some_and(is_openrouter_url) {
            continue;
        }
        // A literal `oauth:` reference is a cursor credential; it cannot
        // authenticate the OpenRouter listing.
        let credential = o
            .api_key
            .as_deref()
            .filter(|key| !key.trim().is_empty())
            .filter(|key| crate::auth::provider_oauth::oauth_reference_kind(key).is_none())
            .map(|key| SeedCredential::Literal(key.to_owned()))
            .or_else(|| {
                o.env_key
                    .as_ref()
                    .and_then(config::EnvKeys::primary)
                    .map(|name| SeedCredential::Env(name.to_owned()))
            });
        if let Some(credential) = credential.filter(|c| c.resolve().is_some()) {
            openrouter_credential = Some(credential);
        }
    }
    if openrouter_credential.is_none()
        && let Ok(value) = std::env::var(OPENROUTER_ENV_KEY)
        && !value.trim().is_empty()
    {
        openrouter_credential = Some(SeedCredential::Env(OPENROUTER_ENV_KEY.to_owned()));
    }
    if let Some(credential) = openrouter_credential {
        seeds.push(DiscoverySeed {
            source: DiscoverySource::OpenRouter,
            credential,
        });
    }

    if crate::auth::provider_oauth::has_stored_credentials(
        crate::auth::provider_oauth::ProviderKind::Cursor,
    ) {
        seeds.push(DiscoverySeed {
            source: DiscoverySource::Cursor,
            // The Cursor bearer is resolved (and refreshed) from the
            // store at fetch time.
            credential: SeedCredential::Literal(String::new()),
        });
    }

    seeds
}

// ── Cache ───────────────────────────────────────────────────────────────────

fn source_cache_file(source: DiscoverySource) -> &'static str {
    match source {
        DiscoverySource::OpenRouter => "models_discovery_openrouter.json",
        DiscoverySource::Cursor => "models_discovery_cursor.json",
    }
}

fn source_origin(seed: &DiscoverySeed) -> String {
    match seed.source {
        DiscoverySource::OpenRouter => {
            format!(
                "amore-discovery:openrouter:{}",
                seed.credential.origin_tag()
            )
        }
        DiscoverySource::Cursor => "amore-discovery:cursor".to_owned(),
    }
}

fn source_cache(source: DiscoverySource) -> ModelsCacheManager {
    ModelsCacheManager {
        path: crate::util::grok_home::grok_home().join(source_cache_file(source)),
        ttl: DISCOVERY_TTL,
    }
}

/// Load regardless of TTL — best-effort fallback when a refetch fails.
fn load_stale(cache: &ModelsCacheManager, origin: &str) -> Option<IndexMap<String, ModelEntry>> {
    let data = std::fs::read(&cache.path).ok()?;
    let parsed: ModelsCache = serde_json::from_slice(&data).ok()?;
    (parsed.auth_method.as_ref() == Some(&CacheAuthMethod::ApiKey)
        && parsed.origin.as_deref() == Some(origin))
    .then_some(parsed.models)
}

// ── Merge entry points ──────────────────────────────────────────────────────

/// Append cached discovery entries to `prefetched` (sync, no network).
pub(crate) fn merge_cached(
    cfg: &config::Config,
    prefetched: Option<IndexMap<String, ModelEntry>>,
) -> Option<IndexMap<String, ModelEntry>> {
    let seeds = discovery_seeds(cfg);
    if seeds.is_empty() {
        return prefetched;
    }
    let mut merged = prefetched.unwrap_or_default();
    for source in seeded_sources(&seeds) {
        let Some(seed) = seeds.iter().find(|s| s.source == source) else {
            continue;
        };
        let cache = source_cache(source);
        if let Some(cached) = cache.load_fresh(&CacheAuthMethod::ApiKey, &source_origin(seed)) {
            for (key, entry) in cached.models {
                merged.entry(key).or_insert(entry);
            }
        }
    }
    (!merged.is_empty()).then_some(merged)
}

/// True when a seeded source has no fresh discovery cache (drives the
/// one-shot background refresh trigger).
pub(crate) fn has_stale_seeds(cfg: &config::Config) -> bool {
    let seeds = discovery_seeds(cfg);
    seeded_sources(&seeds).iter().any(|source| {
        let seed = seeds.iter().find(|s| &s.source == source);
        let origin = source_origin(seed.expect("source came from seeds"));
        source_cache(*source)
            .load_fresh(&CacheAuthMethod::ApiKey, &origin)
            .is_none()
    })
}

/// Discovery-only catalog refresh: fetch seeded sources, merge into the
/// live prefetched layer, re-resolve, and push the update. Applies only
/// when the merge produced entries (a failed fetch never wipes the
/// catalog). Generation-fenced so an identity change mid-fetch discards
/// the result.
pub(crate) async fn refresh_discovery_only(mgr: &ModelsManager) {
    let (prefetched, etag, generation) = {
        let cat = mgr.inner.catalog.read();
        (cat.prefetched.clone(), cat.etag.clone(), cat.generation)
    };
    let cfg = mgr.inner.cfg.read().clone();
    let merged = tokio::time::timeout(
        crate::http::STARTUP_FETCH_TIMEOUT,
        tokio::task::spawn_blocking({
            let cfg = cfg.clone();
            move || fetch_and_merge_blocking(&cfg, prefetched)
        }),
    )
    .await;
    let (cfg, merged) = match merged {
        Ok(Ok(Some(merged))) => (cfg, merged),
        Ok(Ok(None)) | Ok(Err(_)) | Err(_) => return,
    };
    if mgr.apply_catalog_fenced(&cfg, merged, etag, Some(generation)) {
        mgr.notify_models_updated();
    }
}

/// Fetch (or use fresh caches for) every seeded source and append the
/// entries to `prefetched`. Blocking; call from a blocking context.
pub(crate) fn fetch_and_merge_blocking(
    cfg: &config::Config,
    prefetched: Option<IndexMap<String, ModelEntry>>,
) -> Option<IndexMap<String, ModelEntry>> {
    let seeds = discovery_seeds(cfg);
    if seeds.is_empty() {
        return prefetched;
    }
    let mut merged = prefetched.unwrap_or_default();
    for source in seeded_sources(&seeds) {
        let Some(seed) = seeds.iter().find(|s| s.source == source) else {
            continue;
        };
        let cache = source_cache(source);
        let origin = source_origin(seed);
        if let Some(cached) = cache.load_fresh(&CacheAuthMethod::ApiKey, &origin) {
            for (key, entry) in cached.models {
                merged.entry(key).or_insert(entry);
            }
            continue;
        }
        match fetch_source_blocking(source, seed) {
            Some(entries) => {
                let map = discovered_map(entries);
                cache.persist(&map, None, CacheAuthMethod::ApiKey, &origin);
                for (key, entry) in map {
                    merged.entry(key).or_insert(entry);
                }
            }
            None => {
                tracing::warn!(
                    source = ?source,
                    "provider model discovery fetch failed; keeping existing catalog"
                );
                if let Some(stale) = load_stale(&cache, &origin) {
                    for (key, entry) in stale {
                        merged.entry(key).or_insert(entry);
                    }
                }
            }
        }
    }
    (!merged.is_empty()).then_some(merged)
}

/// Build the prefetched-style map. Unlike the xAI remote map, discovery
/// entries carry their credential: a discovered model must authenticate
/// with the seed's key, not a session key.
fn discovered_map(entries: Vec<config::ModelEntryConfig>) -> IndexMap<String, ModelEntry> {
    let mut map: IndexMap<String, ModelEntry> = IndexMap::with_capacity(entries.len());
    for m in entries {
        let key = m.id.clone().unwrap_or_else(|| m.model.clone());
        let info = config::ModelInfo::from_config(&m);
        map.insert(
            key,
            ModelEntry {
                info,
                api_key: m.api_key.clone(),
                env_key: m.env_key.clone(),
                auth_provider: None,
                api_base_url: m.api_base_url.clone(),
            },
        );
    }
    map
}

// ── OpenRouter ──────────────────────────────────────────────────────────────

fn fetch_source_blocking(
    source: DiscoverySource,
    seed: &DiscoverySeed,
) -> Option<Vec<config::ModelEntryConfig>> {
    match source {
        DiscoverySource::OpenRouter => fetch_openrouter_blocking(&seed.credential),
        DiscoverySource::Cursor => fetch_cursor_blocking(),
    }
}

fn fetch_openrouter_blocking(credential: &SeedCredential) -> Option<Vec<config::ModelEntryConfig>> {
    let bearer = credential.resolve()?;
    let client = crate::http::shared_startup_blocking_client();
    let response = client
        .get(format!("{OPENROUTER_BASE_URL}/models"))
        .header("Authorization", format!("Bearer {bearer}"))
        .send();
    let response = match response {
        Ok(response) if response.status().is_success() => response,
        Ok(response) => {
            tracing::warn!(status = %response.status(), "OpenRouter model discovery fetch failed");
            return None;
        }
        Err(err) => {
            tracing::warn!(error = %err, "OpenRouter model discovery fetch failed");
            return None;
        }
    };
    let body: serde_json::Value = match response.json() {
        Ok(json) => json,
        Err(err) => {
            tracing::warn!(error = %err, "OpenRouter model discovery decode failed");
            return None;
        }
    };
    let entries = parse_openrouter_models(&body, credential);
    tracing::info!(count = entries.len(), "Discovered OpenRouter models");
    Some(entries)
}

/// Parse the OpenRouter `/api/v1/models` response into catalog entries.
///
/// The OpenRouter `reasoning` capability object bridges to the fork's
/// effort fields: `supported_efforts` → the per-model menu (vocabulary
/// matches `ReasoningEffort` exactly), `default_effort` → the catalog
/// default, presence of the object → `supports_reasoning_effort`.
/// Thinking-off is offered for non-mandatory models (the wire accepts
/// `"none"` even when unadvertised; verified live); a
/// `default_enabled: false` model defaults to off.
fn parse_openrouter_models(
    body: &serde_json::Value,
    credential: &SeedCredential,
) -> Vec<config::ModelEntryConfig> {
    let Some(data) = body.get("data").and_then(serde_json::Value::as_array) else {
        tracing::warn!("OpenRouter model discovery: response missing data array");
        return Vec::new();
    };
    data.iter()
        .filter_map(|value| openrouter_entry(value, credential))
        .collect()
}

fn openrouter_entry(
    value: &serde_json::Value,
    credential: &SeedCredential,
) -> Option<config::ModelEntryConfig> {
    let obj = value.as_object()?;
    let slug = value.get("id").and_then(serde_json::Value::as_str)?.trim();
    if slug.is_empty() {
        return None;
    }
    // Display name drops the OpenRouter "Vendor: " prefix — the vendor is
    // the picker's group header. match_text keeps the full name.
    let raw_name = value
        .get("name")
        .and_then(serde_json::Value::as_str)
        .unwrap_or("");
    let name = match raw_name.split_once(": ") {
        Some((vendor, rest)) if !vendor.trim().is_empty() && !rest.trim().is_empty() => {
            raw_name.replacen(&format!("{vendor}: "), "", 1)
        }
        _ => raw_name.to_owned(),
    };
    let context_window = value
        .get("context_length")
        .and_then(serde_json::Value::as_u64)
        .filter(|cw| *cw > 0)
        .unwrap_or(DISCOVERY_DEFAULT_CONTEXT_WINDOW);
    let max_completion_tokens = value
        .get("top_provider")
        .and_then(|top| top.get("max_completion_tokens"))
        .and_then(serde_json::Value::as_u64)
        .and_then(|v| u32::try_from(v).ok());
    let bridge = reasoning_bridge(obj);
    let (api_key, env_key) = match credential {
        SeedCredential::Literal(key) => (Some(key.clone()), None),
        SeedCredential::Env(name) => (None, Some(config::EnvKeys::single(name.clone()))),
    };
    Some(config::ModelEntryConfig {
        id: Some(slug.to_owned()),
        model: slug.to_owned(),
        model_family: None,
        base_url: OPENROUTER_BASE_URL.to_owned(),
        name: (!name.is_empty()).then_some(name),
        description: value
            .get("description")
            .and_then(serde_json::Value::as_str)
            .map(str::to_owned),
        max_completion_tokens,
        temperature: None,
        top_p: None,
        api_key,
        env_key,
        api_backend: ApiBackend::ChatCompletions,
        auth_scheme: None,
        reasoning_effort: bridge.default_effort,
        supports_reasoning_effort: bridge.supports,
        reasoning_efforts: efforts_menu(bridge.efforts, bridge.default_effort),
        extra_headers: IndexMap::new(),
        context_window: std::num::NonZeroU64::new(context_window)
            .expect("context windows are filtered > 0"),
        auto_compact_threshold_percent: None,
        system_prompt_label: None,
        api_base_url: None,
        use_concise: false,
        agent_type: crate::agent::config::default_agent_type(),
        inference_idle_timeout_secs: None,
        max_retries: None,
        subagent_rate_limit_max_attempts: None,
        hidden: false,
        supported_in_api: true,
        supports_backend_search: false,
        compactions_remaining: None,
        compaction_at_tokens: None,
        show_model_fingerprint: false,
        stream_tool_calls: None,
        laziness_detector: config::LazinessDetectorPerModelConfig::default(),
    })
}

/// Bridged effort metadata from an OpenRouter entry's `reasoning` object
/// (or the `reasoning_effort` supported-parameter signal).
struct ReasoningBridge {
    supports: bool,
    /// Per-model effort menu values, canonical low-to-high order.
    efforts: Vec<ReasoningEffort>,
    default_effort: Option<ReasoningEffort>,
}

fn reasoning_bridge(obj: &serde_json::Map<String, serde_json::Value>) -> ReasoningBridge {
    let Some(reasoning) = obj.get("reasoning").and_then(serde_json::Value::as_object) else {
        // Some reasoners advertise the top-level shorthand without the
        // capability object: supported, but with no per-model menu.
        let supports = obj
            .get("supported_parameters")
            .and_then(serde_json::Value::as_array)
            .is_some_and(|params| {
                params
                    .iter()
                    .any(|v| v.as_str() == Some("reasoning_effort"))
            });
        return ReasoningBridge {
            supports,
            efforts: Vec::new(),
            default_effort: None,
        };
    };
    let mandatory = bool_field(reasoning, "mandatory");
    let default_enabled = bool_field(reasoning, "default_enabled");
    let mut efforts: Vec<ReasoningEffort> = reasoning
        .get("supported_efforts")
        .and_then(serde_json::Value::as_array)
        .map(|arr| {
            arr.iter()
                .filter_map(|v| v.as_str())
                .filter_map(|s| s.parse::<ReasoningEffort>().ok())
                .collect()
        })
        .unwrap_or_default();
    // Thinking-off is reachable for optional-thinking models even when
    // the advertised efforts omit it.
    if !mandatory && !efforts.contains(&ReasoningEffort::None) {
        efforts.push(ReasoningEffort::None);
    }
    efforts.sort_by_key(|effort| effort_rank(*effort));
    efforts.dedup();
    let default_effort = if !default_enabled {
        Some(ReasoningEffort::None)
    } else {
        reasoning
            .get("default_effort")
            .and_then(serde_json::Value::as_str)
            .and_then(|s| s.parse::<ReasoningEffort>().ok())
            .filter(|effort| efforts.contains(effort))
    };
    ReasoningBridge {
        supports: true,
        efforts,
        default_effort,
    }
}

fn bool_field(obj: &serde_json::Map<String, serde_json::Value>, key: &str) -> bool {
    obj.get(key)
        .and_then(serde_json::Value::as_bool)
        .unwrap_or(false)
}

/// Canonical low-to-high effort menu from the bridged values.
fn efforts_menu(
    efforts: Vec<ReasoningEffort>,
    default_effort: Option<ReasoningEffort>,
) -> Vec<ReasoningEffortOption> {
    efforts
        .into_iter()
        .map(|value| ReasoningEffortOption {
            id: value.as_str().to_owned(),
            value,
            label: effort_label(value),
            description: None,
            default: default_effort == Some(value),
        })
        .collect()
}

/// Effort ranking for menu ordering (mirrors the catalog's derive rank).
fn effort_rank(effort: ReasoningEffort) -> u8 {
    match effort {
        ReasoningEffort::None => 0,
        ReasoningEffort::Minimal => 1,
        ReasoningEffort::Low => 2,
        ReasoningEffort::Medium => 3,
        ReasoningEffort::High => 4,
        ReasoningEffort::Xhigh => 5,
        ReasoningEffort::Max => 6,
    }
}

fn effort_label(value: ReasoningEffort) -> String {
    let slug = value.as_str();
    let mut chars = slug.chars();
    match chars.next() {
        Some(first) => first.to_uppercase().collect::<String>() + chars.as_str(),
        None => String::new(),
    }
}

// ── Cursor ──────────────────────────────────────────────────────────────────

fn fetch_cursor_blocking() -> Option<Vec<config::ModelEntryConfig>> {
    let credentials = crate::auth::provider_oauth::blocking_fresh_credentials(
        crate::auth::provider_oauth::ProviderKind::Cursor,
    )
    .map_err(|err| {
        tracing::warn!(error = %err, "Cursor model discovery: no live credential");
        err
    })
    .ok()?;
    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .ok()?;
    let details = match runtime.block_on(async {
        tokio::time::timeout(
            std::time::Duration::from_secs(15),
            xai_grok_cursor::transport::get_usable_models(
                xai_grok_cursor::transport::UnaryConfig {
                    access_token: credentials.access.clone(),
                    base_url: None,
                },
            ),
        )
        .await
    }) {
        Ok(Ok(models)) => models,
        Ok(Err(err)) => {
            tracing::warn!(error = %err, "Cursor model discovery fetch failed");
            return None;
        }
        Err(_) => {
            tracing::warn!("Cursor model discovery fetch timed out");
            return None;
        }
    };
    let entries: Vec<config::ModelEntryConfig> = cursor_entries(&details);
    tracing::info!(count = entries.len(), "Discovered Cursor models");
    Some(entries)
}

/// One OpenAI-family sibling group: per-effort slugs sharing a base id
/// (and optionally the `-fast` lane).
struct CursorSiblingGroup {
    /// Shortest display name in the group (the tier names embed their
    /// effort token; the shortest is closest to the bare model name).
    display_name: Option<String>,
    context_window: u64,
    thinking: bool,
    efforts: Vec<ReasoningEffort>,
}

/// Synthesize catalog entries from `GetUsableModels` details. OpenAI-family
/// per-effort sibling slugs (`gpt-5.4-mini-low`, `-high`, `-high-fast`, …)
/// collapse into one entry per (base, fast lane) with an effort menu — the
/// Run transport splits the slug anyway, and one entry per tier is what
/// makes the picker noisy. Everything else (composer, Claude siblings)
/// stays one-to-one.
fn cursor_entries(
    details: &[xai_grok_cursor::proto::ModelDetails],
) -> Vec<config::ModelEntryConfig> {
    let mut groups: IndexMap<(String, bool), CursorSiblingGroup> = IndexMap::new();
    let mut singles: Vec<&xai_grok_cursor::proto::ModelDetails> = Vec::new();
    for detail in details {
        let id = detail.model_id.trim();
        if id.is_empty() {
            continue;
        }
        match xai_grok_cursor::request::split_effort_sibling(id) {
            Some((base, effort, fast)) => {
                let key = (base.to_owned(), fast);
                let group = groups.entry(key).or_insert(CursorSiblingGroup {
                    display_name: None,
                    context_window: 0,
                    thinking: false,
                    efforts: Vec::new(),
                });
                if let Some(tier) = effort.parse::<ReasoningEffort>().ok()
                    && !group.efforts.contains(&tier)
                {
                    group.efforts.push(tier);
                }
                group.thinking |= detail.thinking_details.is_some();
                group.context_window = group.context_window.max(cursor_context_window(detail, id));
                let name = cursor_display_name(detail, id);
                match &group.display_name {
                    Some(existing) if name.chars().count() >= existing.chars().count() => {}
                    _ => group.display_name = Some(name),
                }
            }
            None => singles.push(detail),
        }
    }

    let mut entries: Vec<config::ModelEntryConfig> =
        Vec::with_capacity(singles.len() + groups.len());
    for ((base, fast), group) in groups {
        let id = if fast {
            format!("{base}-fast")
        } else {
            base
        };
        entries.push(cursor_group_entry(&id, group));
    }
    entries.extend(singles.iter().filter_map(|detail| cursor_entry(detail)));
    entries
}

/// The display name for one detail, falling back through the standard
/// candidates to the id.
fn cursor_display_name(details: &xai_grok_cursor::proto::ModelDetails, id: &str) -> String {
    [
        details.display_name.trim(),
        details.display_name_short.trim(),
        details.display_model_id.trim(),
    ]
    .into_iter()
    .find(|candidate| !candidate.is_empty())
    .or_else(|| {
        details
            .aliases
            .iter()
            .map(String::as_str)
            .map(str::trim)
            .find(|s| !s.is_empty())
    })
    .unwrap_or(id)
    .to_owned()
}

/// A collapsed sibling-group entry: the lane's wire id, the tier-stripped
/// name, and the group's effort menu (default `high` when offered, else
/// the highest tier — the tiers arrived as distinct models, so the fork's
/// menu replaces them).
fn cursor_group_entry(
    id: &str,
    mut group: CursorSiblingGroup,
) -> config::ModelEntryConfig {
    let mut name = group.display_name.unwrap_or_else(|| id.to_owned());
    // Strip a trailing tier token ("GPT-5.4 Mini High" → "GPT-5.4 Mini");
    // the effort now lives in the menu, not the name.
    let tier_words = ["minimal", "low", "medium", "high", "xhigh", "max", "fast"];
    let trimmed = name.trim_end();
    if let Some((head, last)) = trimmed.rsplit_once(' ')
        && tier_words.contains(&last.to_ascii_lowercase().as_str())
        && !head.trim().is_empty()
    {
        name = head.trim_end().to_owned();
    }

    group.efforts.sort_by_key(|effort| effort_rank(*effort));
    let default_effort = if group.efforts.contains(&ReasoningEffort::High) {
        Some(ReasoningEffort::High)
    } else {
        group.efforts.last().copied()
    };
    let menu = efforts_menu(group.efforts, default_effort);

    let mut entry = cursor_entry(&xai_grok_cursor::proto::ModelDetails {
        model_id: id.to_owned(),
        display_name: name,
        thinking_details: group
            .thinking
            .then_some(xai_grok_cursor::proto::ThinkingDetails {}),
        ..Default::default()
    })
    .expect("collapsed group entry has a non-empty id");
    entry.supports_reasoning_effort = true;
    entry.reasoning_efforts = menu;
    entry.reasoning_effort = default_effort;
    if group.context_window > 0 {
        entry.context_window = std::num::NonZeroU64::new(group.context_window)
            .expect("context windows are filtered > 0");
    }
    entry
}

/// Synthesize a catalog entry from one `ModelDetails`. Sibling effort
/// slugs stay verbatim (the Run transport normalizes OpenAI-family
/// suffixes); the effort lever is only offered when the endpoint's own
/// `thinkingDetails` signal fires, so guessed parameters never re-trigger
/// the sibling-slug rejection.
fn cursor_entry(
    details: &xai_grok_cursor::proto::ModelDetails,
) -> Option<config::ModelEntryConfig> {
    let id = details.model_id.trim();
    if id.is_empty() {
        return None;
    }
    let display_name = [
        details.display_name.trim(),
        details.display_name_short.trim(),
        details.display_model_id.trim(),
    ]
    .into_iter()
    .find(|candidate| !candidate.is_empty())
    .or_else(|| {
        details
            .aliases
            .iter()
            .map(String::as_str)
            .map(str::trim)
            .find(|s| !s.is_empty())
    })
    .unwrap_or(id);
    Some(config::ModelEntryConfig {
        id: Some(id.to_owned()),
        model: id.to_owned(),
        model_family: None,
        base_url: xai_grok_cursor::transport::CURSOR_API_URL.to_owned(),
        name: Some(display_name.to_owned()),
        description: None,
        max_completion_tokens: Some(CURSOR_DEFAULT_MAX_COMPLETION_TOKENS),
        temperature: None,
        top_p: None,
        api_key: Some(CURSOR_OAUTH_KEY_REF.to_owned()),
        env_key: None,
        api_backend: ApiBackend::Cursor,
        auth_scheme: None,
        reasoning_effort: None,
        supports_reasoning_effort: details.thinking_details.is_some(),
        reasoning_efforts: Vec::new(),
        extra_headers: IndexMap::new(),
        context_window: std::num::NonZeroU64::new(cursor_context_window(details, id))
            .expect("context window constant > 0"),
        auto_compact_threshold_percent: None,
        system_prompt_label: None,
        api_base_url: None,
        use_concise: false,
        agent_type: crate::agent::config::default_agent_type(),
        inference_idle_timeout_secs: None,
        max_retries: None,
        subagent_rate_limit_max_attempts: None,
        hidden: false,
        supported_in_api: true,
        supports_backend_search: false,
        compactions_remaining: None,
        compaction_at_tokens: None,
        show_model_fingerprint: false,
        stream_tool_calls: None,
        laziness_detector: config::LazinessDetectorPerModelConfig::default(),
    })
}

/// Context window for a discovered Cursor model: the 1M ceiling when any
/// 1M signal fires (display-name labels, the max-mode flag on
/// Claude/Gemini ids, or the bare Kimi K3 family), else the fallback.
fn cursor_context_window(details: &xai_grok_cursor::proto::ModelDetails, id: &str) -> u64 {
    let labeled_1m = is_cursor_1m(id)
        || [
            details.display_name.as_str(),
            details.display_name_short.as_str(),
            details.display_model_id.as_str(),
        ]
        .into_iter()
        .chain(details.aliases.iter().map(String::as_str))
        .any(is_cursor_1m)
        || (details.max_mode.unwrap_or(false)
            && (id.to_ascii_lowercase().contains("claude")
                || id.to_ascii_lowercase().contains("gemini")))
        || id
            .rsplit('/')
            .next()
            .is_some_and(|last| last.eq_ignore_ascii_case("k3"));
    if labeled_1m {
        CURSOR_1M_CONTEXT_WINDOW
    } else {
        DISCOVERY_DEFAULT_CONTEXT_WINDOW
    }
}

/// Display-name label marking Cursor's 1M-context variants ("Opus 5 1M",
/// "GPT-5.5 1M High").
fn is_cursor_1m(candidate: &str) -> bool {
    candidate.to_ascii_lowercase().contains("1m")
}

// ── Picker grouping metadata ────────────────────────────────────────────────

/// The picker's provider group label for a catalog entry (the ACP
/// `provider` meta key). `None` buckets as "Other" only when a catalog
/// mixes providers; a single-group catalog renders flat.
pub(crate) fn provider_group_label(info: &config::ModelInfo) -> Option<&'static str> {
    if matches!(info.api_backend, ApiBackend::Cursor) {
        return Some("Cursor");
    }
    let host = host_of(&info.base_url);
    if is_openrouter_url(&host) {
        Some("OpenRouter")
    } else if host == "anthropic.com" || host.ends_with(".anthropic.com") {
        Some("Anthropic")
    } else if host == "openai.com" || host.ends_with(".openai.com") {
        Some("OpenAI")
    } else if host == "x.ai" || host.ends_with(".x.ai") || host.ends_with("xai.com") {
        Some("xAI")
    } else {
        None
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use xai_grok_sampling_types::ReasoningEffort;

    #[test]
    fn openrouter_reasoning_object_bridges_to_the_effort_fields() {
        let credential = SeedCredential::Literal("k".to_owned());
        let entry = openrouter_entry(
            &serde_json::json!({
                "id": "deepseek/deepseek-v4-flash-0731",
                "name": "DeepSeek: DeepSeek V4 Flash",
                "context_length": 65_536,
                "top_provider": { "max_completion_tokens": 32_000 },
                "reasoning": {
                    "mandatory": false,
                    "default_enabled": true,
                    "supported_efforts": ["max", "high", "low"],
                    "default_effort": "high"
                }
            }),
            &credential,
        )
        .expect("entry synthesizes");

        assert_eq!(entry.model, "deepseek/deepseek-v4-flash-0731");
        assert_eq!(entry.name.as_deref(), Some("DeepSeek V4 Flash"));
        assert_eq!(entry.context_window.get(), 65_536);
        assert_eq!(entry.max_completion_tokens, Some(32_000));
        assert_eq!(entry.api_backend, ApiBackend::ChatCompletions);
        assert_eq!(entry.base_url, OPENROUTER_BASE_URL);
        assert_eq!(entry.api_key.as_deref(), Some("k"));
        assert!(entry.supported_in_api);
        assert!(entry.supports_reasoning_effort);

        // Menu is canonical low-to-high plus the off option, with the
        // advertised default marked.
        let values: Vec<ReasoningEffort> =
            entry.reasoning_efforts.iter().map(|o| o.value).collect();
        assert_eq!(
            values,
            vec![
                ReasoningEffort::None,
                ReasoningEffort::Low,
                ReasoningEffort::High,
                ReasoningEffort::Max
            ]
        );
        assert_eq!(entry.reasoning_effort, Some(ReasoningEffort::High));
    }

    #[test]
    fn openrouter_optional_thinking_reaches_off_and_defaults_to_it_when_disabled() {
        let credential = SeedCredential::Literal("k".to_owned());
        let entry = openrouter_entry(
            &serde_json::json!({
                "id": "vendor/model",
                "reasoning": {
                    "mandatory": false,
                    "default_enabled": false,
                    "supported_efforts": ["low", "high"]
                }
            }),
            &credential,
        )
        .expect("entry");
        let values: Vec<ReasoningEffort> =
            entry.reasoning_efforts.iter().map(|o| o.value).collect();
        assert!(values.contains(&ReasoningEffort::None), "off is offered");
        assert_eq!(entry.reasoning_effort, Some(ReasoningEffort::None));

        // Mandatory models never offer off.
        let mandatory = openrouter_entry(
            &serde_json::json!({
                "id": "vendor/always-thinks",
                "reasoning": {
                    "mandatory": true,
                    "supported_efforts": ["medium"],
                    "default_effort": "medium"
                }
            }),
            &credential,
        )
        .expect("entry");
        let values: Vec<ReasoningEffort> = mandatory
            .reasoning_efforts
            .iter()
            .map(|o| o.value)
            .collect();
        assert!(!values.contains(&ReasoningEffort::None));
    }

    #[test]
    fn non_reasoners_get_no_effort_surface() {
        let credential = SeedCredential::Literal("k".to_owned());
        let entry = openrouter_entry(
            &serde_json::json!({
                "id": "tencent/hy-mt2-1.8b",
                "context_length": 4096
            }),
            &credential,
        )
        .expect("entry");
        assert!(!entry.supports_reasoning_effort);
        assert!(entry.reasoning_efforts.is_empty());
        assert_eq!(entry.reasoning_effort, None);
    }

    #[test]
    fn cursor_entry_synthesizes_from_model_details() {
        let details = xai_grok_cursor::proto::ModelDetails {
            model_id: "composer-2.5".to_owned(),
            display_name: "Composer 2.5".to_owned(),
            ..Default::default()
        };
        let entry = cursor_entry(&details).expect("entry");
        assert_eq!(entry.model, "composer-2.5");
        assert_eq!(entry.name.as_deref(), Some("Composer 2.5"));
        assert_eq!(entry.api_backend, ApiBackend::Cursor);
        assert_eq!(entry.base_url, xai_grok_cursor::transport::CURSOR_API_URL);
        assert_eq!(entry.api_key.as_deref(), Some(CURSOR_OAUTH_KEY_REF));
        assert_eq!(entry.context_window.get(), DISCOVERY_DEFAULT_CONTEXT_WINDOW);
        assert!(!entry.supports_reasoning_effort);
    }

    #[test]
    fn cursor_one_m_signals_lift_the_context_ceiling() {
        let mut details = xai_grok_cursor::proto::ModelDetails {
            model_id: "claude-opus-4.6".to_owned(),
            max_mode: Some(true),
            ..Default::default()
        };
        assert_eq!(
            cursor_context_window(&details, "claude-opus-4.6"),
            CURSOR_1M_CONTEXT_WINDOW
        );
        details.model_id = "gpt-5.5".to_owned();
        details.max_mode = None;
        details.display_name = "GPT-5.5 1M High".to_owned();
        assert_eq!(
            cursor_context_window(&details, "gpt-5.5"),
            CURSOR_1M_CONTEXT_WINDOW
        );
        details.display_name = String::new();
        assert_eq!(
            cursor_context_window(&details, "composer-2.5"),
            DISCOVERY_DEFAULT_CONTEXT_WINDOW
        );
    }

    #[test]
    fn provider_group_labels_route_by_route_not_model() {
        let mut info = config::ModelInfo::fallback("x");
        info.base_url = "https://api.x.ai/v1".to_owned();
        assert_eq!(provider_group_label(&info), Some("xAI"));

        info.base_url = OPENROUTER_BASE_URL.to_owned();
        assert_eq!(provider_group_label(&info), Some("OpenRouter"));

        info.base_url = "https://api.anthropic.com".to_owned();
        assert_eq!(provider_group_label(&info), Some("Anthropic"));

        info.api_backend = ApiBackend::Cursor;
        info.base_url = xai_grok_cursor::transport::CURSOR_API_URL.to_owned();
        assert_eq!(provider_group_label(&info), Some("Cursor"));
    }

    #[test]
    fn host_of_strips_scheme_path_and_port() {
        assert_eq!(host_of("https://openrouter.ai/api/v1"), "openrouter.ai");
        assert_eq!(host_of("http://localhost:9000/x"), "localhost");
        assert_eq!(host_of("https://bridge.internal"), "bridge.internal");
    }
}
