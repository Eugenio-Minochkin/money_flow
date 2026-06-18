import test from "node:test";
import assert from "node:assert/strict";

import {
  createReleaseNotesService,
  formatReleaseDigest,
  hiddenReleaseNoteLabel,
  normalizeReleaseNoteInput
} from "../src/releaseNotesService.js";

test("release note input keeps explicit user audience", () => {
  const input = normalizeReleaseNoteInput({
    version: "v.1.18",
    titleRu: "Онбординг",
    titleEn: "Onboarding",
    bodyRu: "Онбординг стал проще.",
    bodyEn: "Onboarding is now simpler.",
    audience: "user",
    category: "admin"
  });

  assert.equal(input.audience, "user");
  assert.equal(input.category, "admin");
});

test("admin and internal categories default away from user audience", () => {
  assert.equal(normalizeReleaseNoteInput({ category: "admin" }).audience, "admin");
  assert.equal(normalizeReleaseNoteInput({ category: "internal" }).audience, "internal");
  assert.equal(normalizeReleaseNoteInput({ category: "infra" }).audience, "internal");
  assert.equal(normalizeReleaseNoteInput({ category: "analytics" }).audience, "internal");
  assert.equal(normalizeReleaseNoteInput({ category: "onboarding" }).audience, "user");
});

test("digest uses Russian text for ru and unknown languages", () => {
  const note = {
    version: "v.1.18",
    body_ru: "Онбординг стал проще.\nБюджет можно написать одной фразой.",
    body_en: "Onboarding is now simpler."
  };

  assert.match(formatReleaseDigest([note], "ru"), /Что изменилось сегодня/);
  assert.match(formatReleaseDigest([note], "ru"), /• Онбординг стал проще/);
  assert.match(formatReleaseDigest([note], "fr"), /Что изменилось сегодня/);
});

