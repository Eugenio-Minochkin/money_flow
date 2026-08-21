# Money Flow iPhone Shortcut

## User flow

In the Mini App the user opens **Settings → Quick access → Siri & Shortcut** and taps **Set up on iPhone**. The app first prepares a new Quick Access key without replacing an active key. A second explicit tap copies the key from that fresh user gesture, then activates it and opens the shared iCloud Shortcut. During Apple import the user pastes the key once and adds the Shortcut.

The Mini App never renders the raw key by default. If iOS rejects automatic clipboard access, it does not open the iCloud Shortcut; only the explicit **Show key** recovery action reveals the in-memory key in a selectable read-only field. Closing or completing setup clears that value. A failed copy or activation leaves the prior active key valid. `shortcutConfigured` means an active key exists; it does not prove that iOS installed the Shortcut, so the UI says that the key is ready and keeps an explicit **Open Shortcut** action. Missing or failed configuration receives a concise retry/support state instead of an unfinished-feature placeholder.

## Canonical shared Shortcut

Publish exactly one generic iCloud Shortcut; its public content must contain no user-specific Quick Access key. Apple Import Questions clear the configured field from the shared copy and ask each recipient to provide their own value. Configure one Import Question for the field used as the bearer key, with user-facing text **«Ключ доступа Money Flow»**. Before sharing, use **Customize Shortcut** to prove that the import flow contains exactly that one question.

The generic Shortcut performs these actions, in this order:

1. Create a UUID once per run and retain it as `clientRequestId` for any retry in that run.
2. Use **Dictate Text** with the prompt **«Назовите расход»** / **“Say the expense”**.
3. `POST /api/shortcut/expenses` with `Authorization: Bearer <key>` and JSON `{ "text": "…", "clientRequestId": "…" }`.
4. If the response has `state=saved`, say its terminal `summary`: **«Занесено.»** / **“Saved.”**. The same saved-expense receipt is mirrored to the normal Telegram bot chat; it is not a second expense.
5. If the response has `state=review`, say its terminal `summary`: **«Нужно проверить расход в Telegram — откройте Money Flow.»** / **“Review this expense in Telegram — open Money Flow.”**. The same existing Telegram draft preview and confirmation controls are mirrored to the bot chat; do not create a Shortcut-specific review UI.
6. For a server-returned failure, say **«Не удалось занести расход. Добавьте его вручную в Telegram через Money Flow.»** / **“Could not save the expense. Add it manually in Money Flow on Telegram.”**.

Every branch must finish after its terminal spoken result: no follow-up question, alert, app-opening action, or `Open URL` action. This makes the Shortcut suitable for the lock screen: Apple documents that a Shortcut which opens an app while the device is locked requires an unlock. Keep the capture path to Dictate Text, the authenticated HTTPS request, conditionals, and spoken output; do not add an action that opens Money Flow or Telegram. Before publishing, test on a locked iPhone using the side button: invoke **«Занеси расход»** → prompt → dictate a clear expense → terminal Siri result, without unlocking or launching the Mini App.

The same `clientRequestId` must be retained after an unknown or lost HTTP response. A replay returns the original saved expense or review draft and does not run the parser, create a new financial fact, or send another Telegram output.

## Final publication and production handoff

This is a manual, production-authorized step and is not performed by the repository change:

1. On an iPhone, create and test the generic Shortcut above with a disposable key.
2. In Shortcuts, add the single Import Question, then run **Customize Shortcut** to verify that it is the only prompt and that the shared shortcut contains no filled key.
3. Share it with **Copy iCloud Link** and retain the resulting `https://www.icloud.com/shortcuts/...` URL.
4. With separate authorization, set that URL as production `IOS_SHORTCUT_URL` and deploy through the normal workflow.
5. Read `GET /api/quick-access` for a test account and confirm it returns the same `iosShortcutUrl`; then complete one safe capture and one review capture on an iPhone, including the locked side-button path. Verify a clear grocery capture such as **«Кефир 11 рублей»** auto-saves, says **«Занесено.»**, and mirrors exactly one existing saved-expense Telegram receipt.

The service accepts ordinary expense text only; it does not process bot commands, budget operations, photos, or server-side audio. The legacy draft confirm/cancel endpoints remain available for older Shortcut versions and review flows, but they are not part of the zero-friction safe path.
