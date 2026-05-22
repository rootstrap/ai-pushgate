/** Local AI policy modes accepted by the v2 config boundary. */
export type AiMode = "blocking" | "advisory" | "off";

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
}

/** Provider-specific config extension block preserved for provider adapters. */
export type ProviderConfig = Record<string, unknown>;

/** Normalized local AI selection and provider settings. */
export interface AiConfig {
  /** Local AI behavior after config defaults are applied. */
  mode: AiMode;
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
}

/** Raw AI shape before default mode and provider diagnostics are applied. */
export interface RawAiConfig {
  mode?: AiMode;
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
  ai?: RawAiConfig;
  ignore_paths?: string[];
}
