import { access, readFile } from "node:fs/promises";
import { constants, readFileSync } from "node:fs";
import { join } from "node:path";

import { Ajv, type ErrorObject, type ValidateFunction } from "ajv";
import { parseDocument } from "yaml";

import type {
  LoadedConfig,
  PushgateConfig,
  RawPushgateConfig,
} from "./types.js";

export type {
  AiConfig,
  AiMode,
  LoadedConfig,
  ProviderConfig,
  PushgateConfig,
  ReviewConfig,
  ToolConfig,
} from "./types.js";

export const CONFIG_FILENAME = ".pushgate.yml" as const;
export const LEGACY_CONFIG_FILENAME = ".push-review.yml" as const;

const schema: object = JSON.parse(
  readFileSync(
    new URL("../../schemas/pushgate-config-v2.schema.json", import.meta.url),
    "utf8",
  ),
);
const ajv = new Ajv({ allErrors: true, strict: true });
const validateSchema: ValidateFunction<RawPushgateConfig> =
  ajv.compile<RawPushgateConfig>(schema);

export class ConfigError extends Error {
  readonly code: string;
  readonly diagnostics: string[];

  constructor(message: string, code: string, diagnostics: string[] = []) {
    super(message);
    this.name = new.target.name;
    this.code = code;
    this.diagnostics = diagnostics;
  }
}

export class ConfigValidationError extends ConfigError {
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

export class MissingConfigError extends ConfigError {
  readonly configPath: string;

  constructor(configPath: string) {
    super(
      `No ${CONFIG_FILENAME} found at ${configPath}. Add a v2 Pushgate config before running Pushgate.`,
      "PUSHGATE_CONFIG_MISSING",
    );
    this.configPath = configPath;
  }
}

export class LegacyConfigError extends ConfigError {
  readonly legacyPath: string;
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

/** Parse, validate, and normalize a v2 Pushgate YAML config. */
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
 * Load the repository v2 config and surface legacy-file warnings separately
 * from the normalized config value.
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
    })),
    ai: {
      mode: ai.mode ?? "blocking",
      ...(ai.provider ? { provider: ai.provider } : {}),
      providers: cloneValue(ai.providers ?? {}),
    },
    ignore_paths: [...(rawConfig.ignore_paths ?? [])],
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