test("digest uses English text for en users", () => {
  const text = formatReleaseDigest([{
    version: "v.1.18",
    body_ru: "Онбординг стал проще.",
    body_en: "Onboarding is now simpler.\nVoice works too."
  }], "en");

  assert.match(text, /Today's updates/);
  assert.match(text, /• Onboarding is now simpler/);
  assert.match(text, /• Voice works too/);
});

test("hidden release note label includes audience and title", () => {
  assert.equal(
    hiddenReleaseNoteLabel({ audience: "admin", title_ru: "добавлена /admin_stats" }),
    "admin: добавлена /admin_stats"
  );
});

test("release notes service creates normalized release notes", async () => {
  const calls = [];
  const service = createReleaseNotesService({
    repository: {
      async createReleaseNote(input) {
        calls.push(input);
        return { id: 1, ...input };
      }
    }
  });

  const note = await service.createReleaseNote({
    version: "v.1.18",
    titleRu: "Админка",
    bodyRu: "Добавлена команда.",
    category: "admin"
  });

  assert.equal(note.audience, "admin");
  assert.equal(calls[0].isPublic, true);
});

test("send today does nothing when there are no public user notes", async () => {
  const sent = [];
  const repo = fakeReleaseRepository({ notes: [], hiddenNotes: [{ id: 2, audience: "admin" }] });
  const service = createReleaseNotesService({
    repository: repo,
    sendMessage: async (message) => sent.push(message)
  });

  const result = await service.sendTodayReleaseDigest(new Date("2026-06-15T18:00:00+07:00"));

  assert.equal(result.sent, false);
  assert.equal(result.reason, "no_public_release_notes");
  assert.equal(sent.length, 0);
});

test("sends localized digest to active users and defaults unknown language to Russian", async () => {
  const sent = [];
  const repo = fakeReleaseRepository({
    notes: [releaseNote()],
    users: [
      { id: 1, telegram_user_id: 100, interface_language: "ru" },
      { id: 2, telegram_user_id: 200, interface_language: "en" },
      { id: 3, telegram_user_id: 300, interface_language: "fr" }
    ]
  });
  const service = createReleaseNotesService({
    repository: repo,
    sendMessage: async (message) => sent.push(message)
  });

  const result = await service.sendTodayReleaseDigest(new Date("2026-06-15T18:00:00+07:00"));

  assert.equal(result.users, 3);
  assert.equal(result.success, 3);
  assert.match(sent[0].text, /Что изменилось сегодня/);
  assert.match(sent[1].text, /Today's updates/);
  assert.match(sent[2].text, /Что изменилось сегодня/);
  assert.deepEqual(repo.deliveries, [[1, 1], [1, 2], [1, 3]]);
  assert.deepEqual(repo.sentNotes, [1]);
});

test("repeated send skips existing release note delivery", async () => {
  const sent = [];
  const repo = fakeReleaseRepository({
    notes: [releaseNote()],
    users: [
      { id: 1, telegram_user_id: 100, interface_language: "ru" },
      { id: 2, telegram_user_id: 200, interface_language: "ru" }
    ],
    existingDeliveries: new Set(["1:1"])
  });
  const service = createReleaseNotesService({
    repository: repo,
    sendMessage: async (message) => sent.push(message)
  });

  const result = await service.sendTodayReleaseDigest(new Date("2026-06-15T18:00:00+07:00"));

  assert.equal(result.users, 2);
  assert.equal(result.success, 1);
  assert.equal(sent.length, 1);
  assert.deepEqual(repo.deliveries, [[1, 2]]);
});

test("one user send failure does not stop remaining users", async () => {
  const sent = [];
  const repo = fakeReleaseRepository({
    notes: [releaseNote()],
    users: [
      { id: 1, telegram_user_id: 100, interface_language: "ru" },
      { id: 2, telegram_user_id: 200, interface_language: "ru" }
    ]
  });
  const service = createReleaseNotesService({
    repository: repo,
    sendMessage: async (message) => {
      if (message.chatId === 100) throw new Error("temporary failure");
      sent.push(message);
    }
  });

  const result = await service.sendTodayReleaseDigest(new Date("2026-06-15T18:00:00+07:00"));

  assert.equal(result.success, 1);
  assert.equal(result.errors, 1);
  assert.equal(sent.length, 1);
  assert.deepEqual(repo.deliveries, [[1, 2]]);
  assert.deepEqual(repo.sentNotes, []);
});

test("blocked bot errors mark users as blocked", async () => {
  const error = new Error("Telegram sendMessage failed: 403 Forbidden: bot was blocked by the user");
  error.status = 403;
  error.body = JSON.stringify({ description: "Forbidden: bot was blocked by the user" });
  const repo = fakeReleaseRepository({
    notes: [releaseNote()],
    users: [{ id: 1, telegram_user_id: 100, interface_language: "ru" }]
  });
  const service = createReleaseNotesService({
    repository: repo,
    sendMessage: async () => {
      throw error;
    }
  });

  const result = await service.sendTodayReleaseDigest(new Date("2026-06-15T18:00:00+07:00"));

  assert.equal(result.blocked, 1);
  assert.equal(result.errors, 1);
  assert.deepEqual(repo.blockedUsers, [1]);
  assert.deepEqual(repo.deliveries, []);
  assert.deepEqual(repo.sentNotes, []);
});

test("preview includes user digest and hidden admin notes", async () => {
  const repo = fakeReleaseRepository({
    notes: [releaseNote()],
    hiddenNotes: [{ id: 2, audience: "admin", title_ru: "добавлена /admin_stats" }]
  });
  const service = createReleaseNotesService({ repository: repo });

  const preview = await service.previewTodayReleaseDigest(new Date("2026-06-15T18:00:00+07:00"));

  assert.match(preview.text, /Пользователям будет отправлено:/);
  assert.match(preview.text, /Что изменилось сегодня/);
  assert.match(preview.text, /Скрыто из пользовательского пуша:/);
  assert.match(preview.text, /admin: добавлена \/admin_stats/);
});

function releaseNote(patch = {}) {
  return {
    id: 1,
    version: "v.1.18",
    audience: "user",
    body_ru: "Онбординг стал проще.",
    body_en: "Onboarding is now simpler.",
    ...patch
  };
}

function fakeReleaseRepository(options = {}) {
  const existingDeliveries = options.existingDeliveries ?? new Set();
  return {
    deliveries: [],
    sentNotes: [],
    blockedUsers: [],
    async createReleaseNote(input) {
      return { id: 1, ...input };
    },
    async getTodayUnsentPublicReleaseNotes() {
      return options.notes ?? [];
    },
    async getTodayHiddenReleaseNotes() {
      return options.hiddenNotes ?? [];
    },
    async getActiveUsersForReleasePush() {
      return options.users ?? [];
    },
    async hasReleaseNoteDelivery(releaseNoteId, userId) {
      return existingDeliveries.has(`${releaseNoteId}:${userId}`);
    },
    async markReleaseNoteDelivered(releaseNoteId, userId) {
      this.deliveries.push([releaseNoteId, userId]);
    },
    async markReleaseNoteSent(releaseNoteId) {
      this.sentNotes.push(releaseNoteId);
    },
    async markUserBotBlocked(userId) {
      this.blockedUsers.push(userId);
    }
  };
}
