# Money Flow iPhone Shortcut

Publish one generic iCloud Shortcut and configure its link through `IOS_SHORTCUT_URL`.
The Shortcut must ask one Apple Import Question for the Quick Access key; do not embed a user token in a distributed Shortcut.

1. Use **Dictate Text** and create a UUID once per run as `clientRequestId`.
2. `POST /api/shortcut/expenses` with `Authorization: Bearer <key>` and JSON `{ "text": "…", "clientRequestId": "…" }`.
3. Display the returned draft preview and ask the user to confirm or cancel.
4. On confirmation, `POST /api/shortcut/drafts/<draftId>/confirm` with the same bearer token.

The same `clientRequestId` must be retained on a network retry. The service accepts ordinary expense text only; it does not process bot commands, budget operations, photos, or server-side audio.
