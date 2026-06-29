import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

function readText(path) {
  return readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
}

function envExampleKeys(text) {
  return new Set(
    text
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line && !line.startsWith("#"))
      .map((line) => line.split("=", 1)[0])
  );
}

function composeApiEnvironment(text) {
  const environment = new Map();
  const lines = text.split(/\r?\n/);
  let inApi = false;
  let inEnvironment = false;
  let apiIndent = 0;
  let environmentIndent = 0;

  for (const line of lines) {
    const trimmed = line.trim();
    const indent = line.length - line.trimStart().length;

    if (/^api:\s*$/.test(trimmed)) {
      inApi = true;
      inEnvironment = false;
      apiIndent = indent;
      continue;
    }

    if (inApi && indent <= apiIndent && trimmed) {
      inApi = false;
      inEnvironment = false;
    }

    if (inApi && /^environment:\s*$/.test(trimmed)) {
      inEnvironment = true;
      environmentIndent = indent;
      continue;
    }

    if (inEnvironment && indent <= environmentIndent && trimmed) {
      inEnvironment = false;
    }

    if (!inEnvironment) {
      continue;
    }

    const match = trimmed.match(/^([A-Z0-9_]+):\s*(.*)$/);
    if (match) {
      environment.set(match[1], match[2]);
    }
  }

  return environment;
}

function configEnvKeys(text) {
  return new Set([...text.matchAll(/process\.env\.([A-Z0-9_]+)/g)].map((match) => match[1]));
}

test("critical production env keys from the example are passed to api container", () => {
  const envExample = envExampleKeys(readText(".env.production.example"));
  const composeEnv = composeApiEnvironment(readText("compose.prod.yml"));
  const configEnv = configEnvKeys(readText("apps/api/src/config.js"));
  const derivedOrInternalEnv = new Set(["DATABASE_URL", "MINI_APP_URL", "PORT"]);
  const criticalProductionEnv = [
    "EXPENSE_FAST_PATH_MODE",
    "DAILY_REMINDER_GLOBAL_ENABLED",
    "DAILY_REMINDER_ROLLOUT_PERCENT",
    "DAILY_REMINDER_INTERVAL_MS",
    "REQUIRE_TELEGRAM_INIT_DATA"
  ];

  for (const key of configEnv) {
    assert.ok(composeEnv.has(key), `${key} is read by config.js but missing from compose.prod.yml api environment`);

    if (!derivedOrInternalEnv.has(key)) {
      assert.ok(envExample.has(key), `${key} is read by config.js but missing from .env.production.example`);
    }
  }

  for (const key of criticalProductionEnv) {
    assert.ok(envExample.has(key), `${key} is missing from .env.production.example`);
    assert.ok(composeEnv.has(key), `${key} is missing from compose.prod.yml api environment`);
  }

  assert.equal(composeEnv.get("EXPENSE_FAST_PATH_MODE"), "${EXPENSE_FAST_PATH_MODE:-off}");
  assert.equal(composeEnv.get("DAILY_REMINDER_GLOBAL_ENABLED"), "${DAILY_REMINDER_GLOBAL_ENABLED:-false}");
  assert.equal(composeEnv.get("DAILY_REMINDER_ROLLOUT_PERCENT"), "${DAILY_REMINDER_ROLLOUT_PERCENT:-0}");
  assert.equal(composeEnv.get("REQUIRE_TELEGRAM_INIT_DATA"), "${REQUIRE_TELEGRAM_INIT_DATA:-true}");
});
