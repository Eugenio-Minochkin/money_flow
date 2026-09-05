export function createTelegramJobQueue(options = {}) {
  const globalConcurrency = positiveInteger(options.globalConcurrency, 3);
  const userQueueLimit = positiveInteger(options.userQueueLimit, 16);
  const jobTimeoutMs = positiveInteger(options.jobTimeoutMs, 90_000);
  const globalQueueLimit = Number.isFinite(options.globalQueueLimit) ? Number(options.globalQueueLimit) : Infinity;

  const users = new Map();
  let globalActiveJobs = 0;
  let globalPendingJobs = 0;

  return {
    enqueue({ userId, run, onStart, onFinish }) {
      const state = userState(userId);
      if (state.pending.length >= userQueueLimit) {
        return {
          accepted: false,
          status: "userQueueFull",
          stats: stats(state)
        };
      }
      if (globalPendingJobs >= globalQueueLimit) {
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
      state = { active: null, pending: [] };
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
  let timeoutId;
  try {
    return await Promise.race([
      run(),
      new Promise((_, reject) => {
        timeoutId = setTimeout(() => reject(new Error("Telegram job timed out")), timeoutMs);
      })
    ]);
  } finally {
    clearTimeout(timeoutId);
  }
}

function positiveInteger(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? Math.floor(number) : fallback;
}

function nowMs() {
  return performance.now();
}
