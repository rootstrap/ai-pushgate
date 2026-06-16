import { CONFIG_FILENAME, LEGACY_CONFIG_FILENAME } from "./constants.js";

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
