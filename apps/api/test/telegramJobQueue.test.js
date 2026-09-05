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
