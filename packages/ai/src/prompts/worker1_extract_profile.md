---
id: worker1_extract_profile
version: 1
worker: worker_1_profile_builder
model: claude-sonnet-4-6
temperature: 0.2
max_tokens: 3000
---

You are extracting a structured student profile from onboarding-form responses
and (optionally) OCR'd marksheet text. Output ONLY a JSON object — no
commentary outside the JSON.

Hard rules:
  1. Never invent facts. If the form does not state a field, set it to null
     (or `[]` for arrays) and add a flag in `flags_for_counsellor`.
  2. For grades parsed from marksheet OCR, prefer "marks_obtained / marks_total"
     literals over inferred percentages. If OCR is garbled or absent, leave
     `subjects[].marks_obtained` as null and flag.
  3. Goals are extracted from open-ended text. Compress into 1–3 short goal
     statements. If a goal is vague ("do well in school"), keep it but flag
     as `goal_too_vague`.
  4. `initial_focus_areas` is the counsellor-facing recommendation list.
     Pick 3–5 from the union of (subject weaknesses + stated goals + observed
     working-sample issues). Order by priority.

Output schema:

{
  "name": "string",
  "current_grade": "string (e.g. '10', '12')",
  "school": "string | null",
  "date_of_birth": "ISO date | null",
  "subjects": [
    {
      "subject": "Math | Physics | ... (one of WGC subject set)",
      "year": "string | null",
      "term": "string | null",
      "marks_obtained": "number | null",
      "marks_total": "number | null"
    }
  ],
  "named_strengths": ["string", ...],
  "named_weaknesses": ["string", ...],
  "goals": ["string", ...],
  "working_sample_analysis": "string | null",
  "parent_context": "string | null",
  "language_preference": "en | hi | ta | ...",
  "logistics": {
    "timezone": "string",
    "devices": ["string", ...],
    "schedule_constraints": "string | null"
  },
  "initial_focus_areas": [
    { "area": "string", "rationale": "string" }
  ],
  "flags_for_counsellor": [
    { "field": "string", "code": "missing | low_confidence | goal_too_vague | inconsistent | ocr_failed", "note": "string" }
  ]
}

Form responses (JSON):
{{form_responses}}

Marksheet OCR text (may be empty if no upload, OCR disabled, or OCR failed):
{{marksheet_text}}
