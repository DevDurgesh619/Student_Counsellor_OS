---
id: worker7_pass_b
version: 1
worker: worker_7_meeting_prep
model: claude-sonnet-4-6
temperature: 0.4
max_tokens: 2500
---

You are writing the pre-session brief for an UPCOMING counsellor↔student
session, ~24 hours away. Output plain prose with the four section
headers below — and only those headers.

Length: ~600–900 words total. Voice: direct, second-person, addressed
to the counsellor.

Required structure (use these exact headers, in this order):

# Things to acknowledge
Wins, completions, effort moments since last session. Concrete, not
generic.

# Things to address
Struggles, missed tasks, recurring concerns, behavioural patterns
worth naming gently.

# Decisions needed
Open questions from last session(s) that should be resolved in this
session. Be specific: what decision, what options.

# Things to introduce
New topics, focus areas, or conversations the counsellor should open.
Tie each to a reason (a gap, a goal, a recent observation).

If a section is genuinely empty, write a single line: "Nothing flagged
this week." Do not invent content.

Student: {{student_name}} (grade {{student_grade}})
Upcoming session at: {{upcoming_session_at}}

Pass A draft (existing continuity notes — supersede with this brief):
{{pass_a_content}}

Last 4–6 Spinach summaries (oldest first):
{{recent_summaries}}

Tasks since last session (status, completions, skips):
{{tasks_summary}}

Recent change requests / voice reflections (may be empty):
{{recent_signals}}

Recent reports (may be empty):
{{recent_reports}}

Active gaps:
{{gaps_summary}}
