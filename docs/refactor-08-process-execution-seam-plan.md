# Refactor 08 Process Execution Seam Plan

This document turns the process execution simplification into a concrete PR plan.

The goal is to deepen the process execution module so spawn behavior, output capture, timeout handling, stdin delivery, kill grace, and inherited stdio are tested through one seam instead of reappearing in several modules.

## Verified Context

The source already has `src/process/run-command.ts`, but multiple modules still own their own process implementation.

| Concern | Current state |
|---|---|
| Captured Git commands | `src/git/command.ts` uses `src/process/run-command.ts`. |
| Deterministic tools | `src/runner/deterministic.ts` owns spawn, timeout, capped output, and output-tail formatting. |
| Provider CLIs | `src/ai/providers/run-provider-command.ts` owns similar spawn, timeout, stdin, capped output, and output-tail formatting. |
| Push wrapper | `src/git/push.ts` owns inherited-stdio `git push` execution. |
| Claude auth probe | `src/ai/providers/claude.ts` owns a small direct `spawn` for `claude auth status`. |

Two or more adapters already need the same seam. That makes process execution a real seam, not a hypothetical one.

## Scope Limits

In scope:

- Extend `src/process` with reusable command adapters.
- Move common timeout and output-tail behavior into one module.
- Keep caller-level result shapes stable unless a narrow adapter makes the caller simpler.
- Preserve provider-specific command names, args, auth detection, and messages.
- Preserve deterministic check transcript output and exit behavior.

Out of scope:

- Do not change tool command config shape.
- Do not change provider adapter command args.
- Do not change local AI mode behavior.
- Do not merge Git, deterministic, and provider domain decisions into the process module.
- Do not introduce shell execution for argv-array commands.

## Proposed Files

Add:

| New file | Responsibility |
|---|---|
| `src/process/timed-command.ts` | Run commands with timeout, kill grace, stdin, capped output, and formatted output tail. |
| `src/process/inherited-command.ts` | Run commands that inherit stdio and return code/signal. |
| `src/process/output.ts` | Shared capped append and output-tail formatting helpers if they stay small. |

Modify:

| Existing file | Desired final role |
|---|---|
| `src/process/run-command.ts` | Captured command adapter for Git and simple commands. |
| `src/runner/deterministic.ts` | Deterministic gate logic, not raw process management. |
| `src/ai/providers/run-provider-command.ts` | Provider-result mapping over the shared timed command adapter. |
| `src/git/push.ts` | Thin wrapper over inherited command execution. |
| `src/ai/providers/claude.ts` | Auth probe uses a process adapter or a local helper that hides raw spawn. |

## Proposed Adapter Shape

```ts
export type TimedCommandResult =
  | {
      kind: "completed";
      code: number | null;
      signal: NodeJS.Signals | null;
      stdout: string;
      stderr: string;
      outputTail?: string;
    }
  | {
      kind: "spawn-error";
      error: Error;
      outputTail?: string;
    }
  | {
      kind: "timeout";
      outputTail?: string;
    };

export function runTimedCommand(options: {
  command: string;
  args: readonly string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  stdin?: string;
  timeoutSeconds: number;
  outputCaptureLimit?: number;
  outputTailLimit?: number;
  killGraceMs?: number;
}): Promise<TimedCommandResult>;
```

Callers can translate this shared process result into deterministic or provider-specific result types at their own module seam.

## Execution Plan

1. Extract shared output helpers.
   - Move capped string append and output-tail formatting into `src/process`.
   - Keep the helpers internal to process modules unless tests need direct access.
   - Preserve current tail length defaults per caller through options.

2. Add `runTimedCommand`.
   - Support stdin as optional string input.
   - Support timeout, SIGTERM, kill grace, and SIGKILL fallback.
   - Return spawn failures as result objects so callers can preserve their own messages.

3. Update provider command execution.
   - Replace raw spawn in `src/ai/providers/run-provider-command.ts`.
   - Keep provider command result kinds stable for Claude and Copilot adapters.
   - Preserve the stdin error comment where provider CLIs exit before stdin drains.

4. Update deterministic tool execution.
   - Replace raw spawn in `src/runner/deterministic.ts`.
   - Keep `ToolCommandResult` local to deterministic checks.
   - Preserve timeout text, output transcript, warning/blocking behavior, and fail-fast behavior.

5. Update inherited stdio execution.
   - Add or reuse an inherited command adapter for `src/git/push.ts`.
   - Preserve Git exit code and signal behavior.

6. Consider the Claude auth probe.
   - Use `runCommand` if the simple captured adapter is enough.
   - Keep auth-specific interpretation in `claude.ts`.

7. Validate.
   - `pnpm test`
   - Targeted checks: deterministic runner timeout tests, AI provider timeout tests, push wrapper tests.

## Acceptance Criteria

- Raw `node:child_process` imports are removed from production modules except `src/process/*` if practical.
- Deterministic and provider timeout behavior stays covered and unchanged.
- Caller modules translate process results into their own domain results.
- `pnpm test` passes.
- The process execution seam has at least captured, timed, and inherited adapters.

## Graph Scorecard

After this PR, process execution should appear as one deep module with multiple adapters. Locality improves because spawn bugs, timeout behavior, and output-tail rules concentrate in one implementation, while deterministic checks and provider adapters keep their smaller domain interfaces.
