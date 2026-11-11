# Telegram Saved Expense Widget Implementation Plan

**Goal:** Show the saved expense in a real Telegram HTML Widget and preserve category changes, text corrections, and confirmed deletion.

**Architecture:** Render a small fixed HTML document with theme-aware CSS and private receipt state. Send it as a new message and retire the loader or draft only after Telegram confirms delivery. Handle widget queries through the existing per-user Telegram queue and expense ownership checks.

- [x] Extend `apps/api/test/telegram.test.js` to cover widget delivery with query permission, explicit rejection fallback, category updates, text edits, and deletion. Run `node --test --test-name-pattern 'saved expense widget' apps/api/test/telegram.test.js`.
- [x] Add the template and bounded JSON state in `apps/api/src/telegramSavedExpenseWidget.js`. Use native buttons for choices and the existing chat editor for typing. Keep the current receipt as the fallback for clients where Telegram rejects the widget.
- [x] Wire sending, queries and state refresh in `apps/api/src/telegram.js`. Verify that a foreign query cannot mutate expenses, confirmed delivery precedes cleanup, and ambiguous sends do not fall back to a duplicate.
- [x] Verify the exact HTML in a local browser with a simulated widget bridge, then run `npm test`.
- [ ] Verify the widget in Telegram Desktop and mobile using a test bot before production release.
