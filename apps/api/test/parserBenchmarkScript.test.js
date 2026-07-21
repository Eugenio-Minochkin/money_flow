import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

import { EXPENSE_PARSER_BENCHMARK_CORPUS } from "../../../packages/shared/testFixtures/expense-parser-benchmark-corpus.js";
import {
  createApiBenchmarkParser,
  parseBenchmarkArgs,
  runBenchmarkCli
} from "../scripts/benchmark-expense-parser.js";

test("argument parsing defaults current and candidate models without requiring an API key", () => {
  assert.deepEqual(parseBenchmarkArgs([], {}), {
    currentModel: "gpt-5-mini",
    candidateModel: "gpt-5-nano",
    runs: 1
  });
  assert.deepEqual(parseBenchmarkArgs([], { OPENAI_MODEL: "gpt-5-current" }), {
    currentModel: "gpt-5-current",
    candidateModel: "gpt-5-nano",
    runs: 1
  });
  assert.deepEqual(parseBenchmarkArgs([
    "--current-model", "gpt-5-a",
    "--candidate-model", "gpt-5-b",
    "--runs", "3"
  ], {}), {
    currentModel: "gpt-5-a",
    candidateModel: "gpt-5-b",
    runs: 3
  });
});

test("argument parsing rejects unsafe, equal, empty, overly long models and unbounded runs", () => {
  const invalidArgv = [
    ["--current-model", "same", "--candidate-model", "same"],
    ["--current-model", "", "--candidate-model", "candidate"],
    ["--current-model", "bad model", "--candidate-model", "candidate"],
    ["--current-model", "x".repeat(101), "--candidate-model", "candidate"],
    ["--runs", "0"],
    ["--runs", "21"],
    ["--runs", "1.5"],
    ["--unknown", "value"]
  ];

  for (const argv of invalidArgv) {
    assert.throws(() => parseBenchmarkArgs(argv, {}), { code: "benchmark_invalid_arguments" });
  }
});

test("API benchmark parser forces LLM-only routing and captures llmHttpMs", async () => {
  const fixture = EXPENSE_PARSER_BENCHMARK_CORPUS[0];
  const fetchImpl = async () => { throw new Error("must remain injected"); };
  const createCalls = [];
  const parseCalls = [];
  const parse = createApiBenchmarkParser({
    apiKey: "test-key",
    fetchImpl,
    createParser(options) {
      createCalls.push(options);
      return {
        async parse(input, parseOptions) {
          parseCalls.push({ input, parseOptions });
          parseOptions.onLlmTrace({ llmHttpMs: 17 });
          return fixture.expected;
        }
      };
    }
  });

  const parsed = await parse({ model: "gpt-5-test", fixture });

  assert.equal(createCalls.length, 1);
  assert.deepEqual(createCalls[0], {
    apiKey: "test-key",
    model: "gpt-5-test",
    fastPathMode: "off",
    fetchImpl,
    now: createCalls[0].now
  });
  assert.equal(createCalls[0].now().toISOString(), fixture.now);
  assert.equal(parseCalls[0].input, fixture.input);
  assert.equal(parseCalls[0].parseOptions.defaultCurrency, fixture.defaultCurrency);
  assert.equal(parseCalls[0].parseOptions.timeZone, fixture.timeZone);
  assert.deepEqual(parsed, { result: fixture.expected, llmHttpMs: 17 });
});

test("explicit CLI execution requires an API key and emits aggregate-only JSON", async () => {
  await assert.rejects(
    () => runBenchmarkCli({ argv: [], env: {}, writeStdout() {} }),
    { code: "benchmark_api_key_required" }
  );

  const fixture = EXPENSE_PARSER_BENCHMARK_CORPUS[0];
  const env = Object.freeze({ OPENAI_API_KEY: "test-key", OPENAI_MODEL: "gpt-5-current" });
  const createdModels = [];
  let stdout = "";
  const report = await runBenchmarkCli({
    argv: ["--runs", "2"],
    env,
    corpus: [fixture],
    fetchImpl: async () => { throw new Error("network must not be reached by the stub parser"); },
    createParser(options) {
      createdModels.push(modelAndMode(options));
      return {
        async parse(_input, parseOptions) {
          parseOptions.onLlmTrace({ llmHttpMs: options.model === "gpt-5-current" ? 25 : 12 });
          return fixture.expected;
        }
      };
    },
    writeStdout(value) { stdout += value; }
  });

  assert.deepEqual(new Set(createdModels.map(({ model }) => model)), new Set(["gpt-5-current", "gpt-5-nano"]));
  assert.ok(createdModels.every(({ fastPathMode }) => fastPathMode === "off"));
  assert.equal(report.variants[0].latency.overall.sampleCount, 2);
  assert.deepEqual(JSON.parse(stdout), report);
  assert.equal(stdout.includes(fixture.input), false);
  assert.equal(stdout.includes("test-key"), false);
});

test("CLI normalizes parser failures without exposing raw errors or fixture input", async () => {
  const fixture = EXPENSE_PARSER_BENCHMARK_CORPUS[0];
  const secret = "provider leaked a credential";
  let stdout = "";
  const report = await runBenchmarkCli({
    argv: [],
    env: { OPENAI_API_KEY: "test-key" },
    corpus: [fixture],
    createParser() {
      return {
        async parse() { throw new Error(secret); }
      };
    },
    fetchImpl: async () => { throw new Error("not called"); },
    writeStdout(value) { stdout += value; }
  });

  assert.deepEqual(report.variants[0].errors, [{ caseId: fixture.id, code: "benchmark_request_failed" }]);
  assert.equal(stdout.includes(secret), false);
  assert.equal(stdout.includes(fixture.input), false);
});

test("package exposes only the explicit parser benchmark command", async () => {
  const packageJson = JSON.parse(await readFile(new URL("../../../package.json", import.meta.url), "utf8"));
  assert.equal(packageJson.scripts["parser:benchmark:api"], "node apps/api/scripts/benchmark-expense-parser.js");
});

function modelAndMode(options) {
  return { model: options.model, fastPathMode: options.fastPathMode };
}
