# Refactor 05 AI Provider And Prompt Cleanup Plan

This document turns the AI cleanup into a concrete PR plan.

The goal is to remove duplication in provider adapters and make the review prompt single-sourced without collapsing the existing AI phase boundaries. The AI layer is already reasonably separated, so this refactor should be conservative.

## Verified Context

The generated graph places provider adapters, prompt construction, output parsing, and AI types in the AI Review Engine layer. Source inspection shows two main cleanup opportunities:

| Concern | Current state |
|---|---|
| Provider command execution | `src/ai/providers/claude.ts` and `src/ai/providers/copilot.ts` duplicate stdin prompt execution, output capture, timeout handling, and combined-output formatting |
| Model selection | Both adapters read `providerConfig.model` with near-identical trimming logic |
| Structured output parsing | Both adapters parse raw provider output through `parseAiReviewOutput` with nearly identical error mapping |
| Prompt source of truth | `src/ai/review-prompt.ts` embeds `BASE_REVIEW_PROMPT`, while `src/ai/prompts/review-prompt.md` carries the same instructions |
| Provider-specific auth handling | Claude probes `claude auth status`; Copilot detects auth-like text patterns from command output |

The existing AI tests cover provider invocation, model selection, missing CLIs, malformed output, auth-like failures, timeout propagation, prompt guardrails, and installed-hook AI flows.

## Scope Boundaries

In scope:

- Extract shared provider command execution.
- Extract shared provider output normalization.
- Extract shared provider config helpers.
- Make the review prompt markdown file the single source of truth.
- Preserve provider-specific command args and auth detection.

Out of scope:

- Do not change AI mode semantics.
- Do not change structured AI review output schema.
- Do not add new providers.
- Do not alter privacy guardrails, diff limits, prompt token limits, or timeout defaults.
- Do not merge provider adapters into one generic adapter.

## Proposed Files

Add:

| New file | Responsibility |
|---|---|
| `src/ai/providers/run-provider-command.ts` | Run provider CLIs with stdin prompt, timeout, capped output, and combined-output formatting |
| `src/ai/providers/config.ts` | Shared provider config helpers such as model selection |
| `src/ai/providers/normalize-review.ts` | Optional helper for empty output and malformed structured output handling |
| `src/ai/prompts/review-prompt.d.ts` | Type declaration for markdown imports if TypeScript needs it |

Modify:

| Existing file | Desired final role |
|---|---|
| `src/ai/providers/claude.ts` | Claude args, Claude auth probe, Claude-specific failure messages |
| `src/ai/providers/copilot.ts` | Copilot args, Copilot auth output detection, Copilot-specific failure messages |
| `src/ai/review-prompt.ts` | Payload assembly and prompt rendering using imported markdown instructions |
| `scripts/build-runner.mjs` | Add an esbuild loader for `.md` if prompt markdown is imported at build time |
| `tsconfig.json` or a declaration file | Teach TypeScript how to type markdown imports |

## Proposed Provider Command Shape

```ts
export type ProviderCommandResult =
  | {
      kind: "completed";
      code: number | null;
      stdout: string;
      output?: string;
    }
  | {
      kind: "spawn-error";
    }
  | {
      kind: "timeout";
      output?: string;
    };

export function runProviderCommand(options: {
  command: string;
  args: readonly string[];
  prompt: string;
  cwd: string;
  env: NodeJS.ProcessEnv;
  timeoutSeconds: number;
  outputCaptureLimit?: number;
  outputTailLimit?: number;
}): Promise<ProviderCommandResult>;
```

The default capture limits can match the current provider constants unless a caller overrides them.

## Prompt Single-Source Strategy

Preferred path:

1. Import `src/ai/prompts/review-prompt.md` from `src/ai/review-prompt.ts`.
2. Add a `.md` module declaration for TypeScript.
3. Add an esbuild loader for `.md` in `scripts/build-runner.mjs`.
4. Delete the embedded `BASE_REVIEW_PROMPT` string from `src/ai/review-prompt.ts`.

Fallback path if markdown imports complicate bundling:

1. Move the prompt text into a `.ts` module.
2. Generate or copy `src/ai/prompts/review-prompt.md` from that source in a later docs-oriented task.

The preferred path is cleaner because the markdown document is already the human-readable source.

## Execution Plan

1. Extract provider config helper.
   - Move model selection into `src/ai/providers/config.ts`.
   - Update Claude and Copilot adapters without changing tests.

2. Extract provider command runner.
   - Move duplicated stdin, timeout, kill-grace, output capture, and combined-output code.
   - Keep provider-specific command names and args in each adapter.
   - Preserve comments about provider processes exiting before stdin drains.

3. Extract shared structured-output normalization if the adapter diff remains noisy.
   - Centralize empty-output and `AiReviewOutputError` mapping only if it improves clarity.
   - Keep provider-specific messages where they are materially different.

4. Single-source the prompt.
   - Import markdown instructions into `review-prompt.ts`.
   - Update TypeScript and esbuild configuration.
   - Remove the duplicated embedded prompt string.
   - Keep prompt rendering output unchanged.

5. Run validation.
   - `pnpm test`
   - Pay special attention to `test/ai.test.ts` and installed-hook AI tests.

## Acceptance Criteria

- `pnpm test` passes.
- Claude and Copilot adapters no longer duplicate provider command execution code.
- `src/ai/review-prompt.ts` no longer contains a manually duplicated copy of `src/ai/prompts/review-prompt.md`.
- Provider-specific auth behavior remains separate and covered by tests.
- Existing AI output rendering and mode behavior remain unchanged.

## Graph Scorecard

After this PR, the AI Review Engine layer should still have separate provider adapter nodes, but shared command execution and prompt-source nodes should absorb duplicated edges. The graph should not show the CLI or deterministic runner gaining any provider-specific dependencies.
