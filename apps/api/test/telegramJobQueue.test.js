import test from "node:test";
import assert from "node:assert/strict";

import { createTelegramJobQueue, TelegramJobTimeoutError } from "../src/telegramJobQueue.js";

test("admits a ten-message burst only when every durable job has a queue reservation", async () => {
  const queue = createTelegramJobQueue({ globalConcurrency: 1, userQueueLimit: 10 });
  const reservations = Array.from({ length: 10 }, () => queue.reserve(7));
  assert.ok(reservations.every((reservation) => reservation.accepted));
  assert.equal(queue.reserve(7).status, "userQueueFull");

  const completions = [];
  const jobs = reservations.map((reservation, index) => queue.enqueue({
    userId: 7,
    reservation: reservation.token,
    run: async () => { completions.push(index); }
  }));
  assert.ok(jobs.every((job) => job.accepted));
  await Promise.all(jobs.map((job) => job.promise));
  assert.deepEqual(completions, Array.from({ length: 10 }, (_, index) => index));
});

test("timeout aborts work but waits for it to settle before freeing the worker", async () => {
  const queue = createTelegramJobQueue({ globalConcurrency: 1, jobTimeoutMs: 10 });
  let aborted = false;
  let release;
  const first = queue.enqueue({
    userId: 7,
    run: ({ signal }) => new Promise((resolve, reject) => {
      signal.addEventListener("abort", () => {
        aborted = true;
        release = () => reject(signal.reason);
      }, { once: true });
    })
  });
  const second = queue.enqueue({ userId: 8, run: async () => "second" });

  await waitFor(() => aborted);
  assert.equal(release == null, false);
  assert.equal(await Promise.race([second.promise.then(() => true), delay(5).then(() => false)]), false);
  release();
  await assert.rejects(first.promise, TelegramJobTimeoutError);
  assert.equal(await second.promise, "second");
});

async function waitFor(predicate) {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (predicate()) return;
    await delay(2);
  }
  throw new Error("condition not met");
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

test("independent parsing overlaps but ordered mutation waits for the prior admission", async () => {
  const queue = createTelegramJobQueue({ globalConcurrency: 3 });
  const slow = Promise.withResolvers();
  const entered = Promise.withResolvers();
  const events = [];
  const a = queue.enqueue({ userId: 7, independent: true, run: async ({ acquireMutation }) => {
    entered.resolve();
    await slow.promise;
    const release = await acquireMutation();
    events.push("a");
    release();
  } });
  await entered.promise;
  const b = queue.enqueue({ userId: 7, independent: true, run: async ({ acquireMutation }) => {
    const release = await acquireMutation();
    events.push("b");
    release();
  } });
  const c = queue.enqueue({ userId: 7, run: async () => { events.push("barrier"); } });
  const d = queue.enqueue({ userId: 7, independent: true, run: async () => { events.push("d"); } });
  try {
    assert.equal(b.status, "accepted");
    await delay(10);
    assert.deepEqual(events, [], "B must not mutate while A is still parsing");
  } finally {
    slow.resolve();
    await Promise.all([a.promise, b.promise, c.promise, d.promise]);
  }
  assert.deepEqual(events, ["a", "b", "barrier", "d"]);
});

test("a later admission cannot occupy the worker while an earlier admission is unresolved", async () => {
  const queue = createTelegramJobQueue({ globalConcurrency: 1 });
  const firstTicket = queue.createAdmissionTicket(7);
  const secondReservation = queue.reserve(7);
  const started = [];
  const second = queue.enqueue({
    userId: 7,
    reservation: secondReservation.token,
    independent: true,
    run: async () => { started.push("second"); }
  });

  await delay(5);
  assert.deepEqual(started, []);

  const firstReservation = queue.reserve(7, firstTicket);
  const first = queue.enqueue({
    userId: 7,
    reservation: firstReservation.token,
    independent: true,
    run: async () => { started.push("first"); }
  });
  await Promise.all([first.promise, second.promise]);
  assert.deepEqual(started, ["first", "second"]);
});

test("a skipped admission releases later work", async () => {
  const queue = createTelegramJobQueue({ globalConcurrency: 1 });
  const skipped = queue.createAdmissionTicket(7);
  const nextTicket = queue.createAdmissionTicket(7);
  const started = [];
  const next = queue.enqueue({ userId: 7, admissionTicket: nextTicket, run: async () => { started.push("next"); } });
  await delay(5);
  assert.deepEqual(started, []);
  queue.releaseAdmissionTicket(skipped);
  await next.promise;
  assert.deepEqual(started, ["next"]);
});

