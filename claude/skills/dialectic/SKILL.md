---
name: dialectic
description: Adversarial debate between the two model stacks — a Claude advocate vs a Codex opponent — to pressure-test one high-stakes decision before it locks, or to adjudicate a head-on conflict between the two reviewers. Use at zones 0–1 when a design fork resists convergence, when the user asks to "duel"/"debate" a direction, or when Codex and Claude reviews disagree on a Must Fix. Not for zone 2–3 work.
argument-hint: "[the decision or conflict to debate]"
---

# Dialectic — two stacks, one motion

Parallel blind reviews give redundancy; a dialectic gives **rebuttal** — each
side must attack the other's strongest case instead of independently missing
the same thing. The canonical win: catching a direction sized for someone
else's company (the hundreds-of-millions-of-users answer to a
hundreds-of-users problem) — over-engineering survives solo review because it
*is* best practice somewhere; it rarely survives an opponent briefed on the
actual scale.

## When

- A zone 0–1 design fork that resists convergence, before the D-decision locks
  (called from `/discussion` or `/do`'s plan stage).
- A Must-Fix conflict between the Codex and Claude reviewers in `/do` Step 5 —
  one round, then the Overseer rules.
- The user invokes it directly on a motion.

Never for zone 2–3 items: two max-effort stacks arguing about a contained
change costs more than being wrong would.

## Protocol

1. **Motion** — the Overseer writes `./tmp/<id>/refs/dialectic-<slug>.md`
   (standalone runs: `./tmp/dialectic/<slug>.md`): the decision in one
   sentence, the candidate positions, and the constraints that decide it —
   the ACTUAL scale, the zone, reversibility, what the repo already does
   (with `file:line` where checkable). An honest motion is most of the value;
   a motion that omits the real scale invites the trained-on-Google answer.
2. **Rounds** (default 2, cap 3) — appended to the motion file:
   - **Advocate**: a Claude sub-agent (`model: opus`, thinking) argues the
     leading position — strongest case, named tradeoffs, checkable claims
     cited.
   - **Opponent**: a `codex` skill dispatch (`gpt-5.6-sol` / `xhigh`,
     read-only charter) must (a) rebut the advocate's specific claims — no
     restating its own case as rebuttal — and (b) present the strongest
     alternative under the motion's constraints.
   - Sides alternate; each round reads everything before it; no side edits
     another's text. A side may concede with reasons — early convergence is
     a valid outcome, including convergence on a third design neither side
     opened with.
3. **Verdict** — the Overseer (never either wizard) closes the file: the
   chosen direction, the points grafted from the losing side, and the named
   residual risks. The verdict lands where the decision lives — the
   discussion decision log, the plan's D-decision, or the review resolution —
   with a link to the transcript.

## Rules

- One motion per dialectic; a second question mid-debate becomes its own run.
- Dispatches are ephemeral; the transcript file is the artifact and travels
  with the item's `refs/`.
- Checkable claims carry evidence (`file:line`, a doc, a measurement); a
  round of pure assertion is a wasted round — the Overseer strikes it and
  re-prompts.
- The Overseer must not signal a preferred side in the motion or between
  rounds; judging happens once, at the end.
