import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

import { CRITICAL_SHADOW_ADJUDICATION_SQL } from "../src/shadowAdjudicationAudit.js";
import {
  parseShadowAdjudicationArgs,
  resolveShadowAdjudicationConfiguration,
  runHistoricalShadowAdjudicationAudit,
  runShadowAdjudicationAuditCli
} from "../scripts/audit-shadow-adjudication.js";

test("shadow adjudication accepts only approved offline audit sources and bounded timeouts", () => {
  assert.deepEqual(parseShadowAdjudicationArgs(["--source=local-copy"]), {
    sourceKind: "local-copy",
    statementTimeoutMs: 30000
  });
  assert.deepEqual(parseShadowAdjudicationArgs([
    "--source=read-replica",
    "--statement-timeout-ms=45000"
  ]), {
    sourceKind: "read-replica",
    statementTimeoutMs: 45000
  });

  for (const args of [
    [],
    ["--source=production"],
    ["--source=local-copy", "--statement-timeout-ms=0"],
    ["--source=local-copy", "--statement-timeout-ms=120001"],
    ["--source=local-copy", "--unknown=value"]
  ]) {
    assert.throws(() => parseShadowAdjudicationArgs(args), /invalid_shadow_adjudication_options/);
  }
});

test("shadow adjudication ignores DATABASE_URL and only permits a loopback local copy", () => {
  assert.throws(
    () => resolveShadowAdjudicationConfiguration(["--source=local-copy"], {
      DATABASE_URL: "postgres://primary.internal/production"
    }),
    /missing_shadow_adjudication_database_url/
  );

  assert.throws(
    () => resolveShadowAdjudicationConfiguration(["--source=local-copy"], {
      SHADOW_ADJUDICATION_DATABASE_URL: "postgres://replica.internal/audit"
    }),
    /unsafe_shadow_adjudication_database_target/
  );

  const config = resolveShadowAdjudicationConfiguration(["--source=local-copy"], {
    SHADOW_ADJUDICATION_DATABASE_URL: "postgres://localhost/audit_copy"
  });
  assert.equal(config.sourceKind, "local-copy");
});

test("runner uses a read-only transaction, timeout, fixed aggregate query, and rollback", async () => {
  const client = fakeClient({ rows: [] });
  const report = await runHistoricalShadowAdjudicationAudit({
    clientFactory: () => client,
    databaseUrl: "postgres://localhost/audit_copy",
    sourceKind: "local-copy",
    statementTimeoutMs: 30000
  });

  assert.equal(report.historicalCorrelation, "unavailable");
  assert.deepEqual(client.queries, [
    "BEGIN TRANSACTION READ ONLY",
    "SET LOCAL statement_timeout = 30000",
    CRITICAL_SHADOW_ADJUDICATION_SQL,
    "ROLLBACK"
  ]);
  assert.equal(client.ended, true);
});

test("runner rejects unsafe replica posture and returns a fixed safe error", async () => {
  const client = fakeClient({ defaultReadOnly: "off", inRecovery: false });
  await assert.rejects(
    runHistoricalShadowAdjudicationAudit({
      clientFactory: () => client,
      databaseUrl: "postgres://replica.internal/audit",
      sourceKind: "read-replica"
    }),
    /unsafe_read_replica/
  );
  assert.ok(!client.queries.includes(CRITICAL_SHADOW_ADJUDICATION_SQL));
  assert.equal(client.queries.at(-1), "ROLLBACK");
});

test("CLI prints one aggregate JSON object and sanitizes failures", async () => {
  const stdout = [];
  const stderr = [];
  const successCode = await runShadowAdjudicationAuditCli({
    argv: ["--source=local-copy"],
    env: { SHADOW_ADJUDICATION_DATABASE_URL: "postgres://localhost/audit_copy" },
    clientFactory: () => fakeClient({ rows: [] }),
    writeStdout: (value) => stdout.push(value),
    writeStderr: (value) => stderr.push(value)
  });
  assert.equal(successCode, 0);
  assert.equal(stderr.length, 0);
  assert.deepEqual(JSON.parse(stdout[0]).lifecycleCounts, {
    confirmed: 0, cancelled: 0, unconfirmed: 0, unlinked: 0
  });

  const failedStderr = [];
  const failureCode = await runShadowAdjudicationAuditCli({
    argv: ["--source=local-copy"],
    env: { SHADOW_ADJUDICATION_DATABASE_URL: "postgres://localhost/audit_copy" },
    clientFactory: () => fakeClient({ failOnAuditSelect: new Error("unsafe database failure") }),
    writeStderr: (value) => failedStderr.push(value)
  });
  assert.equal(failureCode, 1);
  assert.deepEqual(JSON.parse(failedStderr[0]), {
    status: "error",
    code: "shadow_adjudication_execution_failed",
    message: "Shadow adjudication audit failed safely."
  });
  assert.doesNotMatch(failedStderr[0], /unsafe database failure/iu);
});

test("root package exposes the explicit shadow adjudication audit command", async () => {
  const packageJson = JSON.parse(await readFile(new URL("../../../package.json", import.meta.url), "utf8"));
  assert.equal(packageJson.scripts["parser:shadow-adjudication:audit"], "node apps/api/scripts/audit-shadow-adjudication.js");
});

function fakeClient({ rows = [], defaultReadOnly = "off", inRecovery = false, failOnAuditSelect = null } = {}) {
  return {
    ended: false,
    queries: [],
    async connect() {},
    async query(sql) {
      this.queries.push(sql);
      if (sql === CRITICAL_SHADOW_ADJUDICATION_SQL && failOnAuditSelect) throw failOnAuditSelect;
      if (sql === "SHOW default_transaction_read_only") return { rows: [{ default_transaction_read_only: defaultReadOnly }] };
      if (sql === "SELECT pg_is_in_recovery() AS is_in_recovery") return { rows: [{ is_in_recovery: inRecovery }] };
      if (sql === CRITICAL_SHADOW_ADJUDICATION_SQL) return { rows };
      return { rows: [] };
    },
    async end() {
      this.ended = true;
    }
  };
}
