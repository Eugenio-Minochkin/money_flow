import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import pg from "pg";

import {
  HISTORICAL_AUDIT_SQL,
  assertReadOnlyAuditSql,
  buildParserAuditReport,
  normalizeAuditThresholds
} from "../src/parserAudit.js";

const { Client } = pg;
const DEFAULT_STATEMENT_TIMEOUT_MS = 30_000;
const MAX_STATEMENT_TIMEOUT_MS = 120_000;
const VALID_SOURCES = new Set(["local-copy", "read-replica"]);
const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "::1"]);
const SAFE_ERROR_CODES = new Set([
  "invalid_audit_options",
  "missing_audit_database_url",
  "unsafe_audit_database_target",
  "unsafe_read_replica",
  "audit_execution_failed"
]);

class SafeAuditError extends Error {
  constructor(code) {
    super(code);
    this.name = "SafeAuditError";
    this.code = code;
  }
}

export function parseAuditArgs(args = []) {
  const values = new Map();
  const known = new Set([
    "source",
    "min-count",
    "min-distinct-users",
    "dominance-threshold",
    "statement-timeout-ms"
  ]);

  for (const arg of args) {
    const match = /^--([^=]+)=(.*)$/u.exec(String(arg));
    if (!match || !known.has(match[1]) || values.has(match[1])) {
      throw new SafeAuditError("invalid_audit_options");
    }
    values.set(match[1], match[2]);
  }

  const sourceKind = values.get("source");
  if (!VALID_SOURCES.has(sourceKind)) {
    throw new SafeAuditError("invalid_audit_options");
  }

  try {
    const thresholds = normalizeAuditThresholds({
      minCount: parseOptionalInteger(values.get("min-count")),
      minDistinctUsers: parseOptionalInteger(values.get("min-distinct-users")),
      dominanceThreshold: parseOptionalNumber(values.get("dominance-threshold"))
    });
    const statementTimeoutMs = values.has("statement-timeout-ms")
      ? parseBoundedTimeout(values.get("statement-timeout-ms"))
      : DEFAULT_STATEMENT_TIMEOUT_MS;
    return { sourceKind, ...thresholds, statementTimeoutMs };
  } catch {
    throw new SafeAuditError("invalid_audit_options");
  }
}

export function resolveAuditConfiguration(args = [], env = {}) {
  const options = parseAuditArgs(args);
  const databaseUrl = String(env.PARSER_AUDIT_DATABASE_URL ?? "").trim();
  if (!databaseUrl) throw new SafeAuditError("missing_audit_database_url");
  validateAuditDatabaseTarget(databaseUrl, options.sourceKind);
  return { ...options, databaseUrl };
}

export async function runHistoricalParserAudit({
  clientFactory = ({ connectionString }) => new Client({ connectionString }),
  databaseUrl,
  sourceKind,
  minCount,
  minDistinctUsers,
  dominanceThreshold,
  statementTimeoutMs = DEFAULT_STATEMENT_TIMEOUT_MS
}) {
  try {
    validateAuditDatabaseTarget(databaseUrl, sourceKind);
  } catch (error) {
    throw normalizeSafeError(error);
  }
  const thresholds = normalizeThresholdsForRunner({ minCount, minDistinctUsers, dominanceThreshold });
  const safeTimeout = parseTimeoutForRunner(statementTimeoutMs);
  assertReadOnlyAuditSql(HISTORICAL_AUDIT_SQL);

  let client;
  let transactionStarted = false;
  let report;
  let failure = null;

  try {
    client = clientFactory({ connectionString: databaseUrl });
    await client.connect();
    await client.query("BEGIN TRANSACTION READ ONLY");
    transactionStarted = true;
    await client.query(`SET LOCAL statement_timeout = ${safeTimeout}`);

    if (sourceKind === "read-replica") {
      const defaultReadOnly = await client.query("SHOW default_transaction_read_only");
      const recovery = await client.query("SELECT pg_is_in_recovery() AS is_in_recovery");
      const isDefaultReadOnly = String(defaultReadOnly.rows?.[0]?.default_transaction_read_only ?? "").toLowerCase() === "on";
      const isInRecovery = recovery.rows?.[0]?.is_in_recovery === true;
      if (!isDefaultReadOnly && !isInRecovery) {
        throw new SafeAuditError("unsafe_read_replica");
      }
    }

    assertReadOnlyAuditSql(HISTORICAL_AUDIT_SQL);
    const result = await client.query(HISTORICAL_AUDIT_SQL);
    report = buildParserAuditReport(result.rows, { sourceKind, ...thresholds });
  } catch (error) {
    failure = normalizeSafeError(error);
  }

  if (transactionStarted) {
    try {
      await client.query("ROLLBACK");
    } catch {
      failure ??= new SafeAuditError("audit_execution_failed");
    }
  }

  if (client) {
    try {
      await client.end();
    } catch {
      failure ??= new SafeAuditError("audit_execution_failed");
    }
  }

  if (failure) throw failure;
  return report;
}

