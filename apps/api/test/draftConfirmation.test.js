import test from "node:test";
import assert from "node:assert/strict";

import { confirmDraftForApi } from "../src/draftConfirmation.js";

test("API draft confirmation returns saved expenses when the dashboard snapshot is unavailable", async () => {
  const messageUpdates = [];
  let explicitConfirmCalls = 0;
  const result = await confirmDraftForApi({
    repository: {
      async confirmDraftWithExplicitAcceptance() {
        explicitConfirmCalls += 1;
        return { expenses: [{ id: 1, amount_original: 80, currency_original: "THB", amount_base: 80, category_slug: "food_cafe", description: "coffee" }], dashboardSnapshot: null, alreadySaved: false };
      },
      async getDraftForTelegramUser() {
        return { tg_chat_id: 10, tg_message_id: 20 };
      }
    },
    draftId: 7,
    telegramUserId: 100,
    language: "en",
    token: "test-token",
    miniAppUrl: "http://localhost:3000",
    savedSummaryKeyboard: () => ({ inline_keyboard: [] }),
    async updateDraftMessageToSaved(message) { messageUpdates.push(message); },
    logger: { error() {} }
  });

  assert.equal(result.statusCode, 200);
  assert.equal(explicitConfirmCalls, 1);
  assert.deepEqual(result.body, {
    expenses: [{ id: 1, amount_original: 80, currency_original: "THB", amount_base: 80, category_slug: "food_cafe", description: "coffee" }],
    dashboardSnapshot: null,
    alreadySaved: false
  });
  assert.match(messageUpdates[0].text, /Budget summary is temporarily unavailable\./);
});
