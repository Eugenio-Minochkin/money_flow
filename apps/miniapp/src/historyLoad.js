export function createHistoryLoader(load, onState = () => {}) {
  let loaded = false;
  let inFlight = null;
  let refreshQueued = false;

  function request(force) {
    if (inFlight) {
      if (force) {
        refreshQueued = true;
        onState("loading");
      }
      return inFlight;
    }
    if (!force && loaded) return Promise.resolve();

    onState("loading");
    let succeeded = false;
    let loadResult;
    try {
      loadResult = load();
    } catch (error) {
      loadResult = Promise.reject(error);
    }
    const current = Promise.resolve(loadResult).then(() => {
      loaded = true;
      succeeded = true;
    });
    inFlight = current
      .catch((error) => {
        if (!refreshQueued) {
          onState("error");
          throw error;
        }
      })
      .finally(() => {
        const runQueuedRefresh = refreshQueued;
        refreshQueued = false;
        inFlight = null;
        if (runQueuedRefresh) return request(true);
        if (succeeded) onState("loaded");
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
