import test from "node:test";
import assert from "node:assert/strict";

import { assertDevDatabase, isDevMode, isProductionDatabaseUrl } from "../src/devSafety.js";
import { handleDevRoute } from "../src/devRoutes.js";

test("dev mode is disabled when NODE_ENV is production", () => {
  assert.equal(isDevMode({ NODE_ENV: "production" }), false);
  assert.throws(
    () => assertDevDatabase({ NODE_ENV: "production", DATABASE_URL: "postgres://localhost/money_flow" }),
    /disabled in production/
  );
});

test("production-looking database URLs are blocked for dev reset", () => {
  assert.equal(isProductionDatabaseUrl("postgres://money_flow:secret@localhost:5432/money_flow"), false);
  assert.equal(isProductionDatabaseUrl("postgres://user:secret@db.example.com:5432/money_flow"), true);
  assert.throws(
    () => assertDevDatabase({ NODE_ENV: "development", DATABASE_URL: "postgres://user:secret@prod.example.com/money_flow" }),
    /production-like DATABASE_URL/
  );
});

test("dev route returns not found when production mode is active", async () => {
  const originalNodeEnv = process.env.NODE_ENV;
  process.env.NODE_ENV = "production";
  const res = fakeResponse();
  try {
    const handled = await handleDevRoute({
      req: { method: "GET" },
      res,
      url: new URL("http://localhost:3000/dev"),
      readJson: async () => ({}),
      repository: {},
      createBot: () => ({}),
      serveStatic: async () => {
        throw new Error("static should not be served");
      }
    });

    assert.equal(handled, true);
    assert.equal(res.statusCode, 404);
  } finally {
    if (originalNodeEnv === undefined) {
      delete process.env.NODE_ENV;
    } else {
      process.env.NODE_ENV = originalNodeEnv;
    }
  }
});

function fakeResponse() {
  return {
    statusCode: null,
    headers: null,
    body: "",
    writeHead(statusCode, headers) {
      this.statusCode = statusCode;
      this.headers = headers;
    },
    end(body) {
      this.body = body;
    }
  };
}
