import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import pg from "pg";

import {
  CRITICAL_SHADOW_ADJUDICATION_SQL,
  assertSafeShadowAdjudicationSql,
  buildHistoricalShadowAdjudicationReport
} from "../src/shadowAdjudicationAudit.js";

const { Client } = pg;
const DEFAULT_STATEMENT_TIMEOUT_MS = 30_000;
const MAX_STATEMENT_TIMEOUT_MS = 120_000;
const VALID_SOURCES = new Set(["local-copy", "read-replica"]);
const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "::1"]);
const SAFE_ERROR_CODES = new Set([
  "invalid_shadow_adjudication_options",
  "missing_shadow_adjudication_database_url",
  "unsafe_shadow_adjudication_database_target",
  "unsafe_read_replica",
  "shadow_adjudication_execution_failed"
]);

class SafeShadowAdjudicationError extends Error {
  constructor(code) {
    super(code);
    this.name = "SafeShadowAdjudicationError";
    this.code = code;
  }
}

export function parseShadowAdjudicationArgs(args = []) {
  const values = new Map();
  const known = new Set(["source", "statement-timeout-ms"]);
  for (const arg of args) {
    const match = /^--([^=]+)=(.*)$/u.exec(String(arg));
    if (!match || !known.has(match[1]) || values.has(match[1])) {
      throw new SafeShadowAdjudicationError("invalid_shadow_adjudication_options");
    }
    values.set(match[1], match[2]);
  }
  const sourceKind = values.get("source");
  if (!VALID_SOURCES.has(sourceKind)) {
    throw new SafeShadowAdjudicationError("invalid_shadow_adjudication_options");
  }
  return {
    sourceKind,
    statementTimeoutMs: values.has("statement-timeout-ms")
      ? parseBoundedTimeout(values.get("statement-timeout-ms"))
      : DEFAULT_STATEMENT_TIMEOUT_MS
  };
}

export function resolveShadowAdjudicationConfiguration(args = [], env = {}) {
  let options;
  try {
    options = parseShadowAdjudicationArgs(args);
  } catch (error) {
    throw normalizeSafeError(error);
  }
  const databaseUrl = String(env.SHADOW_ADJUDICATION_DATABASE_URL ?? "").trim();
  if (!databaseUrl) throw new SafeShadowAdjudicationError("missing_shadow_adjudication_database_url");
  validateAuditDatabaseTarget(databaseUrl, options.sourceKind);
  return { ...options, databaseUrl };
}

export async function runHistoricalShadowAdjudicationAudit({
  clientFactory = ({ connectionString }) => new Client({ connectionString }),
  databaseUrl,
  sourceKind,
  statementTimeoutMs = DEFAULT_STATEMENT_TIMEOUT_MS
}) {
  try {
    validateAuditDatabaseTarget(databaseUrl, sourceKind);
    parseBoundedTimeout(String(statementTimeoutMs));
    assertSafeShadowAdjudicationSql(CRITICAL_SHADOW_ADJUDICATION_SQL);
  } catch (error) {
    throw normalizeSafeError(error);
  }

  let client;
  let transactionStarted = false;
  let report;
  let failure = null;
  try {
    client = clientFactory({ connectionString: databaseUrl });
    await client.connect();
    await client.query("BEGIN TRANSACTION READ ONLY");
    transactionStarted = true;
    await client.query(`SET LOCAL statement_timeout = ${statementTimeoutMs}`);
    if (sourceKind === "read-replica") await assertReadReplicaPosture(client);
    const result = await client.query(CRITICAL_SHADOW_ADJUDICATION_SQL);
    report = buildHistoricalShadowAdjudicationReport(result.rows, { sourceKind });
  } catch (error) {
    failure = normalizeSafeError(error);
  }

  if (transactionStarted) {
    try {
      await client.query("ROLLBACK");
    } catch {
      failure ??= new SafeShadowAdjudicationError("shadow_adjudication_execution_failed");
    }
  }
  if (client) {
    try {
      await client.end();
    } catch {
      failure ??= new SafeShadowAdjudicationError("shadow_adjudication_execution_failed");
    }
  }
  if (failure) throw failure;
  return report;
}

export async function runShadowAdjudicationAuditCli({
  argv = process.argv.slice(2),
  env = process.env,
  clientFactory,
  writeStdout = (value) => process.stdout.write(`${value}\n`),
  writeStderr = (value) => process.stderr.write(`${value}\n`)
} = {}) {
  try {
    const config = resolveShadowAdjudicationConfiguration(argv, env);
    const report = await runHistoricalShadowAdjudicationAudit({ ...config, clientFactory });
    writeStdout(JSON.stringify(report));
    return 0;
  } catch (error) {
    writeStderr(JSON.stringify({
      status: "error",
      code: safeErrorCode(error),
      message: "Shadow adjudication audit failed safely."
    }));
    return 1;
  }
}

async function assertReadReplicaPosture(client) {
  const defaultReadOnly = await client.query("SHOW default_transaction_read_only");
  const recovery = await client.query("SELECT pg_is_in_recovery() AS is_in_recovery");
  const isDefaultReadOnly = String(defaultReadOnly.rows?.[0]?.default_transaction_read_only ?? "").toLowerCase() === "on";
  const isInRecovery = recovery.rows?.[0]?.is_in_recovery === true;
  if (!isDefaultReadOnly && !isInRecovery) throw new SafeShadowAdjudicationError("unsafe_read_replica");
}

function validateAuditDatabaseTarget(databaseUrl, sourceKind) {
  if (!VALID_SOURCES.has(sourceKind)) {
    throw new SafeShadowAdjudicationError("unsafe_shadow_adjudication_database_target");
  }
  let parsed;
  try {
    parsed = new URL(String(databaseUrl));
  } catch {
    throw new SafeShadowAdjudicationError("unsafe_shadow_adjudication_database_target");
  }
  if (!['postgres:', 'postgresql:'].includes(parsed.protocol)) {
    throw new SafeShadowAdjudicationError("unsafe_shadow_adjudication_database_target");
  }
  const hostname = parsed.hostname.toLowerCase().replace(/^\[|\]$/gu, "");
  if (sourceKind === "local-copy" && !LOOPBACK_HOSTS.has(hostname)) {
    throw new SafeShadowAdjudicationError("unsafe_shadow_adjudication_database_target");
  }
}

function parseBoundedTimeout(value) {
  if (!/^\d+$/u.test(String(value))) {
    throw new SafeShadowAdjudicationError("invalid_shadow_adjudication_options");
  }
  const timeout = Number(value);
  if (!Number.isSafeInteger(timeout) || timeout <= 0 || timeout > MAX_STATEMENT_TIMEOUT_MS) {
    throw new SafeShadowAdjudicationError("invalid_shadow_adjudication_options");
  }
  return timeout;
}

function normalizeSafeError(error) {
  if (error instanceof SafeShadowAdjudicationError && SAFE_ERROR_CODES.has(error.code)) return error;
  return new SafeShadowAdjudicationError("shadow_adjudication_execution_failed");
}

function safeErrorCode(error) {
  return error instanceof SafeShadowAdjudicationError && SAFE_ERROR_CODES.has(error.code)
    ? error.code
    : "shadow_adjudication_execution_failed";
}

if (process.argv[1] && resolve(fileURLToPath(import.meta.url)) === resolve(process.argv[1])) {
  runShadowAdjudicationAuditCli().then((exitCode) => {
    process.exitCode = exitCode;
  });
}