export async function runParserAuditCli({
  argv = process.argv.slice(2),
  env = process.env,
  clientFactory,
  writeStdout = (value) => process.stdout.write(`${value}\n`),
  writeStderr = (value) => process.stderr.write(`${value}\n`)
} = {}) {
  try {
    const config = resolveAuditConfiguration(argv, env);
    const report = await runHistoricalParserAudit({ ...config, clientFactory });
    writeStdout(JSON.stringify(report));
    return 0;
  } catch (error) {
    const code = safeErrorCode(error);
    writeStderr(JSON.stringify({
      status: "error",
      code,
      message: "Parser audit failed safely."
    }));
    return 1;
  }
}

function validateAuditDatabaseTarget(databaseUrl, sourceKind) {
  if (!VALID_SOURCES.has(sourceKind)) {
    throw new SafeAuditError("unsafe_audit_database_target");
  }
  let parsed;
  try {
    parsed = new URL(String(databaseUrl));
  } catch {
    throw new SafeAuditError("unsafe_audit_database_target");
  }
  if (parsed.protocol !== "postgres:" && parsed.protocol !== "postgresql:") {
    throw new SafeAuditError("unsafe_audit_database_target");
  }
  const hostname = parsed.hostname.toLowerCase().replace(/^\[|\]$/gu, "");
  if (sourceKind === "local-copy" && !LOOPBACK_HOSTS.has(hostname)) {
    throw new SafeAuditError("unsafe_audit_database_target");
  }
}

function parseOptionalInteger(value) {
  if (value === undefined) return undefined;
  if (!/^\d+$/u.test(value)) throw new Error("invalid");
  return Number(value);
}

function parseOptionalNumber(value) {
  if (value === undefined) return undefined;
  if (!/^(?:0|1)(?:\.\d+)?$/u.test(value)) throw new Error("invalid");
  return Number(value);
}

function parseBoundedTimeout(value) {
  if (!/^\d+$/u.test(value)) throw new Error("invalid");
  const timeout = Number(value);
  if (!Number.isSafeInteger(timeout) || timeout <= 0 || timeout > MAX_STATEMENT_TIMEOUT_MS) {
    throw new Error("invalid");
  }
  return timeout;
}

function parseTimeoutForRunner(value) {
  try {
    return parseBoundedTimeout(String(value));
  } catch {
    throw new SafeAuditError("invalid_audit_options");
  }
}

function normalizeThresholdsForRunner(values) {
  try {
    return normalizeAuditThresholds(values);
  } catch {
    throw new SafeAuditError("invalid_audit_options");
  }
}

function normalizeSafeError(error) {
  if (error instanceof SafeAuditError && SAFE_ERROR_CODES.has(error.code)) return error;
  return new SafeAuditError("audit_execution_failed");
}

function safeErrorCode(error) {
  return error instanceof SafeAuditError && SAFE_ERROR_CODES.has(error.code)
    ? error.code
    : "audit_execution_failed";
}

if (process.argv[1] && resolve(fileURLToPath(import.meta.url)) === resolve(process.argv[1])) {
  runParserAuditCli().then((exitCode) => {
    process.exitCode = exitCode;
  });
}
