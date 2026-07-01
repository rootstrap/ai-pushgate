# Local AI Review

Local AI review evaluates changed files after deterministic checks pass. It is
provider-neutral at the Pushgate boundary: providers receive the same review
payload and return one normalized review result or provider failure.

## Modes

| Mode | Provider failures | Blocking findings | Warning findings |
|---|---|---|---|
| `blocking` | Block the push. | Block the push. | Require confirmation. |
| `advisory` | Warn, then require confirmation. | Warn, then require confirmation. | Require confirmation. |
| `off` | Not run. | Not run. | Not run. |

`blocking` is the default. Active modes require `ai.provider` and a matching
`ai.providers.<provider>` block.

## Streaming Output

`ai.verbose` defaults to `true`. When the selected provider can produce
human-readable response text while preserving the final structured result,
Pushgate streams that text under a provider-labeled section such as
`Claude response`.

Set `ai.verbose: false` to hide streamed provider response text. Compact
progress and final output still render. Push decisions always come from the
final `Validated findings` section, never from streamed response text.

Current deliberate limits:

- `ai.verbose` controls only streamed provider response text.
- Streamed provider response text is terminal-only and is not persisted.
- Provider response text is terminal-sanitized, but not length-truncated.
- Provider adapters may differ in streaming capability; unsupported providers
  fall back to progress and final validated findings.
- TTY spinners and idle heartbeats are future transcript polish, not part of the
  first streaming contract.

## Guardrails

| Guardrail | Behavior |
|---|---|
| No changed files | Skips local AI and exits successfully. |
| `ai.max_changed_lines` exceeded | Blocks before provider invocation. |
| `ai.max_prompt_tokens` exceeded | Skips local AI only and exits successfully. |
| Provider timeout | Provider failure: blocks in `blocking`, warns in `advisory`. |

Changed-line counts use added plus deleted text lines after `ignore_paths`
filtering. Binary diffs do not contribute. Prompt-token counts are
provider-neutral estimates because provider tokenizers differ.

## Providers

Built-in provider IDs:

| Provider | Runtime | Structured output capability |
|---|---|---|
| `claude` | Claude Code CLI | Native JSON Schema through `claude -p --json-schema`. |
| `copilot` | Standalone GitHub Copilot CLI | JSONL transport with strict local parsing and validation. |

`ai.providers.<provider>.model` is optional for both providers. When omitted,
the provider CLI chooses its default model.

`ai.providers.claude.bare` defaults to `false`. Pushgate uses Claude Code safe
mode by default so local OAuth login still works while local Claude
customizations stay disabled. Set `bare: true` only for API-key or
settings-helper automation, because Claude Code bare mode skips OAuth/keychain
reads.

## Review Payload

The local AI payload contains:

| Field | Meaning |
|---|---|
| `changedFiles` | Normalized changed files from path policy. |
| `diff` | Rendered diff for the review range. |
| `diffLineCount` | Size of the rendered diff context. |
| `fullFiles` | Optional full-file context for small changed files. |
| `prompt` | Final provider-neutral review prompt. |

Providers should not invent their own review instructions. The built-in prompt
defines the review task and the structured output contract.

## Output Contract

Every provider response validates against Pushgate AI Review Output v1:

```json
{
  "schema_version": 1,
  "findings": [
    {
      "category": "logic_errors",
      "confidence": "high",
      "severity": "blocking",
      "file": "src/example.ts",
      "line": "12-14",
      "message": "Explain the issue clearly.",
      "suggestion": "Describe the concrete fix."
    }
  ]
}
```

Top-level fields are strict:

| Field | Meaning |
|---|---|
| `schema_version` | Must equal `1`. |
| `findings` | Array of strict finding objects. Empty array means no findings. |

Finding fields are strict:

| Field | Meaning |
|---|---|
| `category` | One exact category string. |
| `confidence` | `low`, `medium`, or `high`. |
| `severity` | `blocking` or `warning`, aligned with category. |
| `file` | Repository-relative path. |
| `line` | Line number, line range, or `N/A`. |
| `message` | Clear issue description. |
| `suggestion` | Concrete actionable fix. |

## Finding Categories

| Severity | Categories |
|---|---|
| `blocking` | `security`, `logic_errors` |
| `warning` | `test_coverage`, `performance`, `naming_and_readability` |

Schema validation checks shape. Semantic validation also rejects findings whose
category and severity do not match.

## Parsing And Repair

Pushgate validates every provider response locally before consuming findings.
Provider-native schema output is preferred when available. Text-like transports
are still accepted only after strict parsing, narrowly scoped safe repair, and
contract validation.

Output that cannot be parsed or validated becomes a provider failure. Pushgate
does not silently accept malformed review output.
