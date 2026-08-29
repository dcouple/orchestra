# Socratic gate - shared procedure

Run by `/create-brief` after `brief.html` is drafted (`status: draft` in its
metadata) and before publish. The calling skill supplies the per-type
emphasis - what socrates should bear down on for this item type.

1. Dispatch the `socrates` sub-agent with the draft's path (round 1). It
   calibrates its own intensity - that judgment lives in the agent
   definition, not here or in the caller.
2. Relay the questions to the user **verbatim** and wait for answers - don't
   answer for them; the gate exists to make the user justify the item.
3. Re-dispatch socrates with the answers to judge them (round 2); press
   `partial`/`evasive` answers once. Cap: two judged rounds, then proceed with
   anything unresolved carried into Open questions.
4. If the dialogue changes the item - narrower scope, a different phase cut,
   or not worth doing - edit `brief.html` in place, recut the phases, or stop.
   Abandoning here is a success, not a failure.
5. Write the distilled Q&A into the brief's Justification section
   (one line per question: claim challenged - reason that held). Long
   exchanges go to `refs/socratic-dialogue.md`, linked from the brief.
6. The user may waive the gate explicitly; record
   `Socratic gate waived by user.` in the Justification section.

Done when: socrates returned `pass` (or the cap was reached, or the user
waived); the Justification section written into `brief.html`.