test("a released reservation cannot delete state for a later same-user job", async () => {
  const queue = createTelegramJobQueue({ globalConcurrency: 3 });
  const ticket = queue.createAdmissionTicket(7);
  const reservation = queue.reserve(7, ticket);
  queue.releaseReservation(reservation.token);

  const gate = Promise.withResolvers();
  const entered = Promise.withResolvers();
  const events = [];
  const active = queue.enqueue({ userId: 7, independent: true, run: async () => { entered.resolve(); await gate.promise; } });
  await entered.promise;
  queue.releaseAdmissionTicket(ticket);
  const barrier = queue.enqueue({ userId: 7, run: async () => { events.push("barrier"); } });
  await delay(5);
  assert.deepEqual(events, []);
  gate.resolve();
  await Promise.all([active.promise, barrier.promise]);
  assert.deepEqual(events, ["barrier"]);
});

test("independent jobs retain bounded slots and cancelled mutation waiters never run", async () => {
  const queue = createTelegramJobQueue({ globalConcurrency: 2, jobTimeoutMs: 25 });
  const hold = Promise.withResolvers();
  const entered = Promise.withResolvers();
  const waiter = Promise.withResolvers();
  const events = [];
  const a = queue.enqueue({ userId: 7, independent: true, run: async ({ acquireMutation }) => {
    await acquireMutation();
    entered.resolve();
    await hold.promise;
  } });
  const aFailure = assert.rejects(a.promise, TelegramJobTimeoutError);
  await entered.promise;
  const b = queue.enqueue({ userId: 7, independent: true, run: async ({ acquireMutation }) => {
    waiter.resolve();
    await acquireMutation();
    events.push("late mutation");
  } });
  await waiter.promise;
  await delay(30);
  const c = queue.enqueue({ userId: 7, run: async () => { events.push("barrier"); } });
  assert.deepEqual(events, []);
  hold.resolve();
  await aFailure;
  await b.promise;
  await c.promise;
  assert.deepEqual(events, ["late mutation", "barrier"]);
});

test("parallel jobs share global capacity and reservations survive another job completing", async () => {
  const queue = createTelegramJobQueue({ globalConcurrency: 2, userQueueLimit: 2, globalQueueLimit: 3 });
  const gate = Promise.withResolvers();
  const starts = [];
  const a = queue.enqueue({ userId: 7, independent: true, run: async () => { starts.push("a"); } });
  await a.promise;
  const reserved = queue.reserve(7);
  // Queue finalization must not discard state while admission owns a reservation.
  await delay(0);
  const b = queue.enqueue({ userId: 7, reservation: reserved.token, independent: true, run: async () => { starts.push("b"); await gate.promise; } });
  const c = queue.enqueue({ userId: 7, independent: true, run: async () => { starts.push("c"); await gate.promise; } });
  const d = queue.enqueue({ userId: 8, independent: true, run: async () => { starts.push("d"); } });
  const e = queue.enqueue({ userId: 7, independent: true, run: async () => { starts.push("e"); } });
  assert.equal(b.accepted, true);
  assert.equal(c.stats.globalActiveJobs, 2);
  assert.equal(d.status, "globalQueueDelayed");
  assert.deepEqual(starts, ["a", "b", "c"]);
  const pending = queue.reserve(8);
  assert.equal(pending.accepted, true);
  assert.equal(queue.reserve(9).status, "globalQueueFull");
  queue.releaseReservation(pending.token);
  gate.resolve();
  await Promise.all([b.promise, c.promise, d.promise, e.promise]);
  assert.ok(starts.includes("d"));
  assert.ok(starts.includes("e"));
});

test("messages admitted behind a stateful barrier stay serial after it changes routing state", async () => {
  const queue = createTelegramJobQueue({ globalConcurrency: 3 });
  const barrierGate = Promise.withResolvers();
  const firstGate = Promise.withResolvers();
  const firstEntered = Promise.withResolvers();
  const events = [];
  const barrier = queue.enqueue({ userId: 7, run: async () => { await barrierGate.promise; } });
  const first = queue.enqueue({ userId: 7, independent: true, run: async () => {
    events.push("first"); firstEntered.resolve(); await firstGate.promise;
  } });
  const second = queue.enqueue({ userId: 7, independent: true, run: async () => { events.push("second"); } });
  barrierGate.resolve();
  await firstEntered.promise;
  try {
    assert.deepEqual(events, ["first"]);
  } finally {
    firstGate.resolve();
    await Promise.all([barrier.promise, first.promise, second.promise]);
  }
  assert.deepEqual(events, ["first", "second"]);
});

test("a skipped middle admission cannot release a successor past an unresolved first admission", async () => {
  const queue = createTelegramJobQueue();
  const first = queue.createAdmissionTicket(7);
  const skipped = queue.createAdmissionTicket(7);
  const last = queue.createAdmissionTicket(7);
  let lastReady = false;
  const wait = queue.waitForAdmissionTicket(last).then(() => { lastReady = true; });
  queue.releaseAdmissionTicket(skipped);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(lastReady, false);
  queue.releaseAdmissionTicket(first);
  await wait;
  assert.equal(lastReady, true);
  queue.releaseAdmissionTicket(last);
});
