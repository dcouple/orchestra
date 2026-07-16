# claudex × orchestra

`claudex` is a shell alias that launches the **Claude Code harness with
OpenAI's GPT-5.6 Sol as the model**, through a local
[CLIProxyAPI](https://github.com/router-for-me/CLIProxyAPI) proxy billed
against a ChatGPT Plus/Pro subscription. It's the escape hatch for running
orchestra when Anthropic model usage is exhausted.

**Full setup guide (macOS / Linux / WSL):** [`claudex-setup.html`](claudex-setup.html)
— open it in a browser; it covers install, proxy config, startup service,
OAuth, the alias, and troubleshooting.

## The switch

Which command starts the session is the whole switch:

- Have Anthropic usage → launch orchestra sessions with `claude`.
- Out of usage → launch with `claudex`. Same skills, same subagents, same
  pipeline, on GPT-5.6 Sol at high reasoning effort.

## Why orchestra needs no configuration for this

- Every Claude-side step (plan-reviewer, code-reviewer, socrates,
  frontend-implementer, the /do orchestrator itself) runs as an **in-session
  subagent** via the Agent tool and inherits the session's model and auth. No
  skill shells out to a `claude` CLI.
- The Codex lanes (`codex exec` in the codex skill) use their own CLI and
  auth — unaffected by which command launched the session.
- Some agent definitions pin `model: opus` / `model: sonnet` in frontmatter.
  The alias's `ANTHROPIC_DEFAULT_{HAIKU,SONNET,OPUS}_MODEL` remaps route
  those through the proxy too, so pinned agents can't accidentally try (and
  fail) to reach Anthropic.

## Reasoning-effort tiers

The proxy forks `gpt-5.6-sol` into effort-pinned client names
(`oauth-model-alias` + per-model `payload.override` rules — see the HTML
guide), and the alias maps each Claude model alias onto a tier:

| Claude Code asks for | Routed to | Effort | Used by |
| --- | --- | --- | --- |
| the `--model` (main loop) | `gpt-5.6-sol` | high | the orchestrator session itself |
| `opus` (frontmatter pins) | `gpt-5.6-sol-medium` | medium | socrates, code-reviewer, plan-reviewer, frontend-implementer |
| `sonnet` (frontmatter pins) | `gpt-5.6-sol-low` | low | code-researcher, web-researcher, frontend-verifier |
| `haiku` (background chores) | `gpt-5.6-sol-low` | low | session titles, other harness trivia |

The proxy override wins even when the client requests a different effort
(verified from request logs). Do **not** set `CLAUDE_CODE_SUBAGENT_MODEL` in
the alias — it forces one model onto all subagents and defeats the tiers.

## Context window: declare the real size, never `[1m]`

GPT-5.6 Sol's real window is **~350–370k tokens total** — probed empirically
through the proxy (2026-07): 328k input succeeds cold, ~349k passes, ~374k is
rejected with "input exceeds the context window". Claude Code doesn't know this: it
budgets non-Anthropic models at 200k by default (wasting almost half the
window), and its `[1m]` model-ID suffix budgets 1M — which routes fine but
would kill long orchestra runs at ~370k with a hard 400 before auto-compact
ever triggers.

The fix, already in the claudex alias: `CLAUDE_CODE_MAX_CONTEXT_TOKENS=340000`
— a Claude Code override that sets the context budget for any model whose ID
doesn't start with `claude-`. 340k sits safely below the verified pass points.
Verified: `/context` reports `53.1k / 340k`, and auto-compact + `/compact`
work through the proxy, so long runs summarize and continue with nearly
double the default working space. Custom suffixes like `[400k]` are not
supported (silent fallback to 200k); the env var is the mechanism.

## Validating on a new machine

From this repo's root (or any consumer repo):

```bash
claudex -p "Dispatch two subagents in parallel via the Agent tool: 'socrates' and 'code-researcher', each with the prompt: 'Reply with exactly: OK'. Report both replies."
```

Both replies coming back proves the chain end-to-end: the opus pin resolved
to `gpt-5.6-sol-medium` and the sonnet pin to `gpt-5.6-sol-low`, dispatched
through the proxy, and answered. A failure means the
`ANTHROPIC_DEFAULT_*_MODEL` remaps are missing from the alias or the model
forks are missing from the proxy config.
