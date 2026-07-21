import test from "node:test";
import assert from "node:assert/strict";

import {
  HISTORICAL_AUDIT_SQL,
  assertReadOnlyAuditSql,
  buildParserAuditReport,
  normalizeAuditThresholds
} from "../src/parserAudit.js";

test("audit thresholds default to privacy floors and only accept stricter overrides", () => {
  assert.deepEqual(normalizeAuditThresholds(), {
    minCount: 3,
    minDistinctUsers: 2,
    dominanceThreshold: 0.8
  });
  assert.deepEqual(normalizeAuditThresholds({
    minCount: 5,
    minDistinctUsers: 4,
    dominanceThreshold: 0.95
  }), {
    minCount: 5,
    minDistinctUsers: 4,
    dominanceThreshold: 0.95
  });

  assert.throws(() => normalizeAuditThresholds({ minCount: 2 }), /invalid_audit_thresholds/);
  assert.throws(() => normalizeAuditThresholds({ minDistinctUsers: 1 }), /invalid_audit_thresholds/);
  assert.throws(() => normalizeAuditThresholds({ dominanceThreshold: 0.79 }), /invalid_audit_thresholds/);
  assert.throws(() => normalizeAuditThresholds({ dominanceThreshold: 1.01 }), /invalid_audit_thresholds/);
});

test("audit report separates RU and EN and never serializes raw fields or identifiers", () => {
  const rows = [
    confirmedRow({
      draftId: "draft-secret-1",
      userId: "telegram-111111",
      sourceText: "Кофейня Секрет 98765 https://private.example @hidden hidden@example.com",
      description: "Кофейня Секрет",
      category: "food_cafe"
    }),
    confirmedRow({
      draftId: "draft-secret-2",
      userId: "telegram-222222",
      sourceText: "Кофейня Секрет 54321 private.example/private-account-path",
      description: "Кофейня Секрет",
      category: "food_cafe"
    }),
    confirmedRow({
      draftId: "draft-secret-3",
      userId: "telegram-111111",
      sourceText: "Кофейня Секрет 12345,@hiddeninside",
      description: "Кофейня Секрет",
      category: "food_cafe"
    }),
    confirmedRow({ userId: "user-a", sourceText: "airport shuttle 9000", description: "airport shuttle", category: "transport" }),
    confirmedRow({ userId: "user-b", sourceText: "airport shuttle 8000", description: "airport shuttle", category: "transport" }),
    confirmedRow({ userId: "user-a", sourceText: "airport shuttle 7000", description: "airport shuttle", category: "transport" }),
    confirmedRow({ userId: "rare-user", sourceText: "private doctor 777", description: "private doctor", category: "health" }),
    confirmedRow({ userId: "rare-user", sourceText: "private doctor 888", description: "private doctor", category: "health" }),
    confirmedRow({ userId: "u1", sourceText: "coded token 101", description: "coded token", category: "private_identifier_555" }),
    confirmedRow({ userId: "u2", sourceText: "coded token 202", description: "coded token", category: "private_identifier_555" }),
    confirmedRow({ userId: "u1", sourceText: "coded token 303", description: "coded token", category: "private_identifier_555" })
  ];

  const report = buildParserAuditReport(rows, { sourceKind: "local-copy" });
  const serialized = JSON.stringify(report);

  assert.equal(report.sourceKind, "local-copy");
  assert.equal(report.schemaVersion, 2);
  const merchantCandidate = report.candidates.ru.find((candidate) => candidate.phrase === "кофейня секрет");
  assert.ok(merchantCandidate);
  assert.equal(merchantCandidate.decision, "manual_review");
  assert.ok(report.candidates.en.some((candidate) => candidate.phrase === "airport shuttle"));
  assert.ok(!serialized.includes("private doctor"));

  for (const forbidden of [
    "98765", "54321", "12345", "111111", "222222",
    "private.example", "private-account-path", "@hidden", "hiddeninside", "hidden@example.com",
    "private_identifier_555",
    "draft-secret", "telegram-", "source_text", "sourceText",
    "description", "items", "draft_id", "user_id"
  ]) {
    assert.ok(!serialized.includes(forbidden), `report leaked ${forbidden}`);
  }
});

