import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  parseReleaseDigestCheckIntervalMinutes,
  parseReleaseDigestSendHour
} from "../src/config.js";

test("release digest send hour accepts only integers from 0 through 23", () => {
  assert.equal(parseReleaseDigestSendHour("0"), 0);
  assert.equal(parseReleaseDigestSendHour("23"), 23);
  assert.equal(parseReleaseDigestSendHour("12.5"), 21);
  assert.equal(parseReleaseDigestSendHour("-1"), 21);
  assert.equal(parseReleaseDigestSendHour("24"), 21);
  assert.equal(parseReleaseDigestSendHour("not-a-number"), 21);
  assert.equal(parseReleaseDigestSendHour(undefined), 21);
});

test("release digest check interval accepts only positive finite numbers", () => {
  assert.equal(parseReleaseDigestCheckIntervalMinutes("0.5"), 0.5);
  assert.equal(parseReleaseDigestCheckIntervalMinutes("30"), 30);
  assert.equal(parseReleaseDigestCheckIntervalMinutes("0"), 15);
  assert.equal(parseReleaseDigestCheckIntervalMinutes("-1"), 15);
  assert.equal(parseReleaseDigestCheckIntervalMinutes("Infinity"), 15);
  assert.equal(parseReleaseDigestCheckIntervalMinutes("not-a-number"), 15);
  assert.equal(parseReleaseDigestCheckIntervalMinutes(undefined), 15);
});

test("server wires the release digest scheduler with Telegram token gating", async () => {
  const source = await readFile(new URL("../src/server.js", import.meta.url), "utf8");

  assert.match(source, /import \{ createReleaseDigestScheduler \} from "\.\/releaseDigestScheduler\.js";/);
  assert.match(
    source,
    /enabled:\s*config\.releaseDigestAutoSendEnabled\s*&&\s*Boolean\(config\.telegramBotToken\)/
  );
  assert.match(source, /releaseDigestScheduler\.start\(\)/);
  assert.match(source, /\[release-digest\] scheduler failed/);
});
