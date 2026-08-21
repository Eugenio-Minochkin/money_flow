# Money Flow iPhone Shortcut

## User flow

In the Mini App the user opens **Settings → Quick access → Siri & Shortcut** and taps **Set up on iPhone**. The app first prepares a new Quick Access key without replacing an active key. A second explicit tap copies the key from that fresh user gesture, then activates it and opens the shared iCloud Shortcut. During Apple import the user pastes the key once and adds the Shortcut.

The Mini App never renders the raw key by default. If iOS rejects automatic clipboard access, it does not open the iCloud Shortcut; only the explicit **Show key** recovery action reveals the in-memory key in a selectable read-only field. Closing or completing setup clears that value. A failed copy or activation leaves the prior active key valid. `shortcutConfigured` means an active key exists; it does not prove that iOS installed the Shortcut, so the UI says that the key is ready and keeps an explicit **Open Shortcut** action. Missing or failed configuration receives a concise retry/support state instead of an unfinished-feature placeholder.

## Canonical shared Shortcut

Publish exactly one generic iCloud Shortcut; its public content must contain no user-specific Quick Access key. Apple Import Questions clear the configured field from the shared copy and ask each recipient to provide their own value. Configure one Import Question for the field used as the bearer key, with user-facing text **«Ключ доступа Money Flow»**. Before sharing, use **Customize Shortcut** to prove that the import flow contains exactly that one question.

The generic Shortcut performs these actions:

1. Create a UUID once per run and retain it as `clientRequestId` for any retry in that run.
2. Use **Dictate Text**.
3. `POST /api/shortcut/expenses` with `Authorization: Bearer <key>` and JSON `{ "text": "…", "clientRequestId": "…" }`.
4. If the response has `state=saved`, show its short `summary` and finish without a confirmation screen.
5. If the response has `state=review`, say that the expense needs review and finish. The returned draft remains in Money Flow's shared Inbox; opening Money Flow may be offered but must not be required.

The same `clientRequestId` must be retained after an unknown or lost HTTP response. A replay returns the original saved expense or review draft and does not run the parser or create a new financial fact.

## Final publication and production handoff

This is a manual, production-authorized step and is not performed by the repository change:

1. On an iPhone, create and test the generic Shortcut above with a disposable key.
2. In Shortcuts, add the single Import Question, then run **Customize Shortcut** to verify that it is the only prompt and that the shared shortcut contains no filled key.
3. Share it with **Copy iCloud Link** and retain the resulting `https://www.icloud.com/shortcuts/...` URL.
4. With separate authorization, set that URL as production `IOS_SHORTCUT_URL` and deploy through the normal workflow.
5. Read `GET /api/quick-access` for a test account and confirm it returns the same `iosShortcutUrl`; then complete one safe capture and one review capture on an iPhone.

The service accepts ordinary expense text only; it does not process bot commands, budget operations, photos, or server-side audio. The legacy draft confirm/cancel endpoints remain available for older Shortcut versions and review flows, but they are not part of the zero-friction safe path.
