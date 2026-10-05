import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

const run = promisify(execFile);
const benchmarkPath = fileURLToPath(new URL("../scripts/benchmark-telegram-queue.js", import.meta.url));

test("queue benchmark checks concurrent parsing and ordered completion after a slow parser failure", async () => {
  const { stdout } = await run(process.execPath, [benchmarkPath, "--delay-ms", "2000"], { timeout: 10_000 });
  const result = JSON.parse(stdout.trim());

  assert.equal(result.bParsedBeforeARelease, true);
  assert.equal(result.bPersistedAfterATerminal, true);
  assert.equal(result.bDeliveredAfterATerminal, true);
  assert.equal(result.bExpensePersistedExactlyOnce, true);
  assert.deepEqual(result.completionOrder, ["terminal_a", "draft_b", "save_b", "terminal_b"]);
  assert.ok(result.bMutationWaitMs > 0);
});