test("source text contributes only bounded language and status counts", () => {
  const rows = [
    confirmedRow({ userId: "u1", sourceText: "такси 100 @secret", description: "taxi", category: "transport" }),
    confirmedRow({ userId: "u2", sourceText: "taxi 200 private-id", description: "taxi", category: "transport" }),
    unconfirmedRow({ userId: "u3", sourceText: "такси taxi 300", description: "coffee", itemCategory: "food_cafe", status: "pending" }),
    unconfirmedRow({ userId: "u4", sourceText: "https://secret.example 400 @hidden", description: "coffee", itemCategory: "food_cafe", status: "inbox" })
  ];

  const report = buildParserAuditReport(rows);

  assert.deepEqual(report.sourceSummary, {
    languageCounts: { ru: 1, en: 1, mixed: 1, unknown: 1 },
    statusCounts: { pending: 1, confirmed: 2, inbox: 1, cancelled: 0, unknown: 0 }
  });
  assert.ok(!JSON.stringify(report).includes("secret.example"));
});

test("source-only secrets never become candidates", () => {
  const rows = repeatedConfirmedRows(
    "sourceonlysecret 99999 @privatehandle",
    "transport",
    "source-secret",
    "taxi"
  );

  const report = buildParserAuditReport(rows);

  assert.ok(report.candidates.en.some((candidate) => candidate.phrase === "taxi"));
  assert.ok(!JSON.stringify(report).includes("sourceonlysecret"));
});

test("punctuated handles in source text never affect clean description candidates", () => {
  const rows = [
    confirmedRow({ userId: "u1", sourceText: "taxi (@secretname) 10", description: "taxi", category: "transport" }),
    confirmedRow({ userId: "u2", sourceText: "taxi (@secretname) 20", description: "taxi", category: "transport" }),
    confirmedRow({ userId: "u1", sourceText: "taxi (@secretname) 30", description: "taxi", category: "transport" })
  ];

  const report = buildParserAuditReport(rows);
  const serialized = JSON.stringify(report);
  const candidate = findCandidate(report, "en", "taxi");

  assert.equal(candidate.occurrenceCount, 3);
  assert.equal(candidate.distinctUsers, 2);
  assert.ok(!serialized.includes("secretname"));
});

test("audit report suppresses descriptions containing RU or EN word-number financial values", () => {
  const rows = [
    ...repeatedConfirmedRows("такси пять тысяч бат", "transport", "ru-word-amount"),
    ...repeatedConfirmedRows("taxi one hundred usd", "transport", "en-word-amount"),
    ...repeatedConfirmedRows("taxi two hundred dollars", "transport", "en-dollar-amount")
  ];

  const report = buildParserAuditReport(rows);
  const serialized = JSON.stringify(report);

  assert.ok(!report.candidates.ru.some((candidate) => candidate.phrase.includes("такси")));
  assert.ok(!report.candidates.en.some((candidate) => candidate.phrase.includes("taxi")));
  for (const forbidden of ["пять", "тысяч", "бат", "one", "two", "hundred", "usd", "dollars"]) {
    assert.ok(!serialized.includes(forbidden), `report leaked word amount token ${forbidden}`);
  }
});

test("audit report suppresses descriptions containing inflected one-thousand RU amounts", () => {
  const report = buildParserAuditReport(
    repeatedConfirmedRows("такси одну тысячу бат", "transport", "ru-one-thousand")
  );
  const serialized = JSON.stringify(report);

  assert.equal(report.candidates.ru.length, 0);
  assert.ok(!serialized.includes("одну"));
  assert.ok(!serialized.includes("тысячу"));
});

