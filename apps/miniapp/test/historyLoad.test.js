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

test("History feedback reports loading, success, failure, then retry success", async () => {
  const states = [];
  let calls = 0;
  const loader = createHistoryLoader(async () => {
    calls += 1;
    if (calls === 2) throw new Error("offline");
  }, (state) => states.push(state));

  await loader.ensure();
  assert.deepEqual(states, ["loading", "loaded"]);

  await assert.rejects(loader.refresh(), /offline/);
  assert.deepEqual(states, ["loading", "loaded", "loading", "error"]);

  await loader.refresh();
  assert.deepEqual(states, ["loading", "loaded", "loading", "error", "loading", "loaded"]);
});

test("queued History refresh keeps feedback loading until the queued request settles", async () => {
  const pending = [deferred(), deferred()];
  const states = [];
  let calls = 0;
  const loader = createHistoryLoader(() => pending[calls++].promise, (state) => states.push(state));
  const initial = loader.ensure();
  const refreshed = loader.refresh();

  pending[0].resolve();
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(states, ["loading", "loading", "loading"]);

  pending[1].reject(new Error("offline"));
  await assert.rejects(initial, /offline/);
  await assert.rejects(refreshed, /offline/);
  assert.deepEqual(states, ["loading", "loading", "loading", "error"]);
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
