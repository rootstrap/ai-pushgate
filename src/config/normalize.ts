import type { PushgateConfig, RawPushgateConfig } from "./types.js";

export function normalizeConfig(rawConfig: RawPushgateConfig): PushgateConfig {
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
    plugins: normalizePlugins(rawConfig),
    ai: {
      mode: ai.mode ?? "blocking",
      verbose: ai.verbose ?? true,
      max_changed_lines: ai.max_changed_lines ?? 500,
      max_prompt_tokens: ai.max_prompt_tokens ?? 12_000,
      timeout_seconds: ai.timeout_seconds ?? 120,
      ...(ai.provider ? { provider: ai.provider } : {}),
      providers: cloneValue(ai.providers ?? {}),
    },
    ignore_paths: [...(rawConfig.ignore_paths ?? [])],
  };
}

function normalizePlugins(
  rawConfig: RawPushgateConfig,
): PushgateConfig["plugins"] {
  const plugins = rawConfig.plugins ?? {};

  return {
    ...(plugins.gitleaks
      ? {
          gitleaks: {
            enabled: plugins.gitleaks.enabled ?? true,
            command: plugins.gitleaks.command ?? "gitleaks",
            timeout_seconds: plugins.gitleaks.timeout_seconds ?? 60,
            mode: plugins.gitleaks.mode ?? "blocking",
            fail_fast: plugins.gitleaks.fail_fast ?? true,
            ...(plugins.gitleaks.config_path
              ? { config_path: plugins.gitleaks.config_path }
              : {}),
            ...(plugins.gitleaks.baseline_path
              ? { baseline_path: plugins.gitleaks.baseline_path }
              : {}),
            ...(plugins.gitleaks.gitleaks_ignore_path
              ? { gitleaks_ignore_path: plugins.gitleaks.gitleaks_ignore_path }
              : {}),
            redact: plugins.gitleaks.redact ?? true,
            ...(plugins.gitleaks.max_decode_depth !== undefined
              ? { max_decode_depth: plugins.gitleaks.max_decode_depth }
              : {}),
            ...(plugins.gitleaks.max_archive_depth !== undefined
              ? { max_archive_depth: plugins.gitleaks.max_archive_depth }
              : {}),
            ...(plugins.gitleaks.max_target_megabytes !== undefined
              ? { max_target_megabytes: plugins.gitleaks.max_target_megabytes }
              : {}),
            ...(plugins.gitleaks.enable_rules
              ? { enable_rules: [...plugins.gitleaks.enable_rules] }
              : {}),
          },
        }
      : {}),
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
            fail_fast: policies.diff_size.fail_fast ?? true,
          },
        }
      : {}),
    ...(policies.forbidden_paths
      ? {
          forbidden_paths: {
            patterns: [...policies.forbidden_paths.patterns],
            mode: policies.forbidden_paths.mode ?? "blocking",
            fail_fast: policies.forbidden_paths.fail_fast ?? true,
          },
        }
      : {}),
  };
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
