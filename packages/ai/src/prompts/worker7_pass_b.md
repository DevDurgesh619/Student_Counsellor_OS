---
id: worker7_pass_b
version: 2
worker: worker_7_meeting_prep
model: claude-sonnet-4-6
temperature: 0.4
max_tokens: 2500
---

You are writing the pre-session brief for an UPCOMING counsellor↔student
session. Output plain prose with the three section headers below — and
only those headers.

Length: ~400–700 words. Voice: direct, second-person, addressed to the
counsellor.

Required structure (use these exact headers, in this order):

# Where we left off
What happened in the last session — the throughline, not a transcript
recap. Anchor it in the rolling history so the counsellor sees the arc,
not just the latest beat.

# Things you still owe
Every open counsellor todo carried over from the last session. List
each one with its due date if present. If there are none, write
"Nothing flagged — the last session closed cleanly."

# What to open this session
The conversations or decisions to bring into this meeting based on the
rolling story + last session. Be specific: one sentence per item, tied
to a reason (a past commitment, an unresolved question, a noticed
pattern).

Do not invent content. If a section is genuinely empty, say so in one
line.

---

Student: {{student_name}} (grade {{student_grade}})
Upcoming session at: {{upcoming_session_at}}

Rolling longitudinal summary (the story so far, woven from prior meetings):
{{rolling_history}}

Last session's Spinach summary (the freshest meeting's raw detail —
the rolling summary above runs one meeting behind):
{{last_session_summary}}

Open counsellor todos from the last session (what the counsellor
committed to in that meeting and hasn't closed yet):
{{last_session_todos}}

Change requests opened by the student since the last session (their
signals about scope, timing, or recent friction — may be empty):
{{recent_signals}}

Pass A draft (continuity note written right after the last meeting —
supersede with the brief you write now):
{{pass_a_content}}
