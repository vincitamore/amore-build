/**
 * Session title generation through a scrubbed digest and the local amore binary.
 */

export {
  DIGEST_CAP_BYTES,
  buildDigestFromEvents,
  buildSessionDigest,
  loadSessionEvents,
  digestHash,
  type DigestEvent,
  type SessionDigest,
} from "./digest";

export {
  renderSummarizePrompt,
  renderSummarizePromptFromDigest,
  TITLE_MAX_CHARS,
} from "./prompt";

export { parseTitleReply, type ParsedTitle, type ParseResult } from "./parse";

export {
  applyGeneratedTitle,
  getGeneratedTitle,
  type ApplyTitleInput,
  type AppliedTitle,
} from "./apply";

export {
  selectSessionsForSummarize,
  estimateTokens,
  DEFAULT_SUMMARIZE_LIMIT,
  type SelectOptions,
  type SelectedSession,
} from "./select";

export {
  runSummarize,
  toJsonReport,
  SUMMARIZE_MAX_TURNS,
  type SummarizeOutcome,
  type SummarizeSessionResult,
  type SummarizeRunOptions,
  type SummarizeRunReport,
} from "./run";
