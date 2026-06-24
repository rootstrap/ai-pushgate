# Pushgate Context

Pushgate is a local git push gate. It gives developers fast feedback before a push reaches the next review layer, while keeping git push as the normal user workflow.

## Language

**Pushgate**:
The local push gate that evaluates a repository before a git push proceeds.
_Avoid_: push checker, pre-push script, review bot

**Push**:
The developer action of sending local commits to another git repository.
_Avoid_: deploy, publish, submit

**Local Push Gate**:
The local decision point that can allow, warn on, or block a push before it leaves the developer machine.
_Avoid_: CI check, pull request check, remote gate

**Pre-Push Hook**:
The Git hook entry point that invokes Pushgate during a push.
_Avoid_: hook script, shell gate

**Pushgate Runner**:
The executable that performs Pushgate's local push-gate workflow.
_Avoid_: command wrapper, binary, implementation

**Managed Runner**:
The installed Pushgate runner that repositories delegate to by default.
_Avoid_: global binary, home install

**Pushgate Config**:
The repository-owned configuration that defines how Pushgate should evaluate pushes.
_Avoid_: settings file, config blob

**Target Branch**:
The branch or ref a push is reviewed against when Pushgate determines changed files.
_Avoid_: base branch, main branch

**Changed File**:
A repository file whose path or content differs from the target branch for the push being evaluated.
_Avoid_: staged file, touched file

**Changed-File Resolution**:
The normalized set of changed files plus the git metadata that explains how that set was derived.
_Avoid_: diff result, file list

**Review Range**:
The git range used to prepare human-readable review context for local AI review.
_Avoid_: diff range, comparison range

**Scan Range**:
The git range used by a deterministic scanner that must inspect commits rather than just changed paths.
_Avoid_: plugin range, scanner diff

**Deterministic Check**:
A local check whose result does not depend on a language model.
_Avoid_: local test, non-AI check

**Built-In Policy**:
A deterministic check provided by Pushgate itself.
_Avoid_: internal rule, native check

**Configured Tool**:
A deterministic command configured by the repository.
_Avoid_: script, task, custom command

**Plugin Check**:
A first-class deterministic check that delegates to a known external scanner while preserving Pushgate behavior.
_Avoid_: integration, external tool

**Local AI Review**:
The local language-model review phase that evaluates changed files after deterministic checks pass.
_Avoid_: AI check, model scan, automated reviewer

**Provider**:
The selected local AI backend that can perform local AI review.
_Avoid_: model, vendor, client

**Finding**:
A concrete issue reported by local AI review.
_Avoid_: comment, note, alert

**Blocking Finding**:
A finding that blocks a push when local AI review is in blocking mode.
_Avoid_: error, failure

**Warning Finding**:
A finding that is shown to the developer without blocking the push.
_Avoid_: advisory, notice

**Guardrail**:
A local limit that skips or constrains a Pushgate phase before expensive or unreliable work begins.
_Avoid_: validation rule, safety check

**Skip Control**:
A one-push instruction that bypasses all Pushgate work or only local AI review.
_Avoid_: bypass flag, disable switch

**Transcript**:
The developer-facing Pushgate output that explains what ran, what was skipped, and why a push passed or failed.
_Avoid_: logs, console output
