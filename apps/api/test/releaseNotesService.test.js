import test from "node:test";
import assert from "node:assert/strict";

import {
  MAX_BULLETS,
  MAX_BULLET_CHARS,
  MAX_MESSAGE_CHARS,
  createReleaseNotesService,
  formatReleaseDigest,
  hiddenReleaseNoteLabel,
  normalizeReleaseNoteInput,
  selectDigestReleaseNotes,
  validateReleaseNoteContent,
  validateReleaseNoteInput
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

  assert.match(formatReleaseDigest([note], "ru"), /Что нового:/);
  assert.match(formatReleaseDigest([note], "ru"), /• Онбординг стал проще/);
  assert.match(formatReleaseDigest([note], "fr"), /Что нового:/);
});

test("digest uses English text for en users", () => {
  const text = formatReleaseDigest([{
    version: "v.1.18",
    body_ru: "Онбординг стал проще.",
    body_en: "Onboarding is now simpler.\nVoice works too."
  }], "en");

  assert.match(text, /What's new:/);
  assert.match(text, /• Onboarding is now simpler/);
  assert.match(text, /• Voice works too/);
});

test("digest uses the latest selected note version", () => {
  const text = formatReleaseDigest([
    releaseNote({ id: 1, version: "v.1.18" }),
    releaseNote({ id: 2, version: "v.1.19" })
  ], "ru");

  assert.match(text, /Money Flow v\.1\.19/);
  assert.doesNotMatch(text, /Money Flow v\.1\.18/);
});

test("digest does not reuse an earlier version when the last note has none", () => {
  const text = formatReleaseDigest([
    releaseNote({ id: 1, version: "v.1.19" }),
    releaseNote({ id: 2, version: null })
  ], "ru");

  assert.match(text, /^✨ Money Flow$/m);
  assert.doesNotMatch(text, /v\.1\.19/);
});

test("English digest falls back to Russian text", () => {
  const text = formatReleaseDigest([releaseNote({ body_en: null })], "en");

  assert.match(text, /What's new:/);
  assert.match(text, /Онбординг стал проще/);
  assert.ok(text.length <= MAX_MESSAGE_CHARS);
});

test("English digest falls back to Russian text when English body is blank", () => {
  const text = formatReleaseDigest([releaseNote({ body_en: " \n\t " })], "en");

  assert.match(text, /Онбординг стал проще/);
});

test("release digest exports compact message limits", () => {
  assert.equal(MAX_BULLETS, 6);
  assert.equal(MAX_BULLET_CHARS, 120);
  assert.equal(MAX_MESSAGE_CHARS, 900);
});

test("release note content accepts up to six RU and EN bullets", () => {
  const input = {
    bodyRu: Array.from({ length: 6 }, (_, index) => `Улучшение ${index + 1}.`).join("\n"),
    bodyEn: Array.from({ length: 6 }, (_, index) => `Improvement ${index + 1}.`).join("\n")
  };

  assert.equal(validateReleaseNoteContent(input), input);
});

test("release note content requires at least one nonblank Russian bullet", () => {
  assert.throws(
    () => validateReleaseNoteContent({
      bodyRu: " \n\t ",
      bodyEn: "Visible English text."
    }),
    /RU release notes require at least one bullet/
  );
});

test("release note content rejects more than six lines", () => {
  assert.throws(
    () => validateReleaseNoteContent({
      bodyRu: Array.from({ length: 7 }, (_, index) => `Улучшение ${index + 1}.`).join("\n"),
      bodyEn: "Short."
    }),
    /RU release notes exceed 6 bullets/
  );
});

test("release note content rejects bullets over 120 characters", () => {
  assert.throws(
    () => validateReleaseNoteContent({
      bodyRu: "а".repeat(121),
      bodyEn: "Short."
    }),
    /RU release note bullet exceeds 120 characters/
  );
});

test("release note bullet limits count visible Unicode graphemes", () => {
  const familyEmoji = "👨‍👩‍👧‍👦";
  const accepted = {
    bodyRu: familyEmoji.repeat(120),
    bodyEn: "Short."
  };

  assert.equal(validateReleaseNoteContent(accepted), accepted);
  assert.throws(
    () => validateReleaseNoteContent({
      bodyRu: familyEmoji.repeat(121),
      bodyEn: "Short."
    }),
    /RU release note bullet exceeds 120 characters/
  );
});

test("selectDigestReleaseNotes keeps a seventh note pending", () => {
  const notes = Array.from({ length: 7 }, (_, index) => releaseNote({
    id: index + 1,
    body_ru: `Улучшение ${index + 1}.`,
    body_en: `Improvement ${index + 1}.`
  }));

  const selected = selectDigestReleaseNotes(notes);

  assert.deepEqual(selected.map((note) => note.id), [1, 2, 3, 4, 5, 6]);
});

test("selectDigestReleaseNotes rejects stored notes with oversized bullets", () => {
  assert.throws(
    () => selectDigestReleaseNotes([
      releaseNote({ body_ru: "а".repeat(121) })
    ]),
    /RU release note bullet exceeds 120 characters/
  );
});

test("selectDigestReleaseNotes does not split a note at the English bullet limit", () => {
  const notes = [
    releaseNote({
      id: 1,
      body_ru: "Первое улучшение.",
      body_en: Array.from({ length: 5 }, (_, index) => `Improvement ${index + 1}.`).join("\n")
    }),
    releaseNote({
      id: 2,
      body_ru: "Второе улучшение.",
      body_en: "Improvement 6.\nImprovement 7."
    })
  ];

  assert.deepEqual(selectDigestReleaseNotes(notes).map((note) => note.id), [1]);
});

test("selectDigestReleaseNotes keeps a whole note pending when either message exceeds 900 chars", () => {
  const notes = [
    releaseNote({
      id: 1,
      body_ru: "Короткое улучшение.",
      body_en: "A".repeat(120)
    }),
    releaseNote({
      id: 2,
      version: "v.1234567890".repeat(70),
      body_ru: "Ещё одно улучшение.",
      body_en: "Another improvement."
    })
  ];

  const selected = selectDigestReleaseNotes(notes);

  assert.deepEqual(selected.map((note) => note.id), [1]);
  assert.ok(formatReleaseDigest(selected, "ru").length <= MAX_MESSAGE_CHARS);
  assert.ok(formatReleaseDigest(selected, "en").length <= MAX_MESSAGE_CHARS);
});

test("selectDigestReleaseNotes counts digest length in visible Unicode graphemes", () => {
  const selected = selectDigestReleaseNotes([
    releaseNote({
      version: `v.${"👨‍👩‍👧‍👦".repeat(820)}`,
      body_ru: "Короткое улучшение.",
      body_en: "Short improvement."
    })
  ]);

  assert.equal(selected.length, 1);
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

test("release notes service rejects invalid content before repository insert", async () => {
  let repositoryCalls = 0;
  const service = createReleaseNotesService({
    repository: {
      async createReleaseNote() {
        repositoryCalls += 1;
      }
    }
  });

  await assert.rejects(
    service.createReleaseNote({
      version: "v.1.18",
      titleRu: "Пустая заметка",
      bodyRu: " \n ",
      bodyEn: "English only."
    }),
    /RU release notes require at least one bullet/
  );
  assert.equal(repositoryCalls, 0);
});

test("complete release note validation rejects rendered messages over 900 characters", () => {
  const normalized = normalizeReleaseNoteInput({
    version: `v.${"x".repeat(900)}`,
    titleRu: "Короткий заголовок",
    titleEn: "Short title",
    bodyRu: "Короткое улучшение.",
    bodyEn: "Short improvement."
  });

  assert.throws(
    () => validateReleaseNoteInput(normalized),
    /release digest exceeds 900 characters/
  );
});

test("release notes service rejects oversized rendered messages before repository insert", async () => {
  let repositoryCalls = 0;
  const service = createReleaseNotesService({
    repository: {
      async createReleaseNote() {
        repositoryCalls += 1;
      }
    }
  });

  await assert.rejects(
    service.createReleaseNote({
      version: `v.${"x".repeat(900)}`,
      titleRu: "Короткий заголовок",
      titleEn: "Short title",
      bodyRu: "Короткое улучшение.",
      bodyEn: "Short improvement."
    }),
    /release digest exceeds 900 characters/
  );
  assert.equal(repositoryCalls, 0);
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
  assert.match(sent[0].text, /Что нового:/);
  assert.match(sent[1].text, /What's new:/);
  assert.match(sent[2].text, /Что нового:/);
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
  assert.match(preview.text, /Что нового:/);
  assert.match(preview.text, /Скрыто из пользовательского пуша:/);
  assert.match(preview.text, /admin: добавлена \/admin_stats/);
});

test("send since last run creates a skipped run when no public notes exist", async () => {
  const repo = fakeReleaseRepository({ notes: [] });
  const service = createReleaseNotesService({
    repository: repo,
    sendMessage: async () => {
      throw new Error("must not send");
    }
  });

  const result = await service.sendReleaseDigestSinceLastRun(
    new Date("2026-06-19T14:00:00Z"),
    { trigger: "auto", timezone: "Asia/Bangkok", localDate: "2026-06-19" }
  );

  assert.equal(result.sent, false);
  assert.equal(result.reason, "no_public_release_notes");
  assert.equal(repo.createdRuns.length, 1);
  assert.deepEqual(repo.skippedRuns, [[1, "no_public_release_notes"]]);
});

test("duplicate automatic run exits without sending", async () => {
  const sent = [];
  const repo = fakeReleaseRepository({
    notes: [releaseNote()],
    duplicateAutoRun: true
  });
  const service = createReleaseNotesService({
    repository: repo,
    sendMessage: async (message) => sent.push(message)
  });

  const result = await service.sendReleaseDigestSinceLastRun(
    new Date("2026-06-19T14:00:00Z"),
    { trigger: "auto", timezone: "Asia/Bangkok", localDate: "2026-06-19" }
  );

  assert.equal(result.sent, false);
  assert.equal(result.reason, "duplicate_auto_run");
  assert.equal(sent.length, 0);
  assert.equal(repo.successRuns.length, 0);
  assert.equal(repo.failedRuns.length, 0);
});

test("send since last run sends one combined localized message per user", async () => {
  const sent = [];
  const notes = [
    releaseNote({ id: 1, version: "v.1.19", body_ru: "Первое улучшение.", body_en: "First improvement." }),
    releaseNote({ id: 2, version: "v.1.20", body_ru: "Второе улучшение.", body_en: "Second improvement." })
  ];
  const repo = fakeReleaseRepository({
    notes,
    users: [
      { id: 1, telegram_user_id: 100, interface_language: "ru" },
      { id: 2, telegram_user_id: 200, interface_language: "en" }
    ]
  });
  const service = createReleaseNotesService({
    repository: repo,
    sendMessage: async (message) => sent.push(message)
  });

  const result = await service.sendReleaseDigestSinceLastRun(
    new Date("2026-06-19T14:00:00Z"),
    { trigger: "manual", timezone: "Asia/Bangkok", localDate: "2026-06-19" }
  );

  assert.equal(sent.length, 2);
  assert.match(sent[0].text, /Первое улучшение/);
  assert.match(sent[0].text, /Второе улучшение/);
  assert.match(sent[1].text, /First improvement/);
  assert.match(sent[1].text, /Second improvement/);
  assert.deepEqual(repo.deliveries, [[1, 1], [2, 1], [1, 2], [2, 2]]);
  assert.deepEqual(repo.sentNotes, [1, 2]);
  assert.deepEqual(
    {
      notes: result.notes,
      versionFrom: result.versionFrom,
      versionTo: result.versionTo,
      users: result.users,
      success: result.success,
      errors: result.errors,
      blocked: result.blocked
    },
    {
      notes: 2,
      versionFrom: "v.1.19",
      versionTo: "v.1.20",
      users: 2,
      success: 2,
      errors: 0,
      blocked: 0
    }
  );
  assert.equal(repo.successRuns.length, 1);
});

test("send since last run leaves compact overflow pending", async () => {
  const notes = Array.from({ length: 7 }, (_, index) => releaseNote({
    id: index + 1,
    version: `v.1.${19 + index}`,
    body_ru: `Улучшение ${index + 1}.`,
    body_en: `Improvement ${index + 1}.`
  }));
  const repo = fakeReleaseRepository({
    notes,
    users: [{ id: 1, telegram_user_id: 100, interface_language: "ru" }]
  });
  const service = createReleaseNotesService({
    repository: repo,
    sendMessage: async () => ({ ok: true })
  });

  const result = await service.sendReleaseDigestSinceLastRun(
    new Date("2026-06-19T14:00:00Z"),
    { trigger: "manual", timezone: "Asia/Bangkok", localDate: "2026-06-19" }
  );

  assert.equal(result.notes, 6);
  assert.deepEqual(repo.sentNotes, [1, 2, 3, 4, 5, 6]);
  assert.equal(repo.existingDeliveries.has("7:1"), false);
});

test("partially delivered user receives only missing notes in one message", async () => {
  const sent = [];
  const repo = fakeReleaseRepository({
    notes: [
      releaseNote({ id: 1, body_ru: "Уже доставлено.", body_en: "Already delivered." }),
      releaseNote({ id: 2, version: "v.1.19", body_ru: "Ещё не доставлено.", body_en: "Still pending." })
    ],
    users: [{ id: 1, telegram_user_id: 100, interface_language: "ru" }],
    existingDeliveries: new Set(["1:1"])
  });
  const service = createReleaseNotesService({
    repository: repo,
    sendMessage: async (message) => sent.push(message)
  });

  const result = await service.sendReleaseDigestSinceLastRun(new Date("2026-06-19T14:00:00Z"));

  assert.equal(sent.length, 1);
  assert.doesNotMatch(sent[0].text, /Уже доставлено/);
  assert.match(sent[0].text, /Ещё не доставлено/);
  assert.deepEqual(repo.deliveries, [[2, 1]]);
  assert.equal(result.success, 1);
});

test("failed delivery is retried without resending successful deliveries", async () => {
  const sent = [];
  const repo = fakeReleaseRepository({
    notes: [releaseNote()],
    users: [
      { id: 1, telegram_user_id: 100, interface_language: "ru" },
      { id: 2, telegram_user_id: 200, interface_language: "ru" }
    ]
  });
  let failFirstUser = true;
  const service = createReleaseNotesService({
    repository: repo,
    sendMessage: async (message) => {
      sent.push(message.chatId);
      if (message.chatId === 100 && failFirstUser) {
        failFirstUser = false;
        throw new Error("temporary failure");
      }
    }
  });

  const first = await service.sendReleaseDigestSinceLastRun(new Date("2026-06-19T14:00:00Z"));
  const second = await service.sendReleaseDigestSinceLastRun(new Date("2026-06-19T15:00:00Z"));

  assert.equal(first.errors, 1);
  assert.equal(repo.failedRuns.length, 1);
  assert.equal(second.errors, 0);
  assert.deepEqual(sent, [100, 200, 100]);
  assert.deepEqual(repo.deliveries, [[1, 2], [1, 1]]);
  assert.deepEqual(repo.sentNotes, [1]);
  assert.equal(repo.successRuns.length, 1);
});

test("blocked users are marked without failing the digest run", async () => {
  const blockedError = Object.assign(
    new Error("Telegram sendMessage failed: 403 Forbidden: bot was blocked by the user"),
    {
      status: 403,
      body: JSON.stringify({ description: "Forbidden: bot was blocked by the user" })
    }
  );
  const repo = fakeReleaseRepository({
    notes: [releaseNote()],
    users: [{ id: 1, telegram_user_id: 100, interface_language: "ru" }]
  });
  const service = createReleaseNotesService({
    repository: repo,
    sendMessage: async () => {
      throw blockedError;
    }
  });

  const result = await service.sendReleaseDigestSinceLastRun(new Date("2026-06-19T14:00:00Z"));

  assert.equal(result.errors, 1);
  assert.equal(result.blocked, 1);
  assert.deepEqual(repo.blockedUsers, [1]);
  assert.equal(repo.failedRuns.length, 0);
  assert.equal(repo.successRuns.length, 1);
  assert.deepEqual(repo.sentNotes, [1]);
});

test("missing sender marks an already-created digest run as failed", async () => {
  const repo = fakeReleaseRepository({ notes: [releaseNote()] });
  const service = createReleaseNotesService({ repository: repo });

  await assert.rejects(
    service.sendReleaseDigestSinceLastRun(new Date("2026-06-19T14:00:00Z")),
    /sendMessage is required/
  );

  assert.equal(repo.createdRuns.length, 1);
  assert.equal(repo.failedRuns.length, 1);
  assert.equal(repo.failedRuns[0][1], "sendMessage is required");
});

test("preview shows period localized messages hidden notes and missing EN warning without side effects", async () => {
  const repo = fakeReleaseRepository({
    lastRun: { sent_to: new Date("2026-06-18T14:00:00Z") },
    notes: [releaseNote({ body_en: null })],
    hiddenNotes: [{ audience: "internal", title_ru: "Техническое изменение" }]
  });
  const service = createReleaseNotesService({ repository: repo });

  const preview = await service.previewReleaseDigestSinceLastRun(
    new Date("2026-06-19T14:00:00Z")
  );

  assert.match(preview.text, /RU preview:/);
  assert.match(preview.text, /EN preview:/);
  assert.match(preview.text, /2026-06-18 14:00/);
  assert.match(preview.text, /internal: Техническое изменение/);
  assert.match(preview.text, /нет EN-текста/);
  assert.equal(repo.createdRuns.length, 0);
  assert.deepEqual(repo.deliveries, []);
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
  const existingDeliveries = new Set(options.existingDeliveries ?? []);
  return {
    existingDeliveries,
    deliveries: [],
    sentNotes: [],
    blockedUsers: [],
    createdRuns: [],
    successRuns: [],
    failedRuns: [],
    skippedRuns: [],
    async createReleaseNote(input) {
      return { id: 1, ...input };
    },
    async getTodayUnsentPublicReleaseNotes() {
      return options.notes ?? [];
    },
    async getTodayHiddenReleaseNotes() {
      return options.hiddenNotes ?? [];
    },
    async getLastSuccessfulReleaseDigestRun() {
      return options.lastRun ?? null;
    },
    async getUnsentPublicReleaseNotesSince() {
      return options.notes ?? [];
    },
    async getHiddenReleaseNotesSince() {
      return options.hiddenNotes ?? [];
    },
    async createReleaseDigestRun(input) {
      this.createdRuns.push(input);
      if (options.duplicateAutoRun) return null;
      return { id: this.createdRuns.length, ...input };
    },
    async markReleaseDigestRunSuccess(id, summary) {
      this.successRuns.push([id, { ...summary }]);
    },
    async markReleaseDigestRunFailed(id, error, summary) {
      this.failedRuns.push([id, error.message, { ...summary }]);
    },
    async markReleaseDigestRunSkipped(id, reason) {
      this.skippedRuns.push([id, reason]);
    },
    async getActiveUsersForReleasePush() {
      return options.users ?? [];
    },
    async hasReleaseNoteDelivery(releaseNoteId, userId) {
      return existingDeliveries.has(`${releaseNoteId}:${userId}`);
    },
    async markReleaseNoteDelivered(releaseNoteId, userId) {
      existingDeliveries.add(`${releaseNoteId}:${userId}`);
      this.deliveries.push([releaseNoteId, userId]);
    },
    async countMissingReleaseNoteDeliveries(releaseNoteId) {
      return (options.users ?? []).filter((user) => (
        !this.blockedUsers.includes(user.id) &&
        !existingDeliveries.has(`${releaseNoteId}:${user.id}`)
      )).length;
    },
    async markReleaseNoteSent(releaseNoteId) {
      this.sentNotes.push(releaseNoteId);
    },
    async markUserBotBlocked(userId) {
      this.blockedUsers.push(userId);
    }
  };
}
