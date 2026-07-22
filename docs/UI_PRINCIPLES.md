# Money Flow UI Principles

Money Flow UI should feel light and direct. Favor quick comprehension over dense configuration.

## Dashboard

- Keep the dashboard compact.
- Show budget state clearly before adding secondary analytics.
- Avoid visual noise that makes the user hunt for the current money state.
- Empty, loading, and error states should be consistent across dashboard sections.

## Settings

- Settings must not feel like an admin panel.
- Use compact or collapsible sections for secondary settings.
- Keep high-frequency settings easy to scan and low-frequency settings tucked away.

## Planned Payment Archive

- Keep disabled plans collapsed by default and load archive data only after the user expands it. Do not add archive rows to the main dashboard response.
- Archive rows are read-only. Their only action is `Create again`; do not expose edit, Pay, delete, or restore controls.
- Show explicit loading, empty, retryable error, and loaded states without blocking the active plan list.
- Recreate is an explicit form mode with a user-local `Start counting from` date. A successful creation closes the form before refresh; a refresh failure shows a warning without inviting a duplicate submit.
- On narrow screens, long descriptions, large amounts, metadata, and the action button wrap within the card without horizontal scrolling or clipping.

## Responsive Behavior

- Support both small and large iPhone screens, including iPhone 11 and iPhone 14 Pro.
- Check that cards, buttons, labels, and amounts do not overlap on narrow screens.
- Russian interface text should sound natural, simple, and human.
