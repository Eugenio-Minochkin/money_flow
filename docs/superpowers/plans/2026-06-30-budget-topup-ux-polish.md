# Budget Top-up UX Polish

## Goal

Polish the already-implemented budget top-up flow without changing month scoping, parser business logic, budget calculations, reserve synchronization, snapshot invalidation, or rollover behavior.

## Plan

- [x] Strengthen Telegram formatter tests for budget top-up draft, large warning, success, and undo copy.
- [x] Strengthen Telegram keyboard tests for emoji labels, callback data stability, large-warning action set, undo, and Mini App buttons.
- [x] Update Telegram formatting and callback integration so confirm, cancel, and undo leave useful buttons.
- [x] Return the undone top-up amount from repository undo results only for Telegram presentation.
- [x] Replace the Mini App always-open budget top-up block with a collapsed compact card and local expand/collapse state.
- [x] Update Mini App translations, CSS, and renderer tests.
- [x] Run focused API/Mini App tests, review the diff, then commit, push, and open a PR.
