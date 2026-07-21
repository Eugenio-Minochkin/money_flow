import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { EXPENSE_PARSER_BENCHMARK_CORPUS } from "../../../packages/shared/testFixtures/expense-parser-benchmark-corpus.js";
import { createExpenseParser } from "../src/expenseParser.js";
import { BENCHMARK_REQUEST_FAILED, runParserBenchmark } from "../src/parserBenchmark.js";

const DEFAULT_CURRENT_MODEL = "gpt-5-mini";
const DEFAULT_CANDIDATE_MODEL = "gpt-5-nano";
const MAX_MODEL_ID_LENGTH = 100;
const MAX_RUNS = 20;
const SAFE_MODEL_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/;

export function parseBenchmarkArgs(argv = [], env = {}) {
  const parsed = {
    currentModel: env.OPENAI_MODEL ?? DEFAULT_CURRENT_MODEL,
    candidateModel: DEFAULT_CANDIDATE_MODEL,
    runs: 1
  };

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    const value = argv[index + 1];
    if (argument === "--current-model") parsed.currentModel = value;
    else if (argument === "--candidate-model") parsed.candidateModel = value;
    else if (argument === "--runs") parsed.runs = parseRuns(value);
    else throw safeError("benchmark_invalid_arguments");
    index += 1;
  }

  if (!isSafeModelId(parsed.currentModel)
    || !isSafeModelId(parsed.candidateModel)
    || parsed.currentModel === parsed.candidateModel
    || !Number.isInteger(parsed.runs)
    || parsed.runs < 1
    || parsed.runs > MAX_RUNS) {
    throw safeError("benchmark_invalid_arguments");
  }
  return parsed;
}

export function createApiBenchmarkParser({
  apiKey,
  fetchImpl,
  createParser = createExpenseParser
}) {
  return async ({ model, fixture }) => {
    let trace;
    const parser = createParser({
      apiKey,
      model,
      fastPathMode: "off",
      fetchImpl,
      now: () => new Date(fixture.now)
    });
    try {
      const result = await parser.parse(fixture.input, {
        defaultCurrency: fixture.defaultCurrency,
        timeZone: fixture.timeZone,
        onLlmTrace(metadata) { trace = metadata; }
      });
      return { result, llmHttpMs: trace?.llmHttpMs };
    } catch {
      const error = safeError(BENCHMARK_REQUEST_FAILED);
      if (Number.isFinite(trace?.llmHttpMs)) error.llmHttpMs = trace.llmHttpMs;
      throw error;
    }
  };
}

export async function runBenchmarkCli({
  argv = process.argv.slice(2),
  env = process.env,
  corpus = EXPENSE_PARSER_BENCHMARK_CORPUS,
  fetchImpl = globalThis.fetch,
  createParser = createExpenseParser,
  writeStdout = (value) => process.stdout.write(value)
} = {}) {
  const options = parseBenchmarkArgs(argv, env);
  if (!env.OPENAI_API_KEY) throw safeError("benchmark_api_key_required");

  const report = await runParserBenchmark({
    corpus,
    variants: [
      { model: options.currentModel },
      { model: options.candidateModel }
    ],
    runs: options.runs,
    parse: createApiBenchmarkParser({
      apiKey: env.OPENAI_API_KEY,
      fetchImpl,
      createParser
    })
  });
  writeStdout(`${JSON.stringify(report)}\n`);
  return report;
}

function parseRuns(value) {
  if (!/^\d+$/.test(String(value ?? ""))) throw safeError("benchmark_invalid_arguments");
  return Number(value);
}

function isSafeModelId(value) {
  return typeof value === "string"
    && value.length > 0
    && value.length <= MAX_MODEL_ID_LENGTH
    && SAFE_MODEL_ID.test(value);
}

function safeError(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

function isMainModule() {
  return Boolean(process.argv[1])
    && resolve(fileURLToPath(import.meta.url)) === resolve(process.argv[1]);
}

if (isMainModule()) {
  runBenchmarkCli().catch((error) => {
    const safeCodes = new Set(["benchmark_invalid_arguments", "benchmark_api_key_required"]);
    const code = safeCodes.has(error?.code) ? error.code : "benchmark_failed";
    process.stderr.write(`${code}\n`);
    process.exitCode = 1;
  });
}
