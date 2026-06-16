import type { ProviderConfig } from "../../config/index.js";

export function selectProviderModel(
  providerConfig: ProviderConfig,
): string | undefined {
  const model = providerConfig.model;

  return typeof model === "string" && model.trim().length > 0
    ? model.trim()
    : undefined;
}
