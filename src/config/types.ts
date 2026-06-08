/** Local AI policy modes accepted by the v2 config boundary. */
export type AiMode = "blocking" | "advisory" | "off";

/** Local deterministic command failure behavior. */
export type ToolMode = "blocking" | "warning";

/** Determines whether a tool is scoped to live changed files or always runs. */
export type ToolRunMode = "changed_files" | "always";

/** Normalized diff-context settings consumed after v2 config validation. */
export interface ReviewConfig {
  /** Local or remote-tracking branch name used as the review base. */
  target_branch: string;
  /** Surrounding diff lines included when review context is prepared. */
  context_lines: number;
  /** Diff-size cutoff below which later layers may include full file context. */
  max_lines_for_full_file: number;
}

/** Validated deterministic command config for the future runner. */
export interface ToolConfig {
  /** Human-readable command label used in local output. */
  name: string;
  /** Argv tokens; `{changed_files}` remains a runner expansion token. */
  command: string[];
  /** File extensions that scope changed-file execution when provided. */
  extensions?: string[];
  /** Maximum command runtime before Pushgate treats the tool as timed out. */
  timeout_seconds: number;
  /** Whether command failure blocks the push or only warns locally. */
  mode: ToolMode;
  /** Whether to require scoped live changed files before running. */
  run: ToolRunMode;
  /** Whether a blocking failure stops later deterministic checks. */
  fail_fast: boolean;
}

/** Built-in deterministic policy failure behavior. */
export type BuiltInPolicyMode = ToolMode;

/** Built-in diff-size policy configuration. */
export interface DiffSizePolicyConfig {
  /** Maximum total added plus deleted text lines allowed in the changed diff. */
  max_changed_lines: number;
  /** Whether a policy violation blocks the push or only warns locally. */
  mode: BuiltInPolicyMode;
}

/** Built-in forbidden-path policy configuration. */
export interface ForbiddenPathsPolicyConfig {
  /** Gitignore-like repo-relative path patterns that must not be pushed. */
  patterns: string[];
  /** Whether a policy violation blocks the push or only warns locally. */
  mode: BuiltInPolicyMode;
}

/** Optional built-in deterministic policies. */
export interface BuiltInPoliciesConfig {
  diff_size?: DiffSizePolicyConfig;
  forbidden_paths?: ForbiddenPathsPolicyConfig;
}

/** Provider-specific config extension block preserved for provider adapters. */
export type ProviderConfig = Record<string, unknown>;

/** Normalized local AI selection and provider settings. */
export interface AiConfig {
  /** Local AI behavior after config defaults are applied. */
  mode: AiMode;
  /** Maximum changed text lines the local AI phase may review. */
  max_changed_lines: number;
  /** Approximate rendered prompt token budget before local AI is skipped. */
  max_prompt_tokens: number;
  /** Maximum provider runtime before Pushgate treats local AI as timed out. */
  timeout_seconds: number;
  /** Provider selected for active AI modes. */
  provider?: string;
  /** Provider-specific settings keyed by provider identifier. */
  providers: Record<string, ProviderConfig>;
}

/** Fully validated and defaulted v2 config returned to Pushgate consumers. */
export interface PushgateConfig {
  /** Supported config schema version. */
  version: 2;
  review: ReviewConfig;
  tools: ToolConfig[];
  policies: BuiltInPoliciesConfig;
  ai: AiConfig;
  ignore_paths: string[];
}

/** Parsed config plus repository file metadata exposed by `loadConfig`. */
export interface LoadedConfig {
  config: PushgateConfig;
  /** Absolute path to the loaded `.pushgate.yml` file. */
  path: string;
  /** Non-fatal migration or compatibility messages for callers to surface. */
  warnings: string[];
}

/** Raw review shape before optional v2 defaults are normalized. */
export interface RawReviewConfig {
  target_branch?: string;
  context_lines?: number;
  max_lines_for_full_file?: number;
}

/** Raw deterministic command shape accepted after schema validation. */
export interface RawToolConfig {
  name: string;
  command: string[];
  extensions?: string[];
  timeout_seconds?: number;
  mode?: ToolMode;
  run?: ToolRunMode;
  fail_fast?: boolean;
}

/** Raw built-in diff-size policy shape before defaults are normalized. */
export interface RawDiffSizePolicyConfig {
  max_changed_lines: number;
  mode?: BuiltInPolicyMode;
}

/** Raw built-in forbidden-path policy shape before defaults are normalized. */
export interface RawForbiddenPathsPolicyConfig {
  patterns: string[];
  mode?: BuiltInPolicyMode;
}

/** Raw built-in policy config before optional policy modes are normalized. */
export interface RawBuiltInPoliciesConfig {
  diff_size?: RawDiffSizePolicyConfig;
  forbidden_paths?: RawForbiddenPathsPolicyConfig;
}

/** Raw AI shape before default mode and provider diagnostics are applied. */
export interface RawAiConfig {
  mode?: AiMode;
  max_changed_lines?: number;
  max_prompt_tokens?: number;
  timeout_seconds?: number;
  provider?: string;
  providers?: Record<string, ProviderConfig>;
}

/**
 * Schema-validated v2 YAML shape before optional sections are normalized.
 *
 * AJV establishes this shape after parsing so normalization can fill stable
 * defaults before later hook, runner, and AI layers read the config.
 */
export interface RawPushgateConfig {
  version: 2;
  review?: RawReviewConfig;
  tools?: RawToolConfig[];
  policies?: RawBuiltInPoliciesConfig;
  ai?: RawAiConfig;
  ignore_paths?: string[];
}
