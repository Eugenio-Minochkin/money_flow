# Money Flow iPhone Shortcut

Publish one generic iCloud Shortcut and configure its link through `IOS_SHORTCUT_URL`.
The Shortcut must ask one Apple Import Question for the Quick Access key; do not embed a user token in a distributed Shortcut.

The Mini App prepares a hashed key, copies its raw value locally, and only then activates it. A failed copy or activation leaves the prior active key working. `shortcutConfigured` means an active key exists; it does not prove that iOS installed the Shortcut.

1. Create a UUID once per run as `clientRequestId`, then use **Dictate Text**.
2. `POST /api/shortcut/expenses` with `Authorization: Bearer <key>` and JSON `{ "text": "…", "clientRequestId": "…" }`.
3. If the response has `state=saved`, show its short `summary` and finish the Shortcut. Do not show a second confirmation screen.
4. If the response has `state=review`, tell the user that the expense needs review and finish. The returned draft stays in Money Flow's shared Inbox; optionally offer to open Money Flow, but do not require immediate editing.

The same `clientRequestId` must be retained on a network retry, including a retry after an unknown or lost HTTP response. A replay returns the original saved expense or review draft and does not run the parser or create a financial fact again.

The service accepts ordinary expense text only; it does not process bot commands, budget operations, photos, or server-side audio. The legacy draft confirm/cancel endpoints remain available for older Shortcut versions and review flows, but they are not part of the zero-friction safe path.
