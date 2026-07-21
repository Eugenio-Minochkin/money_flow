import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

import { HISTORICAL_AUDIT_SQL } from "../src/parserAudit.js";
import {
  parseAuditArgs,
  resolveAuditConfiguration,
  runHistoricalParserAudit,
  runParserAuditCli
} from "../scripts/audit-expense-parser.js";

test("audit arguments require an explicit source and accept only stricter privacy floors", () => {
  assert.deepEqual(parseAuditArgs(["--source=local-copy"]), {
    sourceKind: "local-copy",
    minCount: 3,
    minDistinctUsers: 2,
    dominanceThreshold: 0.8,
    statementTimeoutMs: 30000
  });
  assert.deepEqual(parseAuditArgs([
    "--source=read-replica",
    "--min-count=7",
    "--min-distinct-users=4",
    "--dominance-threshold=0.95",
    "--statement-timeout-ms=45000"
  ]), {
    sourceKind: "read-replica",
    minCount: 7,
    minDistinctUsers: 4,
    dominanceThreshold: 0.95,
    statementTimeoutMs: 45000
  });

  for (const args of [
    [],
    ["--source=production"],
    ["--source=local-copy", "--min-count=2"],
    ["--source=local-copy", "--min-distinct-users=1"],
    ["--source=local-copy", "--dominance-threshold=0.79"],
    ["--source=local-copy", "--statement-timeout-ms=0"],
    ["--source=local-copy", "--statement-timeout-ms=120001"],
    ["--source=local-copy", "--unknown=value"]
  ]) {
    assert.throws(() => parseAuditArgs(args), /invalid_audit_options/);
  }
});

test("configuration uses only PARSER_AUDIT_DATABASE_URL and local-copy is loopback-only", () => {
  assert.throws(
    () => resolveAuditConfiguration(["--source=local-copy"], {
      DATABASE_URL: "postgres://primary.example/production"
    }),
    /missing_audit_database_url/
  );

  for (const databaseUrl of [
    "postgres://db.example/audit",
    "postgres://10.0.0.8/audit",
    "not-a-database-url"
  ]) {
    assert.throws(
      () => resolveAuditConfiguration(["--source=local-copy"], {
        PARSER_AUDIT_DATABASE_URL: databaseUrl
      }),
      /unsafe_audit_database_target/
    );
  }

  for (const hostname of ["localhost", "127.0.0.1", "[::1]"]) {
    const config = resolveAuditConfiguration(["--source=local-copy"], {
      PARSER_AUDIT_DATABASE_URL: `postgres://audit:secret@${hostname}:5432/audit_copy`
    });
    assert.equal(config.sourceKind, "local-copy");
    assert.match(config.databaseUrl, /audit_copy$/u);
  }
});

test("local-copy runner executes only a read-only transaction, fixed SELECT, and rollback", async () => {
  const client = fakeClient({ rows: [] });

  const report = await runHistoricalParserAudit({
    clientFactory: () => client,
    databaseUrl: "postgres://audit:secret@127.0.0.1/audit_copy",
    sourceKind: "local-copy",
    minCount: 3,
    minDistinctUsers: 2,
    dominanceThreshold: 0.8,
    statementTimeoutMs: 30000
  });

  assert.equal(report.sourceKind, "local-copy");
  assert.equal(client.connected, true);
  assert.equal(client.ended, true);
  assert.deepEqual(client.queries, [
    "BEGIN TRANSACTION READ ONLY",
    "SET LOCAL statement_timeout = 30000",
    HISTORICAL_AUDIT_SQL,
    "ROLLBACK"
  ]);
  assert.ok(client.queries.every((sql) => !/\b(?:INSERT|UPDATE|DELETE)\b/iu.test(sql)));
});

test("read-replica runner verifies server posture after beginning read-only transaction", async () => {
  for (const posture of [
    { defaultReadOnly: "on", inRecovery: false },
    { defaultReadOnly: "off", inRecovery: true }
  ]) {
    const client = fakeClient({ rows: [], ...posture });
    const report = await runHistoricalParserAudit({
      clientFactory: () => client,
      databaseUrl: "postgres://audit:secret@replica.internal/audit",
      sourceKind: "read-replica",
      statementTimeoutMs: 30000
    });

    assert.equal(report.sourceKind, "read-replica");
    assert.deepEqual(client.queries, [
      "BEGIN TRANSACTION READ ONLY",
      "SET LOCAL statement_timeout = 30000",
      "SHOW default_transaction_read_only",
      "SELECT pg_is_in_recovery() AS is_in_recovery",
      HISTORICAL_AUDIT_SQL,
      "ROLLBACK"
    ]);
  }
});

