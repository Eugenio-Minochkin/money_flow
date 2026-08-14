export function createHistoryLoader(load) {
  let loaded = false;
  let inFlight = null;
  let refreshQueued = false;

  function request(force) {
    if (inFlight) {
      if (force) refreshQueued = true;
      return inFlight;
    }
    if (!force && loaded) return Promise.resolve();

    const current = Promise.resolve(load()).then(() => {
      loaded = true;
    });
    inFlight = current
      .catch((error) => {
        if (!refreshQueued) throw error;
      })
      .finally(() => {
        const runQueuedRefresh = refreshQueued;
        refreshQueued = false;
        inFlight = null;
        if (runQueuedRefresh) return request(true);
      });
    return inFlight;
  }

  return {
    ensure: () => request(false),
    refresh: () => request(true),
    isLoaded: () => loaded,
    hasStarted: () => loaded || Boolean(inFlight)
  };
}
