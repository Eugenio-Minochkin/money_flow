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
    createAdmissionTicket(userId) {
      const state = userState(userId);
      const ticket = { state, userId: String(userId), released: false, claimReleased: false, order: state.nextOrder++, job: null };
      ticket.claimReady = state.lastAdmissionClaim ?? Promise.resolve();
      ticket.releaseClaim = null;
      const claimReleased = new Promise((resolve) => { ticket.releaseClaim = resolve; });
      // A skipped ticket may finish early, but must preserve earlier claim dependencies.
      state.lastAdmissionClaim = ticket.claimReady.then(() => claimReleased);
      state.admissions.push(ticket);
      return ticket;
    },
    waitForAdmissionTicket(ticket) {
      return ticket?.claimReady ?? Promise.resolve();
    },
    releaseAdmissionTurn(ticket) {
      if (!ticket || ticket.claimReleased) return;
      ticket.claimReleased = true;
      ticket.releaseClaim?.();
    },
    releaseAdmissionTicket(ticket) {
      if (!ticket || ticket.released || ticket.job) return;
      this.releaseAdmissionTurn(ticket);
      finishAdmission(ticket);
      drain();
    },
    reserve(userId, admissionTicket = null) {
      const state = userState(userId);
      if (state.pending.length + state.reserved >= userQueueLimit) return { accepted: false, status: "userQueueFull", stats: stats(state) };
      if (globalPendingJobs + globalReservedJobs >= globalQueueLimit) return { accepted: false, status: "globalQueueFull", stats: stats(state) };
      state.reserved += 1;
      globalReservedJobs += 1;
      const admission = admissionTicket?.state === state && !admissionTicket.released
        ? admissionTicket
        : this.createAdmissionTicket(userId);
      return { accepted: true, token: { state, admission, released: false }, stats: stats(state) };
    },
    releaseReservation(token) {
      if (!token || token.released) return;
      token.released = true;
      token.state.reserved = Math.max(0, token.state.reserved - 1);
      globalReservedJobs = Math.max(0, globalReservedJobs - 1);
      finishAdmission(token.admission);
      drain();
    },
    enqueue({ userId, run, onStart, onFinish, reservation = null, admissionTicket = null, independent = false }) {
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

      const admission = reserved ? reservation.admission
        : (admissionTicket?.state === state && !admissionTicket.released ? admissionTicket : this.createAdmissionTicket(userId));
      if (!reserved && !state.admissions.includes(admission)) state.admissions.push(admission);

      const queuedAt = nowMs();
      const job = {
        userId,
        admission,
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
      admission.job = job;

      state.pending.push(job);
      state.pending.sort((left, right) => left.admission.order - right.admission.order);
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
        if (job && state.admissions.some((admission) => admission.order < job.admission.order && !admission.job)) continue;
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
        runWithTimeout(({ signal, pauseTimeout }) => job.run({
          signal,
          acquireMutation: (options) => acquireMutation(state, job, signal, pauseTimeout, options)
        }), jobTimeoutMs)
          .then((result) => job.resolve(result))
          .catch((error) => job.reject(error))
          .finally(() => {
            job.releaseMutation?.();
            state.active.delete(job);
            globalActiveJobs -= 1;
            finishAdmission(job.admission);
            job.onFinish?.({ queueDepth: globalPendingJobs, globalActiveJobs, userPendingJobs: state.pending.length });
            drain();
          });
      }
    } while (progressed && globalActiveJobs < globalConcurrency);
  }

  function acquireMutation(state, job, signal, pauseTimeout, { ignoreAbort = false } = {}) {
    if (signal.aborted && !ignoreAbort) return Promise.reject(signal.reason);
    if (job.releaseMutation) return Promise.resolve(job.releaseMutation);
    const waiting = new Promise((resolve, reject) => {
      const waiter = { grant, abort, job };
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
          grantNextMutation(state);
        };
        job.releaseMutation = release;
        resolve(release);
      }
      if (!state.mutationOwner && state.admissions[0] === job.admission) grant();
      else {
        state.mutationWaiters.push(waiter);
        if (!ignoreAbort) signal.addEventListener("abort", abort, { once: true });
      }
    });
    return pauseTimeout ? pauseTimeout(waiting) : waiting;
  }

  function userState(userId) {
    const key = String(userId);
    let state = users.get(key);
    if (!state) {
      state = { active: new Set(), pending: [], reserved: 0, mutationOwner: null, mutationWaiters: [], admissions: [], nextOrder: 0 };
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

  function finishAdmission(admission) {
    if (admission.released) return;
    admission.released = true;
    const state = admission.state;
    if (!admission.claimReleased) {
      admission.claimReleased = true;
      admission.releaseClaim?.();
    }
    const index = state.admissions.indexOf(admission);
    if (index >= 0) state.admissions.splice(index, 1);
    grantNextMutation(state);
    if (state.active.size === 0 && state.pending.length === 0 && state.reserved === 0 && state.admissions.length === 0) {
      const key = String(admission.job?.userId ?? admission.userId ?? "");
      if (users.get(key) === state) users.delete(key);
    }
  }

  function grantNextMutation(state) {
    if (state.mutationOwner) return;
    const head = state.admissions[0];
    const index = state.mutationWaiters.findIndex((waiter) => waiter.job.admission === head);
    if (index >= 0) state.mutationWaiters.splice(index, 1)[0].grant();
  }
}

async function runWithTimeout(run, timeoutMs) {
  const controller = new AbortController();
  let timedOut = false;
  let timeoutId;
  let deadline = Date.now() + timeoutMs;
  const armTimer = () => {
    timeoutId = setTimeout(() => {
      timedOut = true;
      controller.abort(new TelegramJobTimeoutError());
    }, Math.max(0, deadline - Date.now()));
  };
  const pauseTimeout = async (promise) => {
    clearTimeout(timeoutId);
    const remaining = Math.max(0, deadline - Date.now());
    try { return await promise; }
    finally {
      deadline = Date.now() + remaining;
      if (!controller.signal.aborted) armTimer();
    }
  };
  try {
    armTimer();
    const result = await run({ signal: controller.signal, pauseTimeout });
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
