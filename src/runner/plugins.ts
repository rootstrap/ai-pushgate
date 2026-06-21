import type { PluginsConfig } from "../config/index.js";

export function countPluginChecks(plugins: PluginsConfig): number {
  return Number(Boolean(plugins.gitleaks?.enabled));
}
