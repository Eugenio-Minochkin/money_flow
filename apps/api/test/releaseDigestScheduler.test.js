import test from "node:test";
import assert from "node:assert/strict";

import {
  createReleaseDigestScheduler,
  releaseDigestLocalParts
} from "../src/releaseDigestScheduler.js";

test("releaseDigestLocalParts uses the configured timezone and h23 hour", () => {
  assert.deepEqual(
    releaseDigestLocalParts(new Date("2026-06-19T14:05:00Z"), "Asia/Bangkok"),
    { date: "2026-06-19", hour: 21 }
  );
  assert.deepEqual(
    releaseDigestLocalParts(new Date("2026-06-19T17:05:00Z"), "America/New_York"),
    { date: "2026-06-19", hour: 13 }
  );
  assert.deepEqual(
    releaseDigestLocalParts(new Date("2026-06-19T17:00:00Z"), "Asia/Bangkok"),
    { date: "2026-06-20", hour: 0 }
  );
});

test("disabled scheduler skips without checking the repository or sending", async () => {
  let repositoryChecks = 0;
  let sends = 0;
  const scheduler = createReleaseDigestScheduler({
    enabled: false,
    timezone: "Asia/Bangkok",
    sendHour: 21,
    repo: {
      async getReleaseDigestRunForLocalDate() {
        repositoryChecks += 1;
      }
    },
    releaseNotesService: {
      async sendReleaseDigestSinceLastRun() {
        sends += 1;
      }
    }
  });

  const result = await scheduler.tick(new Date("2026-06-19T14:00:00Z"));

  assert.deepEqual(result, { skipped: true, reason: "disabled" });
  assert.equal(repositoryChecks, 0);
  assert.equal(sends, 0);
});

test("scheduler skips outside the configured local hour", async () => {
  let sends = 0;
  const scheduler = createReleaseDigestScheduler({
    enabled: true,
    timezone: "Asia/Bangkok",
    sendHour: 21,
    repo: {
      async getReleaseDigestRunForLocalDate() {
        assert.fail("repository should not be checked outside the send hour");
      }
    },
    releaseNotesService: {
      async sendReleaseDigestSinceLastRun() {
        sends += 1;
      }
    }
  });

  const result = await scheduler.tick(new Date("2026-06-19T13:59:00Z"));

  assert.deepEqual(result, { skipped: true, reason: "outside_send_hour" });
  assert.equal(sends, 0);
});

test("scheduler sends only once for the same local date", async () => {
  let existingRun = null;
  const calls = [];
  const scheduler = createReleaseDigestScheduler({
    enabled: true,
    timezone: "Asia/Bangkok",
    sendHour: 21,
    repo: {
      async getReleaseDigestRunForLocalDate(localDate, timezone) {
        calls.push({ type: "guard", localDate, timezone });
        return existingRun;
      }
    },
    releaseNotesService: {
      async sendReleaseDigestSinceLastRun(now, options) {
        calls.push({ type: "send", now, options });
        existingRun = { status: "success" };
        return { sent: true };
      }
    }
  });
  const firstNow = new Date("2026-06-19T14:00:00Z");

  assert.deepEqual(await scheduler.tick(firstNow), { sent: true });
  assert.deepEqual(
    await scheduler.tick(new Date("2026-06-19T14:15:00Z")),
    { skipped: true, reason: "existing_run" }
  );
  assert.deepEqual(calls, [
    { type: "guard", localDate: "2026-06-19", timezone: "Asia/Bangkok" },
    {
      type: "send",
      now: firstNow,
      options: {
        trigger: "auto",
        timezone: "Asia/Bangkok",
        localDate: "2026-06-19"
      }
    },
    { type: "guard", localDate: "2026-06-19", timezone: "Asia/Bangkok" }
  ]);
});

test("concurrent ticks are protected by an in-memory lock", async () => {
  let releaseSend;
  let sends = 0;
  const pendingSend = new Promise((resolve) => {
    releaseSend = resolve;
  });
  const scheduler = createReleaseDigestScheduler({
    enabled: true,
    timezone: "Asia/Bangkok",
    sendHour: 21,
    repo: {
      async getReleaseDigestRunForLocalDate() {
        return null;
      }
    },
    releaseNotesService: {
      async sendReleaseDigestSinceLastRun() {
        sends += 1;
        await pendingSend;
        return { sent: true };
      }
    }
  });
  const now = new Date("2026-06-19T14:00:00Z");

  const first = scheduler.tick(now);
  await Promise.resolve();
  const second = await scheduler.tick(now);
  releaseSend();

  assert.deepEqual(second, { skipped: true, reason: "running" });
  assert.deepEqual(await first, { sent: true });
  assert.equal(sends, 1);
});

test("failed send releases the lock so a later tick can retry", async () => {
  let sends = 0;
  const scheduler = createReleaseDigestScheduler({
    enabled: true,
    timezone: "Asia/Bangkok",
    sendHour: 21,
    repo: {
      async getReleaseDigestRunForLocalDate() {
        return null;
      }
    },
    releaseNotesService: {
      async sendReleaseDigestSinceLastRun() {
        sends += 1;
        if (sends === 1) throw new Error("temporary failure");
        return { sent: true };
      }
    }
  });
  const now = new Date("2026-06-19T14:00:00Z");

  await assert.rejects(scheduler.tick(now), /temporary failure/);
  assert.deepEqual(await scheduler.tick(now), { sent: true });
  assert.equal(sends, 2);
});