test("audit report suppresses descriptions containing inflected one-and-a-half-thousand RU amounts", () => {
  const report = buildParserAuditReport(
    repeatedConfirmedRows("такси полторы тысячи бат", "transport", "ru-one-half-thousand")
  );
  const serialized = JSON.stringify(report);

  assert.equal(report.candidates.ru.length, 0);
  assert.ok(!serialized.includes("полторы"));
  assert.ok(!serialized.includes("тысячи"));
});

test("audit report suppresses entire descriptions containing any sensitive marker", () => {
  const sensitiveDescriptions = [
    "такси полутора тысяч бат",
    "такси двухсот бат",
    "такси сорока бат",
    "taxi half thousand usd",
    "taxi 100",
    "taxi $",
    "taxi https://private.example",
    "taxi private@example.com",
    "taxi @secret",
    "taxi private_identifier",
    "taxi abcdefghijklmnopqrstuvwxyz"
  ];
  const rows = sensitiveDescriptions.flatMap((description, index) =>
    repeatedAlignedDescriptionRows(description, `sensitive-${index}`)
  );

  const report = buildParserAuditReport(rows);

  assert.deepEqual(report.candidates, { ru: [], en: [] });
});

test("audit report suppresses numeric words but preserves anchored prefix-similar ordinary words", () => {
  const rows = [
    ...repeatedConfirmedRows("студия одна", "health", "ordinary-one"),
    ...repeatedConfirmedRows("room one", "home", "ordinary-en-one"),
    ...repeatedConfirmedRows("кафе пятница 100 ref-1", "food_cafe", "ordinary-stem", "кафе пятница"),
    ...repeatedConfirmedRows("someone cafe 200 ref-2", "food_cafe", "ordinary-en-prefix", "someone cafe")
  ];

  const report = buildParserAuditReport(rows);

  assert.ok(!report.candidates.ru.some((candidate) => candidate.phrase.includes("студия")));
  assert.ok(!report.candidates.en.some((candidate) => candidate.phrase.includes("room")));
  assert.ok(report.candidates.ru.some((candidate) => candidate.phrase === "кафе пятница"));
  assert.ok(report.candidates.en.some((candidate) => candidate.phrase === "someone cafe"));
  assert.ok(!candidateTokens(report).has("одна"));
  assert.ok(!candidateTokens(report).has("one"));
});

test("audit report suppresses solitary implicit-currency number words", () => {
  const rows = [
    ...repeatedConfirmedRows("такси сто", "transport", "implicit-ru-hundred"),
    ...repeatedConfirmedRows("такси пять", "transport", "implicit-ru-five"),
    ...repeatedConfirmedRows("taxi five", "transport", "implicit-en-five")
  ];

  const report = buildParserAuditReport(rows);
  const tokens = candidateTokens(report);

  assert.equal(report.candidates.ru.length, 0);
  assert.equal(report.candidates.en.length, 0);
  assert.ok(!tokens.has("сто"));
  assert.ok(!tokens.has("пять"));
  assert.ok(!tokens.has("five"));
});

test("audit report still removes clear multiword amounts when default currency is implicit", () => {
  const report = buildParserAuditReport(
    repeatedConfirmedRows("taxi one hundred", "transport", "implicit-word-amount")
  );
  const serialized = JSON.stringify(report);

  assert.equal(report.candidates.en.length, 0);
  assert.ok(!serialized.includes("one"));
  assert.ok(!serialized.includes("hundred"));
});

test("category qualification never mixes confirmed and review-only evidence", () => {
  const rows = [
    confirmedRow({ userId: "u1", sourceText: "taxi 10", description: "taxi", category: "transport" }),
    unconfirmedRow({ userId: "u2", sourceText: "taxi 20", description: "taxi", itemCategory: "transport", status: "pending" }),
    unconfirmedRow({ userId: "u3", sourceText: "taxi 30", description: "taxi", itemCategory: "transport", status: "cancelled" })
  ];

  const report = buildParserAuditReport(rows);

  assert.ok(!report.candidates.en.some((candidate) => candidate.phrase === "taxi"));
  assert.equal(report.statusCounts.already_supported, 0);
});

