# Budget Reserve MVP Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a single monthly Budget Reserve per user with recurring templates, timezone-stable periods, immutable month closing, Mini App management, and Telegram status output.

**Architecture:** Keep reserve arithmetic in the shared package, persistence and lifecycle orchestration in the API repository, and rendering/actions in the existing Mini App. Lazy month opening runs transactionally before dashboard reads, closes existing past instances, creates at most one current instance, and emits separately acknowledged close events. Reserve state uses only regular expenses; planned obligations and large one-off expenses remain separate buckets.

**Tech Stack:** Node.js ESM, `node:test`, PostgreSQL, vanilla browser JavaScript, Telegram Bot API.

---

### Task 1: Shared reserve calculations and timezone helpers

Create `packages/shared/src/reserve.js` and tests covering capacity validation, saved/eaten/over-budget states, early-month forecasts, and IANA timezone month/day boundaries.

### Task 2: Reserve persistence and transactional lifecycle

Extend `apps/api/migrations/001_initial.sql` and `apps/api/src/repository.js` with user timezone, one recurring template per user, one monthly instance per user/period, immutable close snapshots/events, transactional lazy opening, disabled/reactivated states, and invariant validation.

### Task 3: Dashboard snapshot integration

Integrate effective budget, full planned obligations, regular spending, active reserve state, daily limit, forecast, recurring blocked state, and pending close events into the dashboard snapshot.

### Task 4: HTTP API and timezone capture

Add reserve create/edit/disable/template/ack routes and send `Intl.DateTimeFormat().resolvedOptions().timeZone` from Mini App requests.

### Task 5: Mini App reserve UI and localization

Add compact dashboard status, budget settings management, explicit current/future scopes, blocked state, close event rendering/ack, and complete RU/EN translations.

### Task 6: Telegram budget and close-event output

Extend `/budget` and month-close output without adding free-text reserve NLP.

### Task 7: Final regression verification and documented TODOs

Run the full suite and document deferred timezone UI, NLP/voice intents, reconcile indicators, multi-reserve support, and savings-goal behavior.
