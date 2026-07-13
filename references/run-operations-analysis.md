# Run operations analysis — how a /do run spent wall-clock

The postmortem's **operational** half: not "was the output right" but "how did
the run actually go" — total wall-clock, how much was the agent working vs
sitting idle waiting on a human, where it stalled, and what blocked it. This
runs on **every** /do run, including successful ones, because autonomy leaks
(the agent ending its turn mid-run and waiting for a nudge) are invisible to
an outcome-only review yet are the main thing standing between a run and true
overnight autonomy.

## Where the record lives

Claude Code stores each session as JSONL under
`~/.claude/projects/<munged-cwd>/*.jsonl` (the cwd path with `/` → `-`). A
single /do run may span several files (compaction starts a new session id).
Glob them all; each line is one event with an ISO-8601 `timestamp` and a
`type` (`user` | `assistant` | …). Genuine human messages are `type:"user"`
with plain-text content that is **not** a tool result, **not** a
`[SYSTEM NOTIFICATION`/`<task-notification>` block, and not a slash-command or
`<...>` meta line. Assistant turns and `tool_result` users are agent activity.

## What to compute (script it — don't eyeball)

Parse the transcripts and derive:

- **Wall-clock span** — first to last event.
- **Agent-active vs human-idle** — for each genuine human message, the gap
  since the last agent event is time the agent sat idle *waiting on the human*.
  Sum it. `active ≈ span − human-idle`. Report the idle % — for a run meant to
  be autonomous, a high idle % localized *inside* the run (not after it
  finished) is the headline finding.
- **Post-completion idle** — the final human-idle gap, after the last agent
  work, is the human being away *after* the run finished. Separate it: it
  inflates perceived duration but is not a run defect.
- **Stalls (autonomy leaks)** — human messages preceded by a large agent-idle
  gap where the agent had simply *ended its turn* (no blocking question). Each
  is a place the run should have continued on its own. Cross-reference the
  human's text ("continue", "still going?") — nudges are the symptom.
- **Per-phase pacing** — map phase/fix commit timestamps
  (`git log --reverse --date=... origin/main..HEAD`) onto the timeline; a long
  gap between two phase commits with no agent activity is a stall.
- **Blocker inventory** — count and time-stamp: `AskUserQuestion` pauses
  (which gates, and were they green-tier things that should have been
  pre-authorized?), sub-agent/tool rate-limit hits, and long legitimate
  background-agent runtimes (these are *productive* waits, not stalls — keep
  them out of the leak column).

Reference script (adapt paths; classify conservatively):

```python
import json, glob, datetime as dt
files = glob.glob('/Users/<you>/.claude/projects/<munged-cwd>/*.jsonl')
ev=[]
for fn in files:
    for line in open(fn):
        try: d=json.loads(line)
        except: continue
        ts=d.get('timestamp')
        if not ts: continue
        t=dt.datetime.fromisoformat(ts.replace('Z','+00:00'))
        typ=d.get('type'); msg=d.get('message',{})
        c=msg.get('content') if isinstance(msg,dict) else None
        kind=typ
        if typ=='user':
            if isinstance(c,str):
                s=c.strip()
                kind=('sysnotif' if s.startswith('[SYSTEM') or '<task-notif' in s
                      else 'meta' if s.startswith('<') or s.startswith('Base directory')
                      else 'HUMAN')
            elif isinstance(c,list):
                ks={b.get('type') for b in c if isinstance(b,dict)}
                if 'tool_result' in ks: kind='tool_result'
                else:
                    txt=' '.join(b.get('text','') for b in c if isinstance(b,dict) and b.get('type')=='text').strip()
                    kind='HUMAN' if txt and not txt.startswith('[SYSTEM') and '<task-notif' not in txt else 'meta'
        ev.append((t,kind))
ev.sort()
agent=lambda k:k in ('assistant','tool_result')
span=(ev[-1][0]-ev[0][0]).total_seconds()/3600
last=None; idle=0; stalls=[]
for t,k in ev:
    if k=='HUMAN' and last:
        g=(t-last).total_seconds()/60; idle+=g
        if g>20: stalls.append((t,g))
    if agent(k): last=t
print(f'span {span:.1f}h  human-idle {idle/60:.1f}h ({100*idle/60/span:.0f}%)  active ~{span-idle/60:.1f}h')
for t,g in stalls: print(f'  stall: agent idle {g:.0f}min before human msg at {t}')
```

## Output — the "Run operations" block

Fold the numbers into the postmortem's **Run operations** section (see
`postmortem.md` format): the wall-clock/active/idle split, the
post-completion-idle carve-out, the ranked stalls with what each was waiting
on, the blocker inventory, and — the payoff — the one operational change that
would have removed the biggest stall (pre-authorize a green-tier gate, add a
self-wakeup so a turn-end resumes, make a fallback non-blocking). That change
is a candidate for the postmortem's single proposed system change when the
operational leak outweighs any outcome gap.