test("confirmed drafts without a joined regular expense are excluded instead of becoming review-only", () => {
  const rows = ["u1", "u2", "u1"].map((userId, index) => ({
    draft_id: `large-oneoff-${index}`,
    user_id: userId,
    draft_status: "confirmed",
    source_text: `private yacht ${index + 100}`,
    items: [{ description: "private yacht", budget_impact: "large_oneoff" }],
    confirmed_expenses: []
  }));

  const report = buildParserAuditReport(rows);

  assert.ok(!report.candidates.en.some((candidate) => candidate.phrase === "private yacht"));
});

test("confirmed expenses are category truth while unconfirmed item categories stay review-only", () => {
  const rows = [
    confirmedRow({ userId: "u1", sourceText: "harbor shuttle 10", description: "harbor shuttle", itemCategory: "travel", category: "transport" }),
    confirmedRow({ userId: "u2", sourceText: "harbor shuttle 20", description: "harbor shuttle", itemCategory: "travel", category: "transport" }),
    confirmedRow({ userId: "u1", sourceText: "harbor shuttle 30", description: "harbor shuttle", itemCategory: "travel", category: "transport" }),
    unconfirmedRow({ userId: "u1", sourceText: "mystery kiosk 40", description: "mystery kiosk", itemCategory: "groceries", status: "pending" }),
    unconfirmedRow({ userId: "u2", sourceText: "mystery kiosk 50", description: "mystery kiosk", itemCategory: "transport", status: "inbox" }),
    unconfirmedRow({ userId: "u1", sourceText: "mystery kiosk 60", description: "mystery kiosk", itemCategory: "health", status: "cancelled" })
  ];

  const report = buildParserAuditReport(rows, { sourceKind: "read-replica" });
  const confirmed = findCandidate(report, "en", "harbor shuttle");
  const reviewOnly = findCandidate(report, "en", "mystery kiosk");

  assert.equal(confirmed.dominantCategory, "transport");
  assert.deepEqual(confirmed.categoryDistribution, { transport: 3 });
  assert.equal(reviewOnly.dominantCategory, null);
  assert.deepEqual(reviewOnly.categoryDistribution, {});
  assert.equal(reviewOnly.reviewOnlyCount, 3);
  assert.equal(reviewOnly.decision, "manual_review");
});

test("multi-expense drafts use ordinal mapping only when item and expense counts align", () => {
  const aligned = ["u1", "u2", "u1"].map((userId, index) => ({
    draft_id: `aligned-${index}`,
    user_id: userId,
    draft_status: "confirmed",
    source_text: `coffee and taxi ${index + 100}`,
    items: [
      { description: "coffee", category_slug: "other" },
      { description: "taxi", category_slug: "other" }
    ],
    confirmed_expenses: [
      { category_slug: "food_cafe" },
      { category_slug: "transport" }
    ]
  }));
  const mismatched = ["u1", "u2", "u1"].map((userId, index) => ({
    draft_id: `mismatch-${index}`,
    user_id: userId,
    draft_status: "confirmed",
    source_text: `shared outing ${index + 200}`,
    items: [
      { description: "museum" },
      { description: "taxi" }
    ],
    confirmed_expenses: [{ category_slug: "entertainment" }]
  }));

  const report = buildParserAuditReport([...aligned, ...mismatched]);

  assert.equal(findCandidate(report, "en", "coffee").dominantCategory, "food_cafe");
  assert.equal(findCandidate(report, "en", "taxi").dominantCategory, "transport");
  assert.ok(!report.candidates.en.some((candidate) => candidate.phrase === "shared outing"));
  assert.equal(report.ambiguousMappingCount, 3);
});

