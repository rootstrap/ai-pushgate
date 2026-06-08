import { access, readFile } from "node:fs/promises";
import { constants } from "node:fs";
import { join } from "node:path";

import { Ajv, type ErrorObject, type ValidateFunction } from "ajv";
import { parseDocument } from "yaml";
import schema from "../../schemas/pushgate-config-v2.schema.json" with { type: "json" };

import type {
  LoadedConfig,
  PushgateConfig,
  RawPushgateConfig,
} from "./types.js";

export type {
  AiConfig,
  AiMode,
  BuiltInPoliciesConfig,
  BuiltInPolicyMode,
  DiffSizePolicyConfig,
  ForbiddenPathsPolicyConfig,
  LoadedConfig,
  ProviderConfig,
  PushgateConfig,
  ReviewConfig,
  ToolConfig,
  ToolMode,
  ToolRunMode,
} from "./types.js";

export const CONFIG_FILENAME = ".pushgate.yml" as const;
export const LEGACY_CONFIG_FILENAME = ".push-review.yml" as const;

const ajv = new Ajv({ allErrors: true, strict: true });
const validateSchema: ValidateFunction<RawPushgateConfig> =
  ajv.compile<RawPushgateConfig>(schema);

/** Base error shape thrown by the v2 config loader boundary. */
export class ConfigError extends Error {
  /** Stable machine-readable error code for caller-specific rendering. */
  readonly code: string;
  /** Human-readable validation details when the error has diagnostics. */
  readonly diagnostics: string[];

  constructor(message: string, code: string, diagnostics: string[] = []) {
    super(message);
    this.name = new.target.name;
    this.code = code;
    this.diagnostics = diagnostics;
  }
}

/** Raised when v2 YAML parses incorrectly or violates config validation. */
export class ConfigValidationError extends ConfigError {
  /** Path used to identify the YAML source in diagnostics. */
  readonly sourcePath: string;

  constructor(sourcePath: string, diagnostics: string[]) {
    super(
      `Invalid Pushgate v2 config at ${sourcePath}:\n${diagnostics
        .map((diagnostic) => `- ${diagnostic}`)
        .join("\n")}`,
      "PUSHGATE_CONFIG_INVALID",
      diagnostics,
    );
    this.sourcePath = sourcePath;
  }
}

/** Raised when a repository has no v2 or legacy Pushgate config file. */
export class MissingConfigError extends ConfigError {
  /** Expected `.pushgate.yml` path checked by the loader. */
  readonly configPath: string;

  constructor(configPath: string) {
    super(
      `No ${CONFIG_FILENAME} found at ${configPath}. Add a v2 Pushgate config before running Pushgate.`,
      "PUSHGATE_CONFIG_MISSING",
    );
    this.configPath = configPath;
  }
}

/**
 * Raised when only the legacy config exists.
 *
 * The loader does not parse `.push-review.yml` as v2 config; callers should
 * surface this as migration guidance instead of silently adapting the file.
 */
export class LegacyConfigError extends ConfigError {
  /** Legacy `.push-review.yml` path found by the loader. */
  readonly legacyPath: string;
  /** Expected v2 `.pushgate.yml` path for migration output. */
  readonly configPath: string;

  constructor(legacyPath: string, configPath: string) {
    super(
      `Found legacy ${LEGACY_CONFIG_FILENAME} at ${legacyPath}, but no ${CONFIG_FILENAME} at ${configPath}. Migrate it to the v2 ${CONFIG_FILENAME} schema; legacy config is not parsed as v2.`,
      "PUSHGATE_CONFIG_LEGACY_ONLY",
    );
    this.legacyPath = legacyPath;
    this.configPath = configPath;
  }
}

/**
 * Parse, validate, and normalize a v2 Pushgate YAML config string.
 *
 * YAML syntax errors, schema errors, and active-AI provider selection errors
 * are reported as `ConfigValidationError` before callers receive a normalized
 * config object.
 */
export function parseConfigYaml(
  source: string,
  sourcePath: string = CONFIG_FILENAME,
): PushgateConfig {
  const document = parseDocument(source, { prettyErrors: true });

  if (document.errors.length > 0) {
    throw new ConfigValidationError(
      sourcePath,
      document.errors.map((error) => `YAML parse error: ${error.message}`),
    );
  }

  const rawConfig: unknown = document.toJS();

  if (!validateSchema(rawConfig)) {
    throw new ConfigValidationError(
      sourcePath,
      (validateSchema.errors ?? []).map(formatSchemaError),
    );
  }

  const config = normalizeConfig(rawConfig);
  const providerDiagnostics = validateProviderSelection(config);

  if (providerDiagnostics.length > 0) {
    throw new ConfigValidationError(sourcePath, providerDiagnostics);
  }

  return config;
}

