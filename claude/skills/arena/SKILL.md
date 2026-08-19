---
name: arena
description: Produce one artifact by fanning out N blind candidates, picking the strongest as the base, grafting the best of the losers into it, and verifying the synthesis. Use when a single attempt at a non-trivial artifact — a design, a tricky function, a doc — would lock in the wrong shape.
argument-hint: "[the artifact to produce]"
---

# Arena

## Artifact: $ARGUMENTS

One attempt commits to one shape. When the shape is the risk, produce several
shapes in parallel and synthesize the best of them.

## 1. Frame the contract

Write the task once: what the artifact is, the constraints it lives under, and
the rubric it is judged against — the concrete properties that make one version
better than another. Every candidate receives this same text.

## 2. Fan out

Dispatch N fresh-context sub-agents (default 3, cap 5) in a single message so
they run concurrently. These are ad-hoc dispatches: name the agent type and
pass an explicit `model` (default `opus`), never the inherited session one.
Each gets the contract, its own output path under
`./tmp/arena/<slug>/candidate-1..N/`, and no knowledge of the others.
Candidates write inside their own path and leave the working tree untouched —
concurrent writers otherwise overwrite each other. Each dispatch carries the
leaf-agent line — you are a sub-agent; never spawn agents or invoke agent CLIs
— so the fan-out stays one level deep.

Ask every candidate for the artifact plus a short rationale: what it chose, and
what it considered and dropped.

## 3. Pick the base

Read every candidate end to end before judging any of them. Score each against
the rubric and pick the base: the one a future maintainer extends most easily
without breaking its invariants. Name the winner and the rubric line that
decided it.

## 4. Graft

Move the strongest one or two ideas from each losing candidate into the base,
adapted to the base's shape. The losers' rationales are where grafts come
from — they name ideas the winner never considered.

## 5. Land and verify

Write the synthesis to the artifact's real destination — the file it ships in,
out of `./tmp/`, which is scratch. Uncommitted work already at that destination
gets committed or confirmed first, and a write reached for on your own
initiative waits for the user's ask. Then run the repo's checks against it — the
build/typecheck/lint workflow its own `AGENTS.md`, package scripts, or CI config
names — or the task's own acceptance test. Every graft is new code, and this
combination is one nobody produced or checked.

## Report

- the winner and why it won;
- each graft and the loser it came from;
- verification evidence: the command run and its result;
- where the artifact now lives.
