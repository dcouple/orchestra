# Model prices — versioned reference

The rates the wrap-up run record and postmortems use to turn token counts
into dollars. Versioned: each row carries the date it was last verified;
on a mismatch the provider's published page wins — update the row and its
date here (this file is the history). Verify against
<https://platform.claude.com/docs/en/pricing> and
<https://platform.openai.com/pricing>.

## Rates (USD per million tokens)

| Model | Input | Output | Cache read | Cache write | Verified |
|---|---|---|---|---|---|
| `claude-fable-5` | $10.00 | $50.00 | 0.1× input | 1.25× input (5m TTL) / 2× (1h TTL) | 2026-07-21 |
| `claude-opus-4-8` / `-4-7` / `-4-6` | $5.00 | $25.00 | 0.1× | 1.25× / 2× | 2026-07-21 |
| `claude-sonnet-5` | $3.00 ($2.00 intro through 2026-08-31) | $15.00 ($10.00 intro) | 0.1× | 1.25× / 2× | 2026-07-21 |
| `claude-haiku-4-5` | $1.00 | $5.00 | 0.1× | 1.25× / 2× | 2026-07-21 |
| `gpt-5.6-sol` (codex dispatches) | $5.00 | $30.00 | cached input 0.1× | — | 2026-07-21 |
| `gpt-5.5` (codex resume fallback) | $4.00 | $24.00 | cached input 0.1× | — | 2026-07-21 |

Batch API bills every class at 50% on both providers.

## Computing a run's cost

Cost is summed **per token class**, never from a raw total:

```
uncached input × input rate
+ output        × output rate
+ cache reads   × 0.1 × input rate
+ cache writes  × TTL multiplier × input rate
```

- Claude classes come from the session/sub-agent transcript `message.usage`
  fields (deduplicate by `message.id` first —
  `.references/run-operations-analysis.md`).
- Codex classes come from the session rollout `token_count` events
  (`input` / `cached_input` / `output` / `reasoning`; reasoning bills as
  output). The CLI's end-of-run `tokens used` figure is a blended total —
  it cannot be priced accurately; when only the blend survives, record the
  cost `unknown` rather than pricing the blend.
