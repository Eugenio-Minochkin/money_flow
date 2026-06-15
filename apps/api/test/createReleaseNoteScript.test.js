import test from "node:test";
import assert from "node:assert/strict";

import { parseReleaseNoteArgs } from "../scripts/create-release-note.js";

test("parses release note create script arguments", () => {
  const parsed = parseReleaseNoteArgs([
    "--version=v.1.18",
    "--title-ru=Обновление онбординга",
    "--title-en=Onboarding update",
    "--body-ru=Стало проще.",
    "--body-en=Now simpler.",
    "--audience=user",
    "--category=onboarding"
  ]);

  assert.deepEqual(parsed, {
    version: "v.1.18",
    titleRu: "Обновление онбординга",
    titleEn: "Onboarding update",
    bodyRu: "Стало проще.",
    bodyEn: "Now simpler.",
    audience: "user",
    category: "onboarding",
    isPublic: true
  });
});

test("release note create script requires version title ru and body ru", () => {
  assert.throws(
    () => parseReleaseNoteArgs(["--version=v.1.18", "--title-ru=Обновление"]),
    /Missing required arguments: --body-ru/
  );
});

test("release note create script supports private flag", () => {
  const parsed = parseReleaseNoteArgs([
    "--version=v.1.18",
    "--title-ru=Внутреннее",
    "--body-ru=Не для пользователей.",
    "--private"
  ]);

  assert.equal(parsed.isPublic, false);
});
