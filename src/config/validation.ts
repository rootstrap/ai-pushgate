import { Ajv, type ErrorObject, type ValidateFunction } from "ajv";
import { parseDocument } from "yaml";
import schema from "../../schemas/pushgate-config-v2.schema.json" with { type: "json" };

import { CONFIG_FILENAME } from "./constants.js";
import { ConfigValidationError } from "./errors.js";
import { normalizeConfig } from "./normalize.js";
import type { PushgateConfig, RawPushgateConfig } from "./types.js";

const ajv = new Ajv({ allErrors: true, strict: true });
const validateSchema: ValidateFunction<RawPushgateConfig> =
  ajv.compile<RawPushgateConfig>(schema);

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
