export const BENCHMARK_REQUEST_FAILED = "benchmark_request_failed";

export async function runParserBenchmark({ corpus, variants, parse, runs = 1 }) {
  if (!Array.isArray(corpus) || !Array.isArray(variants) || typeof parse !== "function") {
    throw new TypeError("Invalid parser benchmark dependencies");
  }
  if (!Number.isInteger(runs) || runs <= 0) {
    throw new TypeError("Invalid parser benchmark run count");
  }

  const reports = [];
  for (const variant of variants) {
    const outcomes = [];
    const errors = [];
    for (let runIndex = 0; runIndex < runs; runIndex += 1) {
      for (const fixture of corpus) {
        try {
          const parsed = await parse({ model: variant.model, variant, fixture, runIndex });
          outcomes.push({ fixture, result: parsed?.result, llmHttpMs: finiteLatency(parsed?.llmHttpMs) });
        } catch (error) {
          outcomes.push({ fixture, result: null, llmHttpMs: finiteLatency(error?.llmHttpMs) });
          errors.push({ caseId: fixture.id, code: BENCHMARK_REQUEST_FAILED });
        }
      }
    }
    reports.push({
      model: variant.model,
      correctness: correctnessReport(outcomes),
      latency: latencyReport(outcomes),
      errors
    });
  }

  return { variants: reports };
}

function correctnessReport(outcomes) {
  return groupedReport(outcomes, scoreCorrectness);
}

function latencyReport(outcomes) {
  return groupedReport(outcomes, scoreLatency);
}

function groupedReport(outcomes, scorer) {
  const byLanguage = {};
  for (const language of [...new Set(outcomes.map(({ fixture }) => fixture.language))]) {
    byLanguage[language] = scorer(outcomes.filter(({ fixture }) => fixture.language === language));
  }
  return { overall: scorer(outcomes), byLanguage };
}

function scoreCorrectness(outcomes) {
  const critical = emptyScore();
  const reviewable = emptyScore();

  for (const { fixture, result } of outcomes) {
    const expected = fixture.expected.expenses;
    const actual = Array.isArray(result?.expenses) ? result.expenses : [];
    const criticalChecks = [{ field: "expense_count", correct: actual.length === expected.length }];
    const reviewableChecks = [];

    for (let index = 0; index < expected.length; index += 1) {
      const expectedExpense = expected[index];
      const actualExpense = actual[index];
      criticalChecks.push(
        { field: "amount", correct: Number(actualExpense?.amount) === Number(expectedExpense.amount) },
        { field: "currency", correct: actualExpense?.currency === expectedExpense.currency },
        {
          field: "local_calendar_day",
          correct: localCalendarDay(actualExpense?.spent_at, fixture.timeZone)
            === localCalendarDay(expectedExpense.spent_at, fixture.timeZone)
        },
        {
          field: "budget_impact",
          correct: normalizeBudgetImpact(actualExpense?.budget_impact)
            === normalizeBudgetImpact(expectedExpense.budget_impact)
        }
      );
      reviewableChecks.push(
        { field: "category_slug", correct: actualExpense?.category_slug === expectedExpense.category_slug },
        {
          field: "needs_review",
          correct: Boolean(actualExpense?.needs_review) === Boolean(expectedExpense.needs_review)
        }
      );
    }

    addCase(critical, criticalChecks);
    addCase(reviewable, reviewableChecks);
  }

  return {
    critical: finalizeScore(critical),
    reviewable: finalizeScore(reviewable)
  };
}

function emptyScore() {
  return { correctCases: 0, totalCases: 0, correctFields: 0, totalFields: 0, fields: {} };
}

function addCase(score, checks) {
  score.totalCases += 1;
  score.totalFields += checks.length;
  score.correctFields += checks.filter(({ correct }) => correct).length;
  for (const { field, correct } of checks) {
    score.fields[field] ??= { correct: 0, total: 0 };
    score.fields[field].total += 1;
    if (correct) score.fields[field].correct += 1;
  }
  if (checks.every(({ correct }) => correct)) score.correctCases += 1;
}

function finalizeScore(score) {
  return {
    correctCases: score.correctCases,
    totalCases: score.totalCases,
    caseAccuracy: ratio(score.correctCases, score.totalCases),
    correctFields: score.correctFields,
    totalFields: score.totalFields,
    fieldAccuracy: ratio(score.correctFields, score.totalFields),
    fields: Object.fromEntries(Object.entries(score.fields).map(([field, value]) => [field, {
      ...value,
      accuracy: ratio(value.correct, value.total)
    }]))
  };
}

function scoreLatency(outcomes) {
  const samples = outcomes
    .map(({ llmHttpMs }) => llmHttpMs)
    .filter(Number.isFinite)
    .sort((left, right) => left - right);
  return {
    sampleCount: samples.length,
    p50Ms: percentile(samples, 50),
    p95Ms: percentile(samples, 95)
  };
}

function percentile(sortedSamples, percentileValue) {
  if (sortedSamples.length === 0) return null;
  const index = Math.max(0, Math.ceil((percentileValue / 100) * sortedSamples.length) - 1);
  return sortedSamples[index];
}

function ratio(numerator, denominator) {
  return denominator === 0 ? null : numerator / denominator;
}

function finiteLatency(value) {
  const latency = Number(value);
  return Number.isFinite(latency) && latency >= 0 ? latency : null;
}

function normalizeBudgetImpact(value) {
  return value === "planned" || value === "large_oneoff" ? value : "regular";
}

function localCalendarDay(value, timeZone) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  try {
    const parts = new Intl.DateTimeFormat("en-CA", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit"
    }).formatToParts(date);
    const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
    return `${values.year}-${values.month}-${values.day}`;
  } catch {
    return null;
  }
}
