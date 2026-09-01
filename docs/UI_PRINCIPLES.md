# Money Flow UI Principles

Money Flow UI should feel light and direct. Favor quick comprehension over dense configuration.

## Dashboard

- Keep the dashboard compact.
- Show budget state clearly before adding secondary analytics.
- Keep the hero state, amount, progress, and decorative ribbon synchronized. Distinguish a daily overrun, a monthly budget overrun, and a shortfall after scheduled payments.
- Keep the three recent-expense rows directly editable, with the section action opening full History.
- Keep History primarily a compact searchable transaction list: quick periods fit without horizontal scrolling, custom dates stay a separate action, and period analytics is collapsed by default and follows the currently displayed results. Expense rows are one tappable surface with the shared category avatar and no permanent edit/delete button row.
- On narrow screens, keep the Budget and plan metrics in the reference 2-by-2 grid with equal card widths and equal heights within each row. The weekly metric keeps its weekly remainder even when the month has no free money, with a separate warning for the monthly constraint.
- Avoid visual noise that makes the user hunt for the current money state.
- Empty, loading, and error states should be consistent across dashboard sections.
- Make the Dashboard usable before fetching History. History loads on first entry to its tab (or for an explicit History deep link) and must not delay the initial budget view.
- Keep unresolved expense recovery in one compact Dashboard disclosure: show the total tail, split it into immediately safe and review-required counts, make the safe batch action primary, and keep ambiguous drafts reachable through the existing History review flow. Hide actions whose count is zero.

## Settings

- Settings must not feel like an admin panel.
- Use compact or collapsible sections for secondary settings.
- Keep high-frequency settings easy to scan and low-frequency settings tucked away.
- Save low-risk selects and toggles after an intentional change without a global Settings submit step; serialize writes and restore the last confirmed value after an error.
- Require explicit old-to-new confirmation for the regular monthly budget, while keeping the current-month override as a separate flow.
- Keep the custom display currency reversible: following the base currency must not erase a previously selected secondary currency. A blocked regular-budget change must explain the calculated minimum rather than show the generic Settings autosave error.
- Keep account deletion collapsed by default and preserve every existing destructive confirmation step after disclosure.

## Editing

- Edit saved expenses and active planned payments in the shared modal shell over the screen where editing started. Closing, saving, or deleting must not switch tabs, reset History filters, or discard the user's scroll position.
- Keep expense Save and confirmed Delete actions inside the modal. Use the modal header close control for cancel without saving instead of a redundant footer Close action.
- On narrow screens, keep the page behind the modal inert and fixed. Size the modal to its content and center it within the Telegram-safe usable area; when a form reaches the safe maximum height, let its body scroll while the header and actions remain inside the content-safe-area, fullscreen-control, and device-safe-area bounds.
- In planned-payment edit mode, keep only Save and confirmed Disable inside the modal; Reset and footer Close belong only to create/recreate flows, while the header close control cancels editing.

## Planned Payments

- Use the same category avatar, amount hierarchy, radius, and compact density as expense rows. The information surface opens the shared editor; Pay remains a separate direct primary action.
- Always show a text status in addition to color. Paid is positive, future unpaid is a softer warning, and overdue unpaid gets the strongest danger treatment; recurring progress remains explicit.
- Fully paid plans must not expose an active Pay action. Keep existing undo and disable actions in their established overflow flow.

## Planned Payment Archive

- Keep disabled plans collapsed by default and load archive data only after the user expands it. Do not add archive rows to the main dashboard response.
- Archive rows are read-only. Their only action is `Create again`; do not expose edit, Pay, delete, or restore controls.
- Show explicit loading, empty, retryable error, and loaded states without blocking the active plan list.
- Recreate is an explicit form mode with a user-local `Start counting from` date. A successful creation closes the form before refresh; a refresh failure shows a warning without inviting a duplicate submit.
- On narrow screens, long descriptions, large amounts, metadata, and the action button wrap within the card without horizontal scrolling or clipping.

## Telegram Planned Payment Reminder

- Use one card per exact occurrence with explicit `planned payment` wording in RU and EN.
- Pay, snooze, disable, and Mini App actions stay on separate rows. Disable requires a confirmation step.
- After payment, reuse the common saved-expense summary and show only the primary Mini App button; do not expose ordinary expense edit or delete controls.

## Responsive Behavior

- Support both small and large iPhone screens, including iPhone 11 and iPhone 14 Pro.
- Request Telegram fullscreen only on mobile client platforms; desktop and web clients should stay in their native compact Mini App shell.
- Keep `html`, `body`, the scrolling surface, and Telegram WebView background synchronized with the selected theme so iOS rubber-band areas continue the app surface.
- Tab swipes are interactive: the current and adjacent pages follow a confirmed horizontal drag and snap only after release. Preserve vertical scrolling, form/editor/modal guards, edge resistance, and the existing tab loading/state lifecycle.
- Check that cards, buttons, labels, and amounts do not overlap on narrow screens.
- Russian and English interface text should sound natural, simple, and human. Check dashboard changes at 375, 390, and 430 CSS pixels, including long English labels.
- Acknowledge the Telegram shell before the main module graph evaluates; keep the early bootstrap visual-free and let the main app own safe-area, theme, fullscreen, and interaction listeners exactly once.
- Discover CSS and the root module in the document head so their downloads overlap the Telegram SDK wait; preloading must not execute app code before Telegram acknowledgement.