/**
 * Load the repository v2 config from disk.
 *
 * A present `.pushgate.yml` is parsed and returned with migration warnings for
 * an accompanying legacy file. Legacy-only and missing-config repositories
 * fail with dedicated errors so callers can choose actionable output.
 */
export async function loadConfig(
  repoRoot: string = process.cwd(),
): Promise<LoadedConfig> {
  const configPath = join(repoRoot, CONFIG_FILENAME);
  const legacyPath = join(repoRoot, LEGACY_CONFIG_FILENAME);
  const [hasConfig, hasLegacyConfig] = await Promise.all([
    exists(configPath),
    exists(legacyPath),
  ]);

  if (!hasConfig) {
    if (hasLegacyConfig) {
      throw new LegacyConfigError(legacyPath, configPath);
    }

    throw new MissingConfigError(configPath);
  }

  const warnings = [];

  if (hasLegacyConfig) {
    warnings.push(
      `Ignoring legacy ${LEGACY_CONFIG_FILENAME} because ${CONFIG_FILENAME} is present. Migrate or remove the legacy config.`,
    );
  }

  return {
    config: parseConfigYaml(await readFile(configPath, "utf8"), configPath),
    path: configPath,
    warnings,
  };
}

function normalizeConfig(rawConfig: RawPushgateConfig): PushgateConfig {
  const ai = rawConfig.ai ?? {};

  return {
    version: 2,
    review: {
      target_branch: rawConfig.review?.target_branch ?? "main",
      context_lines: rawConfig.review?.context_lines ?? 10,
      max_lines_for_full_file:
        rawConfig.review?.max_lines_for_full_file ?? 300,
    },
    tools: (rawConfig.tools ?? []).map((tool) => ({
      name: tool.name,
      command: [...tool.command],
      ...(tool.extensions ? { extensions: [...tool.extensions] } : {}),
      timeout_seconds: tool.timeout_seconds ?? 60,
      mode: tool.mode ?? "blocking",
      run: tool.run ?? "changed_files",
      fail_fast: tool.fail_fast ?? true,
    })),
    policies: normalizePolicies(rawConfig),
    ai: {
      mode: ai.mode ?? "blocking",
      max_changed_lines: ai.max_changed_lines ?? 500,
      max_prompt_tokens: ai.max_prompt_tokens ?? 12_000,
      timeout_seconds: ai.timeout_seconds ?? 120,
      ...(ai.provider ? { provider: ai.provider } : {}),
      providers: cloneValue(ai.providers ?? {}),
    },
    ignore_paths: [...(rawConfig.ignore_paths ?? [])],
  };
}

function normalizePolicies(
  rawConfig: RawPushgateConfig,
): PushgateConfig["policies"] {
  const policies = rawConfig.policies ?? {};

  return {
    ...(policies.diff_size
      ? {
          diff_size: {
            max_changed_lines: policies.diff_size.max_changed_lines,
            mode: policies.diff_size.mode ?? "blocking",
          },
        }
      : {}),
    ...(policies.forbidden_paths
      ? {
          forbidden_paths: {
            patterns: [...policies.forbidden_paths.patterns],
            mode: policies.forbidden_paths.mode ?? "blocking",
          },
        }
      : {}),
  };
}

function validateProviderSelection(config: PushgateConfig): string[] {
  if (config.ai.mode === "off") {
    return [];
  }

  if (!config.ai.provider) {
    return [
      `.ai.provider is required when .ai.mode is "${config.ai.mode}". Select a provider and add its .ai.providers block.`,
    ];
  }

  if (!Object.hasOwn(config.ai.providers, config.ai.provider)) {
    return [
      `.ai.providers.${config.ai.provider} must be defined when .ai.provider selects "${config.ai.provider}".`,
    ];
  }

  return [];
}

function formatSchemaError(error: ErrorObject): string {
  const path = error.instancePath || ".";

  if (error.keyword === "required") {
    return `${path} is missing required key "${error.params.missingProperty}".`;
  }

  if (error.keyword === "additionalProperties") {
    return `${path} contains unknown key "${error.params.additionalProperty}".`;
  }

  if (error.keyword === "const") {
    return `${path} must equal ${JSON.stringify(error.params.allowedValue)}.`;
  }

  return `${path} ${error.message}.`;
}

function cloneValue<T>(value: T): T {
  if (Array.isArray(value)) {
    return value.map(cloneValue) as T;
  }

  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, child]) => [key, cloneValue(child)]),
    ) as T;
  }

  return value;
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}
