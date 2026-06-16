import { claudeProvider } from "./providers/claude.js";
import { copilotProvider } from "./providers/copilot.js";
import type { LocalAiProviderAdapter } from "./types.js";

export function resolveProvider(
  providerId?: string,
): LocalAiProviderAdapter | null {
  switch (providerId) {
    case "claude":
      return claudeProvider;
    case "copilot":
      return copilotProvider;
    default:
      return null;
  }
}