test("category dominance below the floor is rejected as ambiguous", () => {
  const rows = [
    confirmedRow({ userId: "u1", sourceText: "river ride 10", description: "river ride", category: "transport" }),
    confirmedRow({ userId: "u2", sourceText: "river ride 20", description: "river ride", category: "travel" }),
    confirmedRow({ userId: "u1", sourceText: "river ride 30", description: "river ride", category: "transport" })
  ];

  const candidate = findCandidate(buildParserAuditReport(rows), "en", "river ride");
  assert.equal(candidate.decision, "rejected_ambiguous");
  assert.equal(candidate.dominantCategory, "transport");
  assert.equal(candidate.dominance, 2 / 3);
});

test("historical audit SQL is a guarded fixed SELECT over regular drafts and confirmed expenses", () => {
  assert.doesNotThrow(() => assertReadOnlyAuditSql(HISTORICAL_AUDIT_SQL));
  assert.match(HISTORICAL_AUDIT_SQL, /^\s*SELECT\b/iu);
  assert.match(HISTORICAL_AUDIT_SQL, /d\.source_text/iu);
  assert.match(HISTORICAL_AUDIT_SQL, /d\.items/iu);
  assert.match(HISTORICAL_AUDIT_SQL, /expenses\s+e/iu);
  assert.match(HISTORICAL_AUDIT_SQL, /e\.draft_id\s*=\s*d\.id/iu);
  assert.match(HISTORICAL_AUDIT_SQL, /e\.budget_impact\s*=\s*'regular'/iu);
  assert.match(HISTORICAL_AUDIT_SQL, /d\.status\s*=\s*'confirmed'[\s\S]*e\.id\s+IS\s+NOT\s+NULL/iu);
  assert.doesNotMatch(HISTORICAL_AUDIT_SQL, /planned|topup|reserve/iu);

  for (const sql of [
    "SELECT 1; DELETE FROM drafts",
    "WITH changed AS (UPDATE drafts SET status = 'cancelled' RETURNING *) SELECT * FROM changed",
    "SELECT * FROM drafts FOR UPDATE"
  ]) {
    assert.throws(() => assertReadOnlyAuditSql(sql), /unsafe_audit_sql/);
  }
});

function confirmedRow({
  draftId = "draft-id",
  userId,
  sourceText,
  description,
  itemCategory = "other",
  category
}) {
  return {
    draft_id: draftId,
    user_id: userId,
    draft_status: "confirmed",
    source_text: sourceText,
    items: [{ description, category_slug: itemCategory }],
    confirmed_expenses: [{ category_slug: category }]
  };
}

function unconfirmedRow({ userId, sourceText, description, itemCategory, status }) {
  return {
    draft_id: "unconfirmed-draft",
    user_id: userId,
    draft_status: status,
    source_text: sourceText,
    items: [{ description, category_slug: itemCategory }],
    confirmed_expenses: []
  };
}

function repeatedConfirmedRows(sourceText, category, draftPrefix, description = sourceText) {
  return ["u1", "u2", "u1"].map((userId, index) => confirmedRow({
    draftId: `${draftPrefix}-${index}`,
    userId,
    sourceText,
    description,
    category
  }));
}

function repeatedAlignedDescriptionRows(description, draftPrefix) {
  return ["u1", "u2", "u1"].map((userId, index) => ({
    draft_id: `${draftPrefix}-${index}`,
    user_id: userId,
    draft_status: "confirmed",
    source_text: `${index + 100}`,
    items: [{ description }, { description }],
    confirmed_expenses: [{ category_slug: "transport" }, { category_slug: "transport" }]
  }));
}

function candidateTokens(report) {
  return new Set([...report.candidates.ru, ...report.candidates.en]
    .flatMap((candidate) => candidate.phrase.split(" ")));
}

function findCandidate(report, language, phrase) {
  const candidate = report.candidates[language].find((entry) => entry.phrase === phrase);
  assert.ok(candidate, `missing ${language} candidate: ${phrase}`);
  return candidate;
}