test("read-replica runner aborts and rolls back when neither server posture signal is true", async () => {
  const client = fakeClient({ defaultReadOnly: "off", inRecovery: false });

  await assert.rejects(
    runHistoricalParserAudit({
      clientFactory: () => client,
      databaseUrl: "postgres://audit:secret@primary.internal/production",
      sourceKind: "read-replica",
      statementTimeoutMs: 30000
    }),
    /unsafe_read_replica/
  );

  assert.ok(!client.queries.includes(HISTORICAL_AUDIT_SQL));
  assert.equal(client.queries.at(-1), "ROLLBACK");
  assert.equal(client.ended, true);
});

test("runner rolls back after a query failure and exposes only a fixed safe error", async () => {
  const rawFailure = "password=secret postgres://audit@host/db user 99999 raw description";
  const client = fakeClient({ failOnAuditSelect: new Error(rawFailure) });

  await assert.rejects(
    runHistoricalParserAudit({
      clientFactory: () => client,
      databaseUrl: "postgres://audit:secret@127.0.0.1/audit_copy",
      sourceKind: "local-copy",
      statementTimeoutMs: 30000
    }),
    (error) => {
      assert.equal(error.message, "audit_execution_failed");
      assert.ok(!String(error).includes(rawFailure));
      return true;
    }
  );
  assert.equal(client.queries.at(-1), "ROLLBACK");
  assert.equal(client.ended, true);
});

test("CLI writes one safe JSON report and sanitizes all errors", async () => {
  const stdout = [];
  const stderr = [];
  const successCode = await runParserAuditCli({
    argv: ["--source=local-copy"],
    env: { PARSER_AUDIT_DATABASE_URL: "postgres://audit:secret@localhost/audit_copy" },
    clientFactory: () => fakeClient({ rows: [] }),
    writeStdout: (value) => stdout.push(value),
    writeStderr: (value) => stderr.push(value)
  });

  assert.equal(successCode, 0);
  assert.equal(stdout.length, 1);
  assert.equal(stderr.length, 0);
  assert.equal(JSON.parse(stdout[0]).sourceKind, "local-copy");

  const failedStdout = [];
  const failedStderr = [];
  const failureCode = await runParserAuditCli({
    argv: ["--source=local-copy"],
    env: { PARSER_AUDIT_DATABASE_URL: "postgres://audit:super-secret@localhost/audit_copy" },
    clientFactory: () => fakeClient({
      failOnAuditSelect: new Error("raw alice@example.com @handle 12345 https://secret.example")
    }),
    writeStdout: (value) => failedStdout.push(value),
    writeStderr: (value) => failedStderr.push(value)
  });

  assert.equal(failureCode, 1);
  assert.deepEqual(failedStdout, []);
  assert.equal(failedStderr.length, 1);
  assert.deepEqual(JSON.parse(failedStderr[0]), {
    status: "error",
    code: "audit_execution_failed",
    message: "Parser audit failed safely."
  });
  assert.doesNotMatch(failedStderr[0], /alice|handle|12345|secret\.example|super-secret/iu);
});

test("root package exposes the explicit parser:audit command", async () => {
  const packageJson = JSON.parse(await readFile(new URL("../../../package.json", import.meta.url), "utf8"));
  assert.equal(packageJson.scripts["parser:audit"], "node apps/api/scripts/audit-expense-parser.js");
});

function fakeClient({
  rows = [],
  defaultReadOnly = "off",
  inRecovery = false,
  failOnAuditSelect = null
} = {}) {
  return {
    connected: false,
    ended: false,
    queries: [],
    async connect() {
      this.connected = true;
    },
    async query(sql) {
      this.queries.push(sql);
      if (sql === HISTORICAL_AUDIT_SQL && failOnAuditSelect) throw failOnAuditSelect;
      if (sql === "SHOW default_transaction_read_only") {
        return { rows: [{ default_transaction_read_only: defaultReadOnly }] };
      }
      if (sql === "SELECT pg_is_in_recovery() AS is_in_recovery") {
        return { rows: [{ is_in_recovery: inRecovery }] };
      }
      if (sql === HISTORICAL_AUDIT_SQL) return { rows };
      return { rows: [] };
    },
    async end() {
      this.ended = true;
    }
  };
}