test("start schedules one initial tick and one interval, and stop clears both", async () => {
  const timers = fakeTimerApi();
  const errors = [];
  let ticks = 0;
  const scheduler = createReleaseDigestScheduler({
    enabled: true,
    timezone: "Asia/Bangkok",
    sendHour: 21,
    checkIntervalMinutes: 15,
    repo: {
      async getReleaseDigestRunForLocalDate() {
        return null;
      }
    },
    releaseNotesService: {
      async sendReleaseDigestSinceLastRun() {
        ticks += 1;
        throw new Error("scheduled failure");
      }
    },
    onError(error) {
      errors.push(error.message);
    },
    timerApi: timers
  });

  scheduler.start();
  scheduler.start();

  assert.deepEqual(timers.timeoutDelays, [10_000]);
  assert.deepEqual(timers.intervalDelays, [15 * 60_000]);

  await timers.runTimeout(new Date("2026-06-19T14:00:00Z"));
  await timers.runInterval(new Date("2026-06-19T14:15:00Z"));
  assert.equal(ticks, 2);
  assert.deepEqual(errors, ["scheduled failure", "scheduled failure"]);

  scheduler.stop();
  scheduler.stop();
  assert.deepEqual(timers.clearedTimeouts, [timers.timeoutHandles[0]]);
  assert.deepEqual(timers.clearedIntervals, [timers.intervalHandles[0]]);

  scheduler.start();
  assert.equal(timers.timeoutHandles.length, 2);
  assert.equal(timers.intervalHandles.length, 2);
});

test("scheduled runner absorbs errors when onError throws", async () => {
  const timers = fakeTimerApi();
  const scheduler = createReleaseDigestScheduler({
    enabled: true,
    timezone: "Asia/Bangkok",
    sendHour: 21,
    repo: {
      async getReleaseDigestRunForLocalDate() {
        throw new Error("tick failed");
      }
    },
    releaseNotesService: {},
    onError() {
      throw new Error("handler failed");
    },
    timerApi: timers
  });

  scheduler.start();

  await assert.doesNotReject(
    timers.runTimeout(new Date("2026-06-19T14:00:00Z"))
  );
});

test("scheduled runner absorbs errors when onError returns a rejected promise", async () => {
  const timers = fakeTimerApi();
  const scheduler = createReleaseDigestScheduler({
    enabled: true,
    timezone: "Asia/Bangkok",
    sendHour: 21,
    repo: {
      async getReleaseDigestRunForLocalDate() {
        throw new Error("tick failed");
      }
    },
    releaseNotesService: {},
    async onError() {
      throw new Error("async handler failed");
    },
    timerApi: timers
  });

  scheduler.start();

  await assert.doesNotReject(
    timers.runInterval(new Date("2026-06-19T14:00:00Z"))
  );
});

test("stop clears future timers while an active tick finishes and releases the lock", async () => {
  const timers = fakeTimerApi();
  let releaseSend;
  let sends = 0;
  const pendingSend = new Promise((resolve) => {
    releaseSend = resolve;
  });
  const scheduler = createReleaseDigestScheduler({
    enabled: true,
    timezone: "Asia/Bangkok",
    sendHour: 21,
    repo: {
      async getReleaseDigestRunForLocalDate() {
        return null;
      }
    },
    releaseNotesService: {
      async sendReleaseDigestSinceLastRun() {
        sends += 1;
        if (sends === 1) await pendingSend;
        return { sent: true };
      }
    },
    timerApi: timers
  });
  const now = new Date("2026-06-19T14:00:00Z");

  scheduler.start();
  const activeTick = timers.runTimeout(now);
  await Promise.resolve();
  scheduler.stop();

  assert.deepEqual(timers.clearedTimeouts, [timers.timeoutHandles[0]]);
  assert.deepEqual(timers.clearedIntervals, [timers.intervalHandles[0]]);
  assert.deepEqual(await scheduler.tick(now), { skipped: true, reason: "running" });

  releaseSend();
  await activeTick;

  assert.deepEqual(await scheduler.tick(now), { sent: true });
  assert.equal(sends, 2);
});

test("disabled scheduler start does not create timers", () => {
  const timers = fakeTimerApi();
  const scheduler = createReleaseDigestScheduler({
    enabled: false,
    timezone: "Asia/Bangkok",
    sendHour: 21,
    checkIntervalMinutes: 15,
    repo: {},
    releaseNotesService: {},
    timerApi: timers
  });

  scheduler.start();
  scheduler.stop();

  assert.equal(timers.timeoutHandles.length, 0);
  assert.equal(timers.intervalHandles.length, 0);
});

function fakeTimerApi() {
  const timeoutCallbacks = [];
  const intervalCallbacks = [];
  const timeoutHandles = [];
  const intervalHandles = [];
  const clearedTimeouts = [];
  const clearedIntervals = [];
  const timeoutDelays = [];
  const intervalDelays = [];

  return {
    timeoutHandles,
    intervalHandles,
    clearedTimeouts,
    clearedIntervals,
    timeoutDelays,
    intervalDelays,
    setTimeout(callback, delay) {
      const handle = { type: "timeout", id: timeoutHandles.length + 1 };
      timeoutHandles.push(handle);
      timeoutCallbacks.push(callback);
      timeoutDelays.push(delay);
      return handle;
    },
    clearTimeout(handle) {
      clearedTimeouts.push(handle);
    },
    setInterval(callback, delay) {
      const handle = { type: "interval", id: intervalHandles.length + 1 };
      intervalHandles.push(handle);
      intervalCallbacks.push(callback);
      intervalDelays.push(delay);
      return handle;
    },
    clearInterval(handle) {
      clearedIntervals.push(handle);
    },
    async runTimeout(now) {
      await timeoutCallbacks.at(-1)(now);
    },
    async runInterval(now) {
      await intervalCallbacks.at(-1)(now);
    }
  };
}
