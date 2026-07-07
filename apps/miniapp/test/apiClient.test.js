import test from "node:test";
import assert from "node:assert/strict";

import { createApiClient } from "../src/apiClient.js";

test("API client sends Telegram init data header and JSON body", async () => {
  const calls = [];
  const api = createApiClient({
    getInitData: () => "signed-init-data",
    fetchImpl: async (...args) => {
      calls.push(args);
      return response(200, { ok: true });
    }
  });

  const result = await api("/api/settings", { method: "PATCH", body: { telegramUserId: 100 } });

  assert.deepEqual(result, { ok: true });
  assert.equal(calls[0][0], "/api/settings");
  assert.equal(calls[0][1].method, "PATCH");
  assert.equal(calls[0][1].headers["content-type"], "application/json");
  assert.equal(calls[0][1].headers["x-telegram-init-data"], "signed-init-data");
  assert.equal(calls[0][1].body, JSON.stringify({ telegramUserId: 100 }));
});

test("API client raises API error message from response body", async () => {
  const api = createApiClient({
    getInitData: () => "",
    fetchImpl: async () => response(400, { error: "telegram_init_data_required" })
  });

  await assert.rejects(
    () => api("/api/dashboard"),
    /telegram_init_data_required/
  );
});

test("API client attaches status and body to thrown errors", async () => {
  const api = createApiClient({
    getInitData: () => "",
    fetchImpl: async () => response(409, { error: "draft_version_conflict", draft: { id: 1, version: 5 } })
  });
  await assert.rejects(
    () => api("/api/drafts/1", { method: "PATCH", body: { telegramUserId: 100 } }),
    (error) => error.status === 409 && error.body?.error === "draft_version_conflict"
  );
});

test("API client does not send browser timezone implicitly", async () => {
  let request;
  const api = createApiClient({
    getInitData: () => "signed",
    fetchImpl: async (path, options) => {
      request = { path, options };
      return { ok: true, json: async () => ({ ok: true }) };
    }
  });

  await api("/api/dashboard");

  assert.equal(request.options.headers["x-user-timezone"], undefined);
});

function response(status, body) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async json() {
      return body;
    }
  };
}
