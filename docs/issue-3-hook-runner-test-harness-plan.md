# Issue 3 Hook And Runner Test Harness Plan

This document narrows issue #3 into the knowledge gaps, open questions, and
execution plan for the behavioral harness that must exist before the installed
hook and Pushgate runner are rewritten.

The broader product contract remains in `docs/product-contract-plan.md`. The
v2 config boundary frozen by issue #2 remains in
`docs/issue-2-config-schema-plan.md` and `docs/v2-config-schema.md`.

## Known Context

Issue #3 owns the first whole-workflow verification layer:

1. Create temporary Git repositories in tests.
2. Invoke the current hook and later runner against controlled changes.
3. Stub deterministic tools and AI providers through `PATH`.
4. Assert exit codes, key terminal output, and observable artifacts.
5. Add shell syntax and static checks where practical.

The repository is in a transition state that matters for the harness:

| Area | Current state | Harness implication |
|---|---|---|
| Config parser | Node v2 `.pushgate.yml` loader and schema tests exist. | Reuse the existing Node test toolchain rather than creating a second test runtime without a reason. |
| Current hook | `hook/pre-push` still contains the legacy single Bash workflow and reads `.push-review.yml`. | Initial end-to-end coverage must distinguish characterization of this hook from v2 runner contract coverage. |
| Future runner | `pushgate pre-push` is the contract in docs, but issue #4 owns the thin hook and runner boundary. | The harness should make a future runner invocation easy without implementing that runner here. |
| Skip controls | Product docs define Git-config skip paths, but issue #18 owns implementation. | Skip scenarios need a place in the matrix now; AI-only and whole-runner skip assertions land when the controls exist. |
| Changed-file policy | Filenames with spaces, ignored paths, and deleted files are acceptance cases, while issue #5 owns final path semantics. | Test setup should create those repos now without freezing future path-policy internals. |
| AI providers | The current hook hard-codes `claude`; issue #10 owns the provider boundary. | The first provider stub can emulate the current CLI while the helper API stays provider-neutral. |
| CI | The Linux CI job already runs `pnpm test` for the Node config layer. | Issue #3 can extend that Linux path and should keep macOS-compatible helpers. |

## Scope Boundaries

Issue #3 should add test infrastructure and enough behavioral coverage to make
later rewrites observable. It should not redesign these backlog-owned surfaces:

| Surface | Backlog owner |
|---|---|
| Thin installed hook plus `pushgate pre-push` runner | Issue #4 |
| Final changed-file and ignore-path semantics | Issue #5 |
| Deterministic command modes, timeouts, and richer runner behavior | Issue #6 |
| AI provider interface and Claude adapter | Issue #10 |
| Local AI mode guardrails | Issue #11 |
| Documented Git-config skip controls | Issue #18 |

## Locked Definitions To Preserve

- `git push` remains the primary developer entry point.
- The future installed `pre-push` hook delegates to `pushgate pre-push` and
  returns its exit code.
- `.pushgate.yml` is the v2 config source. Legacy `.push-review.yml` behavior
  is migration behavior, not the new public config vocabulary.
- V2 deterministic tool commands are argv arrays and `{changed_files}` is a
  runner expansion token, not a shell interpolation contract.
- Local AI modes are `blocking`, `advisory`, and `off`, with `blocking` as the
  default.
- Local hook behavior is not final enforcement because Git can bypass hooks.

## Knowledge Gaps And Open Questions

### Harness Boundary

- Should the first end-to-end tests call `hook/pre-push` directly, install it
  into `.git/hooks/pre-push` and execute a real push, or use both with one
  smoke push and mostly direct invocation?
- Which current-hook behaviors are worth characterizing before issue #4, and
  which assertions should wait for the v2 runner contract so legacy
  `.push-review.yml` details are not made sticky?
- What stable harness API should future issue #4 tests use for runner stdin,
  hook arguments, environment, and captured output?

### Git Fixture Model

- What minimal temporary-repo topology covers a target branch, a feature HEAD,
  a bare remote for push smoke tests, deleted files, ignored paths, and
  filenames with spaces without making every test expensive?
- Should branch resolution and remote-fetch behavior be exercised here or left
  to issue #5 once its base-ref algorithm is frozen?
- Which Git identity and environment settings must be pinned so tests behave
  the same on local macOS and Linux CI?

### Stub Contract

- How should stubs expose their invocations and generated artifacts to tests:
  captured files in a harness-owned temp directory, stdout markers, or both?
- How much of the current `claude --print` output grammar should the first AI
  stub model before the provider and structured-finding contracts exist?
- Should missing tool and missing provider cases be represented by absent
  binaries on `PATH`, explicit failing stubs, or both?
- How should the harness prevent current hook paths such as update checks or
  target-branch fetches from reaching the network?

### Scenario Ownership

- The issue requires pass, warning, blocking, and skipped outcomes. Which
  skipped outcome is asserted before issue #18: Git's observable
  `--no-verify` hook bypass, current hook early-exit paths, or only reserved
  matrix rows for the later skip-control implementation?
- Should filenames with spaces, ignored paths, and deleted files assert only
  that the workflow stays correct and safe now, or assert exact changed-file
  lists before issue #5 owns the normalized list?
- Should provider failure preserve the current hook's allow-push behavior as a
  characterization test, or should it be represented as an expected contract
  change for later AI mode work?

