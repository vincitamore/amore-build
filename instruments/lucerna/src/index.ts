/**
 * @amore/lucerna  -  house steward daemon public surface.
 */

export {
  VERSION,
  PROCESS_NAME,
  loadConfig,
  packageVersion,
  formatVersionLine,
  DEFAULT_AUTO_COMMIT_COOLDOWN_MS,
  type LucernaConfig,
} from "./config.ts";
export {
  PROTECTED_PATTERNS,
  WRITABLE_PATTERNS,
  canWrite,
  isProtectedPath,
  assertWritable,
  writeGuarded,
  Governance,
  mergeGovernanceLists,
  parseGovernanceUserToml,
} from "./governance.ts";
export {
  DAILY_ACTION_BUDGET,
  WEEKLY_EXPENSIVE_BUDGET,
  CYCLE_COOLDOWN_MS,
  DEFAULT_DAILY_TOKEN_CEILING,
  canRunAction,
  canStartCycle,
  recordAction,
  recordTokenUsage,
  budgetSnapshot,
  formatBudgetForPlanner,
  type BudgetCounters,
  type TokenUsage,
} from "./budget.ts";
export {
  parseEnablementJson,
  readEnablementFile,
  DEFAULT_ENABLEMENT,
  type LucernaEnablement,
} from "./enablement.ts";
export {
  callAmoreHeadless,
  buildAmoreHeadlessArgv,
  parseJsonEnvelope,
  resolveAmoreBin,
  runAmoreProcess,
  killProcessTree,
  type AmoreHeadlessResult,
  type AmoreJsonEnvelope,
} from "./engine/amore-headless.ts";
export {
  ACTION_CATALOG,
  ADMITTED_ACTION_KEYS,
  AGENTIC_ACTION_KEYS,
  LIGHT_ACTION_KEYS,
  executeLightAction,
  runSurveyOrg,
  runSubstrateHealth,
  runInboxAgeReport,
  runStateCleanup,
  runEdgesUpdate,
  runEdgesDensify,
  runQmdRefresh,
} from "./actions.ts";
export {
  AutoCommitter,
  dryRunAgainstFixture,
  hashChangeSet,
  getPorcelainRaw,
} from "./auto-commit.ts";
export { DaemonLoop, consumeSentinel, runLifecycleSmoke } from "./daemon.ts";
export { StateManager, type DreamCycleOutcome } from "./state.ts";
export { Heartbeat } from "./heartbeat.ts";
export { houseRuntimeDir, userConfigDir, RUNTIME_FILES } from "./paths.ts";
export {
  runDreamCycle,
  parseDreamPick,
  gatherHouseSnapshot,
  DREAM_PICK_SCHEMA,
  DREAM_PICK_ACTIONS,
  buildPlannerSystemPrompt,
  buildPlannerUserPrompt,
  lightDreamRelPath,
  type DreamPick,
  type DreamCycleResult,
} from "./somniator.ts";
export {
  appendNotification,
  readNotifications,
  rotateNotificationsIfNeeded,
  notificationsPath,
  type LucernaNotification,
} from "./notifications.ts";
export {
  runAgenticAction,
  writeDreamManifest,
  parseProposals,
  materializeProposals,
  checkGovernanceBreaches,
  inventoryHousePaths,
  MAINTENANCE_DISALLOWED_TOOLS,
  DEFAULT_AGENTIC_WALL_MS,
  FULL_AGENTIC_KEYS,
  isFullAgenticKey,
  buildManifestFrontmatter,
  buildProposalFrontmatter,
  dreamManifestRelPath,
  type GovernanceBreach,
} from "./agentic.ts";
