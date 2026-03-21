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

## Implemented Backend Contract

This section documents what is now actually implemented in the Moodful API and what the frontend should call.

### API surface

The breathing feature now lives in its own authenticated router:

- route file: `routes/breathing.js`
- mount point: `/api/breathing`
- auth model: JWT bearer token, same as other protected JSON API routes

There is no anonymous breathing endpoint and no cookie-only variant.

### Supported enum values

The backend currently accepts these canonical values.

#### `routineType`

- `box_breathing`
- `four_seven_eight`

#### `cycleMode`

- `3_cycles`
- `5_cycles`
- `10_cycles`
- `infinite`

#### `status`

- `completed`
- `exited_early`
- `interrupted`

### Create breathing session

#### Route

- `POST /api/breathing/sessions`

#### Required request fields

- `routineType`
- `cycleMode`
- `completedCycles`
- `status`
- `startedAt`
- `endedAt`

#### Optional request fields

- `timezone`
- `triggerContext`
- `audioEnabled`
- `countdownCompleted`
- `exitReason`

#### Validation rules

- `startedAt` and `endedAt` must be ISO-8601 timestamps
- `endedAt` must be on or after `startedAt`
- `completedCycles` must be an integer `>= 0`
- `triggerContext` and `exitReason` are optional bounded strings
- `timezone`, when sent, must be a valid IANA timezone such as `America/Toronto`

#### Derived server-side fields

The frontend does not need to send these:

- `targetCycles`
- `durationSeconds`
- `calendarDate`
- `createdAt`
- `updatedAt`

The backend derives them as follows:

- `targetCycles` is derived from `cycleMode`
- `durationSeconds` is calculated from `endedAt - startedAt`
- `calendarDate` is derived from `startedAt`, using `timezone` when supplied; otherwise the offset/zone embedded in `startedAt` is used

#### Recommended frontend values for optional strings

The backend accepts any bounded string for these fields, but the current intended frontend values are:

- `triggerContext`: `home_panel`, `drawer_menu`, `feature_announcement`
- `exitReason`: values such as `user_backed_out`, `app_backgrounded`, `app_closed`, `technical_interruption`

#### Example request

```json
{
  "routineType": "box_breathing",
  "cycleMode": "5_cycles",
  "completedCycles": 5,
  "status": "completed",
  "startedAt": "2026-03-21T02:30:00Z",
  "endedAt": "2026-03-21T02:35:00Z",
  "timezone": "America/Toronto",
  "triggerContext": "home_panel",
  "audioEnabled": true,
  "countdownCompleted": true
}
```

#### Example response

```json
{
  "id": 42,
  "userId": 123,
  "routineType": "box_breathing",
  "cycleMode": "5_cycles",
  "targetCycles": 5,
  "completedCycles": 5,
  "status": "completed",
  "startedAt": "2026-03-21T02:30:00Z",
  "endedAt": "2026-03-21T02:35:00Z",
  "durationSeconds": 300,
  "calendarDate": "2026-03-20",
  "timezone": "America/Toronto",
  "triggerContext": "home_panel",
  "audioEnabled": true,
  "countdownCompleted": true,
  "exitReason": null,
  "createdAt": "2026-03-21T10:00:00.000Z",
  "updatedAt": "2026-03-21T10:00:00.000Z"
}
```

### Get breathing history

#### Route

- `GET /api/breathing/sessions`

#### Supported query params

- `startDate`
- `endDate`
- `status`
- `routineType`
- `limit`
- `offset`

#### Query semantics

- `startDate` and `endDate` filter against stored `calendarDate`
- date values should be sent as `YYYY-MM-DD`
- results are returned in reverse chronological order by `startedAt`
- default `limit` is `100`
- maximum `limit` is `200`

#### Example request

`GET /api/breathing/sessions?startDate=2026-03-19&routineType=four_seven_eight&limit=50`

### Get breathing aggregates

#### Route

- `GET /api/breathing/stats`

#### Supported query params

- `startDate`
- `endDate`

#### Response shape

```json
{
  "totalSessions": 2,
  "completedSessions": 1,
  "partialSessions": 1,
  "sessionsByRoutine": {
    "box_breathing": 1,
    "four_seven_eight": 1
  },
  "totalCompletedCycles": 10,
  "totalDurationSeconds": 480,
  "mostUsedRoutine": "box_breathing"
}
```

This endpoint currently does not return weekly or monthly rollups. It is intentionally a simple aggregate over the filtered date range.

## Implemented Database Changes

The backend now creates a `breathing_sessions` table in `database.js` with these fields:

- `id`
- `userId`
- `routineType`
- `cycleMode`
- `targetCycles`
- `completedCycles`
- `status`
- `startedAt`
- `endedAt`
- `durationSeconds`
- `calendarDate`
- `timezone`
- `triggerContext`
- `audioEnabled`
- `countdownCompleted`
- `exitReason`
- `createdAt`
- `updatedAt`

Indexes now exist on:

- `(userId, startedAt DESC)`
- `(userId, calendarDate)`
- `(userId, status)`

Account deletion in `routes/user.js` now also deletes `breathing_sessions` rows for the user.

Breathing rows are stored as structured metadata and are not encrypted at rest.

## Implemented Summary-Script Changes

The breathing feature is now included in the LLM summary pipeline in `scripts/send-mood-summary.py`.

### New data included in `get_user_moods(...)`

For each local day, the script now merges breathing data from `breathing_sessions` into the per-day JSON structure.

#### Raw per-session key

- `breathing_sessions`

Each item has:

- `routine_type`
- `cycle_mode`
- `target_cycles`
- `completed_cycles`
- `status`
- `started_at`
- `ended_at`
- `duration_seconds`
- `trigger_context`
- `audio_enabled`
- `countdown_completed`
- `exit_reason`

#### Per-day derived key

- `breathing_summary`

It contains:

- `session_count`
- `completed_session_count`
- `partial_session_count`
- `total_duration_seconds`
- `total_completed_cycles`
- `routines_used`
- `used_breathing`

If a day has breathing data but no mood entry, that day still gets a date bucket in the summary payload. This matches the existing sleep and Garmin daily-data behavior.

### LLM prompt behavior

The OpenAI prompt in `get_openai_insights(...)` now explicitly tells the model to analyze:

- breathing sessions
- breathing frequency
- completed vs partial breathing behavior
- breathing activity near low-mood or high-stress days
- breathing alongside sleep and physical activity patterns

### Current limitation

The deterministic `generate_mood_summary(...)` statistics list was not changed yet. Breathing is currently included in the LLM summary input and prompt, not yet in the non-LLM summary cards.

## Frontend Integration Notes

For the frontend, the practical contract is:

1. On session end, send one authenticated `POST /api/breathing/sessions` call.
2. Always send canonical enum values for `routineType`, `cycleMode`, and `status`.
3. Always send both `startedAt` and `endedAt`.
4. Prefer sending `timezone` so `calendarDate` matches the user’s local day even when timestamps are UTC.
5. Use `GET /api/breathing/sessions` for history screens.
6. Use `GET /api/breathing/stats` for summary cards or lightweight aggregate displays.
