import test from "node:test";
import assert from "node:assert/strict";

import { createHistoryLoader } from "../src/historyLoad.js";

test("History ensure reuses one in-flight request and caches a successful load", async () => {
  const pending = deferred();
  let calls = 0;
  const loader = createHistoryLoader(async () => {
    calls += 1;
    await pending.promise;
  });
  assert.equal(loader.isLoaded(), false);
  assert.equal(loader.hasStarted(), false);

  const first = loader.ensure();
  assert.equal(loader.hasStarted(), true);
  const second = loader.ensure();
  assert.equal(first, second);
  assert.equal(calls, 1);

  pending.resolve();
  await first;
  assert.equal(loader.isLoaded(), true);
  await loader.ensure();
  assert.equal(calls, 1);
});

test("History refresh during an in-flight load queues exactly one fresh request", async () => {
  const pending = [deferred(), deferred()];
  let calls = 0;
  const loader = createHistoryLoader(async () => {
    const index = calls;
    calls += 1;
    await pending[index].promise;
  });

  const initial = loader.ensure();
  const refreshed = loader.refresh();
  loader.refresh();
  assert.equal(calls, 1);

  pending[0].resolve();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(calls, 2);

  pending[1].resolve();
  await Promise.all([initial, refreshed]);
  assert.equal(calls, 2);
});

test("History retries after a failed lazy load", async () => {
  let calls = 0;
  const loader = createHistoryLoader(async () => {
    calls += 1;
    if (calls === 1) throw new Error("offline");
  });

  await assert.rejects(loader.ensure(), /offline/);
  await loader.ensure();
  assert.equal(calls, 2);
});

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}
