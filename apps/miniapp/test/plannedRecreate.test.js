import test from "node:test";
import assert from "node:assert/strict";

import { createPlannedRecreateSession, runPlannedRecreate } from "../src/plannedRecreate.js";

test("one pending form session sends only one recreate request", async () => {
  const session = createPlannedRecreateSession();
  let requests = 0;
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const options = {
    session,
    recreateRequest: async () => {
      requests += 1;
      await gate;
      return { plannedExpense: { id: requests } };
    },
    closeForm() {},
    loadDashboard: async () => {},
    refreshArchive: async () => {},
    showCreated() {},
    showRefreshWarning() {}
  };

  const first = runPlannedRecreate(options);
  assert.deepEqual(await runPlannedRecreate(options), { status: "busy" });
  assert.equal(requests, 1);
  release();
  assert.equal((await first).status, "created");
  assert.equal(requests, 1);
});

test("mutation failure keeps the form session retryable", async () => {
  const session = createPlannedRecreateSession();
  let closed = false;

  await assert.rejects(runPlannedRecreate({
    session,
    recreateRequest: async () => { throw new Error("network_failed"); },
    closeForm() { closed = true; },
    loadDashboard: async () => {},
    refreshArchive: async () => {},
    showCreated() {},
    showRefreshWarning() {}
  }), /network_failed/);

  assert.equal(closed, false);
  assert.equal(session.busy, false);
  assert.equal(session.completed, false);
});

for (const failedRefresh of ["dashboard", "archive"]) {
  test(`successful recreate stays committed when ${failedRefresh} refresh fails`, async () => {
    const events = [];
    const session = createPlannedRecreateSession();
    const result = await runPlannedRecreate({
      session,
      recreateRequest: async () => {
        events.push("request");
        return { plannedExpense: { id: 42 } };
      },
      closeForm() { events.push("close"); },
      loadDashboard: async () => {
        events.push("dashboard");
        if (failedRefresh === "dashboard") throw new Error("dashboard_failed");
      },
      refreshArchive: async () => {
        events.push("archive");
        if (failedRefresh === "archive") throw new Error("archive_failed");
      },
      showCreated() { events.push("created"); },
      showRefreshWarning() { events.push("warning"); }
    });

    assert.equal(result.status, "created_with_refresh_warning");
    assert.deepEqual(events.slice(0, 3), ["request", "close", "created"]);
    assert.equal(events.at(-1), "warning");
    assert.equal(session.completed, true);
  });
}

test("a completed session cannot recreate again, but a new form session can", async () => {
  let nextId = 0;
  const makeOptions = (session) => ({
    session,
    recreateRequest: async () => ({ plannedExpense: { id: ++nextId } }),
    closeForm() {},
    loadDashboard: async () => {},
    refreshArchive: async () => {},
    showCreated() {},
    showRefreshWarning() {}
  });
  const firstSession = createPlannedRecreateSession();

  const first = await runPlannedRecreate(makeOptions(firstSession));
  assert.equal(first.result.plannedExpense.id, 1);
  assert.deepEqual(await runPlannedRecreate(makeOptions(firstSession)), { status: "busy" });

  const second = await runPlannedRecreate(makeOptions(createPlannedRecreateSession()));
  assert.equal(second.result.plannedExpense.id, 2);
});