### Assertions And Portability

- Which terminal lines are contract-level output worth asserting after ANSI
  color is stripped, and which output is implementation noise?
- Should `ShellCheck` be a required local script, a Linux CI dependency, or an
  optional check until the shell surface changes in issue #4?
- What is the supported shell and OS matrix beyond the issue requirement for a
  Linux path and room for macOS coverage?

## Working Decisions For Execution

These defaults keep issue #3 actionable while leaving the backlog-owned
contracts open:

1. Build the harness in the existing TypeScript `node:test` path.
2. Put reusable Git repo, command stub, environment isolation, and invocation
   helpers under the test tree so later hook and runner tests can share them.
3. Invoke `hook/pre-push` directly for most current-hook characterization
   tests. Add a real installed-hook push smoke test only when it proves hook
   wiring or `--no-verify` behavior that direct invocation cannot prove.
4. Isolate `PATH`, `HOME`, Git author/committer identity, color-sensitive
   output handling, and stub artifact directories per test.
5. Keep assertions focused on exit code, selected output markers, stub
   invocation artifacts, and Git-observable results. Do not lock down the
   legacy YAML parser shape or full terminal transcript.
6. Record scenario rows for v2 runner, AI-only skip, whole-runner skip, and
   final changed-file normalization even when the implementation owner lands
   later.

## Initial Behavioral Matrix

| Scenario | First harness target | Expected assertion |
|---|---|---|
| Tool pass plus AI pass | Current hook | Exit zero, tool stub called with changed file args, AI stub called, pass marker printed. |
| Tool failure | Current hook | Exit non-zero, AI stub not called, blocking marker printed. |
| AI warning result | Current hook | Exit zero, warning output visible, blocking count remains zero. |
| AI blocking result | Current hook | Exit non-zero and blocking summary visible. |
| Provider binary missing | Current hook | Exit non-zero with actionable missing-provider output. |
| Provider invocation failure | Current hook characterization | Current behavior captured without making later mode semantics implicit. |
| Filename with spaces | Current hook setup, future runner target | Stub artifact proves one logical path survives invocation. |
| Ignored changed path | Current hook setup, future path-policy target | Ignored path does not reach tool or AI artifacts for the asserted target. |
| Deleted changed path | Current hook setup, future path-policy target | Workflow does not try to read deleted content as a live file. |
| Hook bypass or scoped skip | Git smoke or reserved runner row | `--no-verify` can prove no hook invocation now; Git-config skip rows activate with issue #18. |

## Execution Plan

1. Add harness primitives to the existing test stack.
   - Add test helpers for temporary directories, Git command execution,
     deterministic Git identity, repo cleanup, and output capture.
   - Add a temporary repo builder that creates a target branch and feature
     change set without depending on the developer's global Git config.
   - Add a `PATH` sandbox that can install executable tool, provider, and
     network stubs while preserving the binaries needed by Git and Bash.

2. Define invocation surfaces and stub artifacts.
   - Add a current-hook invocation helper that runs the repository
     `hook/pre-push` with isolated `HOME`, `PATH`, cwd, arguments, and stdin.
   - Make stubs write JSON or line-oriented invocation artifacts inside the
     test temp directory so assertions do not depend on exact transcript text.
   - Stub `claude` responses for pass, warning, block, empty, and failing
     outcomes, and stub configured deterministic tools for pass and fail.
   - Block or stub network-relevant commands such as `curl` in harness
     environments.

3. Land current-hook characterization coverage.
   - Cover pass, deterministic blocking, AI warning, AI blocking, missing
     provider, and provider failure paths.
   - Create fixture changes for a filename with spaces, an ignored path, and a
     deleted file, then assert only the behavior owned by the current harness.
   - Use focused output matchers that remove ANSI escapes before checking key
     messages.

4. Prepare the runner-facing extension point.
   - Keep the repo builder and stub layer independent from the Bash hook.
   - Add scenario names or table entries for future `pushgate pre-push` stdin
     and argument coverage so issue #4 can swap in the runner without
     rebuilding setup code.
   - Keep `.pushgate.yml` fixtures available for v2 runner tests while any
     legacy-hook fixtures stay clearly scoped to characterization.

5. Add shell and Linux verification.
   - Add scripts or test steps for `bash -n hook/pre-push` and
     `bash -n install.sh`.
   - Run error-level `ShellCheck` in Linux CI and keep the matching local
     command available without hiding shell failures behind the Node tests.
   - Extend the Linux CI workflow to run the harness plus shell checks.

6. Document coverage and deferred rows.
   - Update contributor-facing verification instructions when the harness
     commands exist.
   - Call out runner, skip-control, path-policy, and provider-contract rows
     that are intentionally deferred to their owning issues.

## Verification Target

The issue is ready to close when:

1. The harness creates isolated Git repos and stubs tool/provider calls without
   live AI or network dependencies.
2. Automated coverage exercises pass, warning, blocking, missing-dependency,
   filename-with-space, ignored-path, and deleted-file setup paths at the
   scope owned by issue #3.
3. The skipped-outcome story is explicit: it is covered by an observable
   current Git/hook case or represented by tests that activate with the
   issue-18 controls.
4. Linux CI runs the harness and shell syntax checks, with helpers kept
   compatible with local macOS runs.
5. The helper boundary is reusable when issue #4 introduces
   `pushgate pre-push`.
