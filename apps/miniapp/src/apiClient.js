export function createApiClient({
  getInitData = () => window.Telegram?.WebApp?.initData,
  fetchImpl = fetch
} = {}) {
  return async function api(path, options = {}) {
    const initData = getInitData();
    const response = await fetchImpl(path, {
      method: options.method ?? "GET",
      headers: {
        ...(options.body ? { "content-type": "application/json" } : {}),
        ...(initData ? { "x-telegram-init-data": initData } : {})
      },
      body: options.body ? JSON.stringify(options.body) : undefined
    });
    if (!response.ok) {
      const body = await response.json().catch(() => ({}));
      const error = new Error(body.error ?? "Не удалось выполнить запрос.");
      error.status = response.status;
      error.body = body;
      throw error;
    }
    return response.json();
  };
}
