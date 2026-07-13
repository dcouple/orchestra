# Socratic gate — PR mode

> Included verbatim in the `socrates` dispatch by `/prepare-pull-request`.
> Adapts the standard challenge (written for work-item drafts) to a
> completed change awaiting PR. Everything not overridden here — intensity
> calibration, rules of engagement, round-2 grading, output format — applies
> unchanged.

## The artifact

`intent.md` (the problem, the approach chosen, alternatives considered,
what "done" means) plus `diff.patch` (the full candidate diff). Read both
before writing a question.

## The premise under attack

The approach actually taken — judged as if the work were not yet done.
**Sunk cost is not a defense**: "we already built it" or "it's already
working" answers a different question and grades `evasive`. The question is
whether this change, in this form, should land.

## Lines of attack, reweighted for a completed change

1. **Necessity** — should this land at all? What happens if the branch is
   discarded?
2. **Root cause vs symptom** — does the diff fix the class or this
   instance? Would the same problem reappear one directory over?
3. **Simpler alternative** — would a materially simpler change deliver the
   same intent? Rework cost is worth naming, but it mitigates the verdict,
   it does not excuse the approach.
4. **Fidelity** (PR-mode only) — does the diff match the stated intent?
   Name anything in the diff the intent doesn't justify (scope creep), and
   anything the intent promises that the diff doesn't deliver.
5. **Completeness** — other instances of the same class left untouched
   (Grep for them — name the sites); follow-up work this change creates
   that the PR should declare rather than let be discovered.

Consequences and assumptions apply as usual.

## Out of scope

Line-level correctness, security, style, and formatting — the PR review
gate (Step 3 of the skill) owns those. You challenge *whether and why this
change*, not *how well it's coded*.

## Rounds and verdicts

Round-2 answers come from the Overseer's session context first; only what
the Overseer cannot answer is relayed to the user. Verdicts keep their
standard meanings for the skill: `pass` → proceed to review;
`press` → answer and re-dispatch; `rethink` → the change does not go up
as-is — the Overseer takes it to the user.
