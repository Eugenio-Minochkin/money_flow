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
    enqueue({ userId, run, onStart, onFinish, reservation = null, independent = false }) {
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
        // A barrier can change how following text must be interpreted. Keep
        // already-admitted successors serial until that backlog is drained.
        independent: independent && !state.pending.some((pending) => !pending.independent)
          && ![...state.active].some((active) => !active.independent),
        started: false,
        releaseMutation: null,
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
      drain();
      const status = job.started ? "accepted"
        : state.active.size > 0 || state.pending[0] !== job ? "queuedBehindPrevious" : "globalQueueDelayed";

      return {
        accepted: true,
        status,
        promise: job.promise,
        stats: stats(state)
      };
    }
  };

  function drain() {
    // One job per user per pass keeps available capacity fair across users.
    let progressed;
    do {
      progressed = false;
      for (const [userId, state] of users) {
        if (globalActiveJobs >= globalConcurrency) return;
        const job = state.pending[0];
        if (!job || (state.active.size > 0 && (!job.independent
          || state.active.size >= 2 || [...state.active].some((active) => !active.independent)))) continue;
        state.pending.shift();
        globalPendingJobs -= 1;
        state.active.add(job);
        job.started = true;
        globalActiveJobs += 1;
        progressed = true;
        const queueWaitMs = Math.max(0, Math.round(nowMs() - job.queuedAt));
        job.onStart?.({ queueWaitMs, queueDepth: globalPendingJobs, globalActiveJobs, userPendingJobs: state.pending.length });
        runWithTimeout(({ signal }) => job.run({
          signal,
          acquireMutation: () => acquireMutation(state, job, signal)
        }), jobTimeoutMs)
          .then((result) => job.resolve(result))
          .catch((error) => job.reject(error))
          .finally(() => {
            job.releaseMutation?.();
            state.active.delete(job);
            globalActiveJobs -= 1;
            job.onFinish?.({ queueDepth: globalPendingJobs, globalActiveJobs, userPendingJobs: state.pending.length });
            if (state.active.size === 0 && state.pending.length === 0 && state.reserved === 0) users.delete(userId);
            drain();
          });
      }
    } while (progressed && globalActiveJobs < globalConcurrency);
  }

  function acquireMutation(state, job, signal) {
    if (signal.aborted) return Promise.reject(signal.reason);
    if (job.releaseMutation) return Promise.resolve(job.releaseMutation);
    return new Promise((resolve, reject) => {
      const waiter = { grant, abort };
      function abort() {
        const index = state.mutationWaiters.indexOf(waiter);
        if (index >= 0) state.mutationWaiters.splice(index, 1);
        signal.removeEventListener("abort", abort);
        reject(signal.reason);
      }
      function grant() {
        signal.removeEventListener("abort", abort);
        state.mutationOwner = job;
        let released = false;
        const release = () => {
          if (released) return;
          released = true;
          job.releaseMutation = null;
          state.mutationOwner = null;
          state.mutationWaiters.shift()?.grant();
        };
        job.releaseMutation = release;
        resolve(release);
      }
      if (!state.mutationOwner) grant();
      else {
        state.mutationWaiters.push(waiter);
        signal.addEventListener("abort", abort, { once: true });
      }
    });
  }

  function userState(userId) {
    const key = String(userId);
    let state = users.get(key);
    if (!state) {
      state = { active: new Set(), pending: [], reserved: 0, mutationOwner: null, mutationWaiters: [] };
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
