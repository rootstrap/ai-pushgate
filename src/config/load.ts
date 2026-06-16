import { constants as fsConstants } from "node:fs";
import { access, readFile } from "node:fs/promises";
import { join } from "node:path";

import { CONFIG_FILENAME, LEGACY_CONFIG_FILENAME } from "./constants.js";
import { LegacyConfigError, MissingConfigError } from "./errors.js";
import { parseConfigYaml } from "./validation.js";
import type { LoadedConfig } from "./types.js";

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

async function exists(path: string): Promise<boolean> {
  try {
    await access(path, fsConstants.F_OK);
    return true;
  } catch {
    return false;
  }
}
