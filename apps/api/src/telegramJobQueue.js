export function createTelegramJobQueue(options = {}) {
  const globalConcurrency = positiveInteger(options.globalConcurrency, 3);
  const userQueueLimit = positiveInteger(options.userQueueLimit, 16);
  const jobTimeoutMs = positiveInteger(options.jobTimeoutMs, 90_000);
  const globalQueueLimit = Number.isFinite(options.globalQueueLimit) ? Number(options.globalQueueLimit) : Infinity;

  const users = new Map();
  let globalActiveJobs = 0;
  let globalPendingJobs = 0;
  let globalReservedJobs = 0;

  return {
    reserve(userId) {
      const state = userState(userId);
      if (state.pending.length + state.reserved >= userQueueLimit) return { accepted: false, status: "userQueueFull", stats: stats(state) };
      if (globalPendingJobs + globalReservedJobs >= globalQueueLimit) return { accepted: false, status: "globalQueueFull", stats: stats(state) };
      state.reserved += 1;
      globalReservedJobs += 1;
      return { accepted: true, token: { state, released: false }, stats: stats(state) };
    },
    releaseReservation(token) {
      if (!token || token.released) return;
      token.released = true;
      token.state.reserved = Math.max(0, token.state.reserved - 1);
      globalReservedJobs = Math.max(0, globalReservedJobs - 1);
    },
    enqueue({ userId, run, onStart, onFinish, reservation = null }) {
      const state = userState(userId);
      const reserved = reservation?.state === state && !reservation.released;
      if (reserved) {
        reservation.released = true;
        state.reserved -= 1;
        globalReservedJobs -= 1;
      }
      if (!reserved && state.pending.length + state.reserved >= userQueueLimit) {
        return {
          accepted: false,
          status: "userQueueFull",
          stats: stats(state)
        };
      }
      if (!reserved && globalPendingJobs + globalReservedJobs >= globalQueueLimit) {
        return {
          accepted: false,
          status: "globalQueueFull",
          stats: stats(state)
        };
      }

      const queuedAt = nowMs();
      const job = {
        userId,
        run,
        onStart,
        onFinish,
        queuedAt,
        promise: null,
        resolve: null,
        reject: null
      };
      job.promise = new Promise((resolve, reject) => {
        job.resolve = resolve;
        job.reject = reject;
      });

      state.pending.push(job);
      globalPendingJobs += 1;
      const wasBusy = state.active || state.pending.length > 1;
      const status = wasBusy
        ? "queuedBehindPrevious"
        : globalActiveJobs >= globalConcurrency ? "globalQueueDelayed" : "accepted";
      drain();

      return {
        accepted: true,
        status,
        promise: job.promise,
        stats: stats(state)
      };
    }
  };

  function drain() {
    if (globalActiveJobs >= globalConcurrency) return;
    for (const [userId, state] of users) {
      if (globalActiveJobs >= globalConcurrency) return;
      if (state.active || state.pending.length === 0) continue;

      const job = state.pending.shift();
      globalPendingJobs -= 1;
      state.active = job;
      globalActiveJobs += 1;
      const queueWaitMs = Math.max(0, Math.round(nowMs() - job.queuedAt));
      job.onStart?.({
        queueWaitMs,
        queueDepth: globalPendingJobs,
        globalActiveJobs,
        userPendingJobs: state.pending.length
      });

      runWithTimeout(job.run, jobTimeoutMs)
        .then((result) => job.resolve(result))
        .catch((error) => job.reject(error))
        .finally(() => {
          state.active = null;
          globalActiveJobs -= 1;
          job.onFinish?.({
            queueDepth: globalPendingJobs,
            globalActiveJobs,
            userPendingJobs: state.pending.length
          });
          if (!state.active && state.pending.length === 0) {
            users.delete(userId);
          }
          drain();
        });
    }
  }

  function userState(userId) {
    const key = String(userId);
    let state = users.get(key);
    if (!state) {
      state = { active: null, pending: [], reserved: 0 };
      users.set(key, state);
    }
    return state;
  }

  function stats(state) {
    return {
      queueDepth: globalPendingJobs,
      globalActiveJobs,
      userPendingJobs: state.pending.length
    };
  }
}

async function runWithTimeout(run, timeoutMs) {
  const controller = new AbortController();
  let timedOut = false;
  let timeoutId;
  try {
    timeoutId = setTimeout(() => {
      timedOut = true;
      controller.abort(new TelegramJobTimeoutError());
    }, timeoutMs);
    const result = await run({ signal: controller.signal });
    if (timedOut) throw new TelegramJobTimeoutError();
    return result;
  } finally {
    clearTimeout(timeoutId);
  }
}

export class TelegramJobTimeoutError extends Error {
  constructor() {
    super("Telegram job timed out");
    this.code = "telegram_job_timeout";
  }
}

function positiveInteger(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? Math.floor(number) : fallback;
}

function nowMs() {
  return performance.now();
}
