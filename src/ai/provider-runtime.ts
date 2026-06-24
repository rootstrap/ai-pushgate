import type { AiConfig } from "../config/index.js";
import { claudeProvider } from "./providers/claude.js";
import { copilotProvider } from "./providers/copilot.js";
import type {
  LocalAiProviderAdapter,
  LocalAiProviderFailure,
  LocalAiProviderResult,
  LocalAiProviderRunOptions,
} from "./types.js";

export type LocalAiProviderRuntime =
  | {
      kind: "ready";
      providerId: string;
      runReview(
        options: Omit<LocalAiProviderRunOptions, "providerConfig">,
      ): Promise<LocalAiProviderResult>;
    }
  | {
      kind: "provider-error";
      result: LocalAiProviderFailure;
    };

export const LOCAL_AI_PROVIDERS: readonly LocalAiProviderAdapter[] = [
  claudeProvider,
  copilotProvider,
];

export function resolveLocalAiProviderRuntime(
  aiConfig: AiConfig,
  providers: readonly LocalAiProviderAdapter[] = LOCAL_AI_PROVIDERS,
): LocalAiProviderRuntime {
  const provider = providers.find(
    (candidate) => candidate.id === aiConfig.provider,
  );

  if (!provider) {
    return {
      kind: "provider-error",
      result: {
        kind: "provider-error",
        code: "unsupported_provider",
        provider: aiConfig.provider ?? "unknown",
        message: `Pushgate does not implement the configured AI provider ${JSON.stringify(
          aiConfig.provider,
        )} yet.`,
      },
    };
  }

  const providerConfig =
    aiConfig.providers[provider.id] ??
    aiConfig.providers[aiConfig.provider ?? provider.id] ??
    {};

  return {
    kind: "ready",
    providerId: provider.id,
    runReview(options) {
      return provider.runReview({
        ...options,
        providerConfig,
      });
    },
  };
}
