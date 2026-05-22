export type AiMode = "blocking" | "advisory" | "off";

export interface ReviewConfig {
  target_branch: string;
  context_lines: number;
  max_lines_for_full_file: number;
}

export interface ToolConfig {
  name: string;
  command: string[];
  extensions?: string[];
}

export type ProviderConfig = Record<string, unknown>;

export interface AiConfig {
  mode: AiMode;
  provider?: string;
  providers: Record<string, ProviderConfig>;
}

export interface PushgateConfig {
  version: 2;
  review: ReviewConfig;
  tools: ToolConfig[];
  ai: AiConfig;
  ignore_paths: string[];
}

export interface LoadedConfig {
  config: PushgateConfig;
  path: string;
  warnings: string[];
}

export interface RawReviewConfig {
  target_branch?: string;
  context_lines?: number;
  max_lines_for_full_file?: number;
}

export interface RawToolConfig {
  name: string;
  command: string[];
  extensions?: string[];
}

export interface RawAiConfig {
  mode?: AiMode;
  provider?: string;
  providers?: Record<string, ProviderConfig>;
}

export interface RawPushgateConfig {
  version: 2;
  review?: RawReviewConfig;
  tools?: RawToolConfig[];
  ai?: RawAiConfig;
  ignore_paths?: string[];
}
