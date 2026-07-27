import test from "node:test";
import assert from "node:assert/strict";

import {
  CRITICAL_SHADOW_ADJUDICATION_SQL,
  assertSafeShadowAdjudicationSql,
  buildHistoricalShadowAdjudicationReport
} from "../src/shadowAdjudicationAudit.js";

test("historical critical disagreements stay unadjudicable without a durable draft correlation", () => {
  const report = buildHistoricalShadowAdjudicationReport([
    {
      input_type: "text",
      language: "unknown",
      acceptance_level: "local_safe",
      reject_reason: "none",
      result_category: "unadjudicable",
      critical_disagreement_count: 3,
      amount_disagreement_count: 2,
      currency_disagreement_count: 0,
      expense_count_disagreement_count: 1,
      local_calendar_day_disagreement_count: 1,
      budget_impact_disagreement_count: 1
    }
  ], { sourceKind: "local-copy" });

  assert.deepEqual(report, {
    schemaVersion: 1,
    sourceKind: "local-copy",
    historicalCorrelation: "unavailable",
    resultCategories: { local_match: 0, llm_match: 0, neither_match: 0, unadjudicable: 3 },
    lifecycleCounts: { confirmed: 0, cancelled: 0, unconfirmed: 0, unlinked: 3 },
    criticalFieldCounts: {
      amount: 2,
      currency: 0,
      expense_count: 1,
      local_calendar_day: 1,
      budget_impact: 1
    },
    groups: [{
      inputType: "text",
      language: "unknown",
      acceptanceLevel: "local_safe",
      rejectReason: "none",
      resultCategory: "unadjudicable",
      count: 3
    }]
  });
});

test("historical report drops unknown grouping values and never exposes financial values", () => {
  const report = buildHistoricalShadowAdjudicationReport([
    {
      input_type: "unexpected input",
      language: "ru",
      acceptance_level: "unsafe",
      reject_reason: "unrecognized_enum",
      result_category: "local_match",
      critical_disagreement_count: 2,
      amount_disagreement_count: 1,
      currency_disagreement_count: 1,
      expense_count_disagreement_count: 1,
      local_calendar_day_disagreement_count: 1,
      budget_impact_disagreement_count: 1
    }
  ]);

  assert.deepEqual(report.groups, [{
    inputType: "unknown",
    language: "ru",
    acceptanceLevel: "unknown",
    rejectReason: "unknown",
    resultCategory: "unadjudicable",
    count: 2
  }]);
  assert.equal(JSON.stringify(report).includes("unrecognized_enum"), false);
  assert.equal(report.resultCategories.local_match, 0);
});

test("fixed historical query reads only aggregate-safe event metadata", () => {
  assert.equal(assertSafeShadowAdjudicationSql(CRITICAL_SHADOW_ADJUDICATION_SQL), CRITICAL_SHADOW_ADJUDICATION_SQL);
  assert.match(CRITICAL_SHADOW_ADJUDICATION_SQL, /message_processing_completed/);
  assert.match(CRITICAL_SHADOW_ADJUDICATION_SQL, /WITH critical_shadow_events/);
  assert.doesNotMatch(CRITICAL_SHADOW_ADJUDICATION_SQL, /source_text|description|amount_original|currency_original|telegram|user_id|\bitems\b/iu);
});
