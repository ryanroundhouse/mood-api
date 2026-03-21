# Breathing Tracking Requirements

## Purpose

This document defines the business concepts that should be tracked for the new `Breathe` feature so the backend can:

- show a user their breathing history in the app
- support correlation between breathing activity and mood entries
- include breathing activity in downstream LLM-generated summaries such as mood summaries, wins of the week, and similar insight features

This document intentionally does **not** define database schema, endpoint signatures, or transport formats.

## Core Event To Track

The core unit to track is a **completed or attempted breathing session**.

A breathing session starts when the user begins a selected routine and ends when they either:

- complete the configured session
- exit early
- are interrupted

## Required Concepts

### 1. Session identity

Track each breathing session as a distinct user activity record.

Why:

- lets the UI show a history of breathing sessions
- lets summaries reference individual sessions or aggregate them
- lets incomplete sessions be distinguished from completed ones

### 2. User association

Each breathing session must be attributable to a specific user.

Why:

- required for personal history
- required for mood correlation
- required for per-user LLM summaries

### 3. Routine type

Track which breathing routine was used.

Current routines:

- Box Breathing
- 4-7-8 Breathing

Why:

- different routines may correlate differently with mood outcomes
- summaries may want to mention which methods the user actually uses
- future reporting may compare routine effectiveness

### 4. Intended cycle setting

Track the cycle mode the user selected when the session began.

Current modes:

- 3 cycles
- 5 cycles
- 10 cycles
- Infinite

Why:

- reflects user intent
- distinguishes short check-ins from longer deliberate sessions
- helps interpret completion status correctly

### 5. Actual cycles completed

Track how many full cycles were actually completed in the session.

Why:

- completion quality matters more than just session start
- infinite sessions need a real completed-cycle count
- partial sessions should still be usable for pattern analysis

### 6. Session outcome / completion status

Track whether the session:

- completed as configured
- was exited early by the user
- was interrupted / failed to complete

Why:

- completed and abandoned sessions should not be interpreted the same way
- the UI may want to display completion vs partial progress
- summaries may mention consistency or follow-through

### 7. Session start time

Track when the session started.

Why:

- needed for timeline/history views
- needed for comparison with mood entry timing
- needed for time-of-day pattern analysis

### 8. Session end time

Track when the session ended.

Why:

- allows actual duration to be calculated
- supports partial-session analysis
- helps align breathing activity with nearby mood logs

### 9. Actual duration

Track the effective session duration, either directly or derivable from start/end.

Why:

- useful for reporting and habit analysis
- important for infinite mode and early exits
- summaries may refer to “brief resets” versus longer calming sessions

## Strongly Recommended Concepts

### 10. Trigger context

Track whether the session was started from:

- home screen panel
- drawer/menu
- feature announcement dialog
- another future entry point

Why:

- helps evaluate discoverability and user behavior
- useful for product iteration
- can help interpret whether usage is intentional habit-building or opportunistic

If this is considered too product/analytics-oriented for now, it can be deferred.

### 11. App-local date context

Track or derive the user-local calendar date for each session.

Why:

- daily summaries and weekly summaries usually reason in local date boundaries
- mood correlation is often day-based, not purely timestamp-based

### 12. Proximity to mood entries

The backend should support linking or comparing breathing sessions to nearby mood entries, even if it does not store a hard foreign-key relationship initially.

Examples of useful relationships:

- breathing session before a mood entry
- breathing session after a mood entry
- breathing sessions on the same day as a mood entry
- number of breathing sessions between two mood logs

Why:

- this is central to the correlation use case
- LLM summaries will likely need “supporting context around a mood”

## Optional But Valuable Concepts

### 13. Audio state used

Track whether the session was run with background audio enabled or muted.

Why:

- may matter when interpreting whether the user prefers silent or guided calming sessions
- may be useful if future summaries mention preferred calming conditions

This is optional if it adds too much complexity early.

### 14. Countdown completed

Track whether the pre-breath countdown finished before the user exited.

Why:

- distinguishes “started then immediately backed out” from a meaningful attempt
- may help with cleaning noisy usage records

### 15. Exit reason

If practical, distinguish why a session ended early.

Possible examples:

- user tapped back
- app backgrounded
- app closed
- playback/technical interruption

Why:

- improves interpretation of incomplete sessions
- helps avoid overstating user disengagement when the cause was technical

## Aggregates The UI / Summaries Will Likely Need

The backend should be able to provide or derive:

- total number of breathing sessions
- number of sessions by routine type
- number of completed vs partial sessions
- total cycles completed
- total breathing time
- most-used routine
- breathing sessions per day / week
- breathing activity near low-mood days
- breathing activity near improved-mood days

## Concepts Useful For LLM Summaries

When assembling data for LLM-based mood summaries, the breathing domain should be representable in terms such as:

- whether the user used breathing exercises this week
- which breathing routine(s) they used
- how often they used them
- whether usage increased or decreased versus prior periods
- whether breathing sessions cluster around stressful days or lower mood ratings
- whether mood entries following breathing sessions look different from those without breathing activity
- whether the user tends to complete short routines, longer routines, or infinite sessions

## Minimum Useful Tracking Set

If the backend wants the smallest version that still supports the product goal well, track at least:

- user
- session identity
- routine type
- selected cycle mode
- completed cycle count
- completion status
- start timestamp
- end timestamp or duration

## Future Compatibility Notes

The tracking model should leave room for future breathing features such as:

- additional breathing routines
- custom timing patterns
- custom target durations
- reminders or scheduled sessions
- streaks / habit tracking
- guided voice or alternate audio tracks

Those are not required now, but the concepts above should not assume only the two current routines will ever exist.
