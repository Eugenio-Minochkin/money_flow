import test from "node:test";
import assert from "node:assert/strict";

import {
  fetchGitHubPullRequest,
  nextPublicReleaseVersion,
  parseUserReleaseNotesBlock
} from "../src/githubReleaseNotes.js";

test("parses metadata and RU and EN bullets from the exact release heading", () => {
  const parsed = parseUserReleaseNotesBlock(`
# Pull request

### User Release Notes
- Not the release block.

## User Release Notes

audience: user
version: v.1.19
category: history

RU:
- История получила выбор периода.
- Фильтры стали понятнее.

EN:
- History now has a period picker.

## Testing
- npm test
`);

  assert.deepEqual(parsed, {
    audience: "user",
    version: "v.1.19",
    category: "history",
    bodyRu: "История получила выбор периода.\nФильтры стали понятнее.",
    bodyEn: "History now has a period picker."
  });
});

test("returns null when the exact release heading is absent", () => {
  assert.equal(parseUserReleaseNotesBlock("Regular PR description"), null);
  assert.equal(parseUserReleaseNotesBlock("## User Release Notes extra"), null);
  assert.equal(parseUserReleaseNotesBlock("### User Release Notes"), null);
  assert.equal(parseUserReleaseNotesBlock("    ## User Release Notes"), null);
});

test("accepts the exact release heading and next H2 with up to three leading spaces", () => {
  const parsed = parseUserReleaseNotesBlock(`
   ## User Release Notes
audience: admin
RU:
- Visible note.

   ## Testing
not release content
`);

  assert.deepEqual(parsed, {
    audience: "admin",
    version: null,
    category: null,
    bodyRu: "Visible note.",
    bodyEn: null
  });
});

test("defaults audience to internal and optional values to null", () => {
  assert.deepEqual(parseUserReleaseNotesBlock(`
## User Release Notes
RU:
- Техническое улучшение.
`), {
    audience: "internal",
    version: null,
    category: null,
    bodyRu: "Техническое улучшение.",
    bodyEn: null
  });
});

test("accepts admin audience without a version", () => {
  const parsed = parseUserReleaseNotesBlock(`
## User Release Notes
audience: admin
category: admin
RU:
- Добавлена административная команда.
`);

  assert.equal(parsed.audience, "admin");
  assert.equal(parsed.version, null);
  assert.equal(parsed.category, "admin");
});

test("rejects unsupported audiences", () => {
  assert.throws(
    () => parseUserReleaseNotesBlock(`
## User Release Notes
audience: public
RU:
- Visible change.
`),
    /Unsupported release audience: public/
  );
});

test("throws when more than one real release heading exists", () => {
  assert.throws(
    () => parseUserReleaseNotesBlock(`
## User Release Notes
RU:
- First.

## User Release Notes
RU:
- Second.
`),
    /ambiguous/i
  );
});

test("ignores release headings and content inside fenced code blocks", () => {
  const parsed = parseUserReleaseNotesBlock(`
   \`\`\`markdown
## User Release Notes
audience: user
RU:
- Example only.
   \`\`\`

## User Release Notes
audience: admin
RU:
- Real note.

\`\`\`
## Another Heading
EN:
not a bullet
\`\`\`
`);

  assert.deepEqual(parsed, {
    audience: "admin",
    version: null,
    category: null,
    bodyRu: "Real note.",
    bodyEn: null
  });
});

test("supports tilde fences and matching fence marker lengths", () => {
  const parsed = parseUserReleaseNotesBlock(`
~~~markdown
## User Release Notes
RU:
- Tilde example only.
\`\`\`
~~
~~~

\`\`\`\`markdown
## User Release Notes
RU:
- Backtick example only.
\`\`\`
~~~~
\`\`\`\`

## User Release Notes
audience: admin
RU:
- Real note.
`);

  assert.deepEqual(parsed, {
    audience: "admin",
    version: null,
    category: null,
    bodyRu: "Real note.",
    bodyEn: null
  });
});

test("requires at least one RU dash bullet", () => {
  assert.throws(
    () => parseUserReleaseNotesBlock(`
## User Release Notes
EN:
- English only.
`),
    /RU bullets are required/
  );
});

test("rejects nonblank non-bullet RU and EN content", () => {
  assert.throws(
    () => parseUserReleaseNotesBlock(`
## User Release Notes
RU:
Plain Russian text.
`),
    /RU content must contain only "- " bullets/
  );

  assert.throws(
    () => parseUserReleaseNotesBlock(`
## User Release Notes
RU:
- Valid.
EN:
- Valid.
Plain English text.
`),
    /EN content must contain only "- " bullets/
  );
});

test("only reads metadata before the RU section", () => {
  assert.throws(
    () => parseUserReleaseNotesBlock(`
## User Release Notes
RU:
- Valid.
audience: user
`),
    /RU content must contain only "- " bullets/
  );
});

test("rejects duplicate release note metadata fields", () => {
  for (const [field, first, second] of [
    ["audience", "admin", "admin"],
    ["version", "v.1.19", "v.1.20"],
    ["category", "history", "history"]
  ]) {
    assert.throws(
      () => parseUserReleaseNotesBlock(`
## User Release Notes
${field}: ${first}
${field}: ${second}
RU:
- Valid.
`),
      new RegExp(`duplicate ${field}`, "i")
    );
  }
});

test("propagates release note bullet count and length limits", () => {
  const sevenBullets = Array.from({ length: 7 }, (_, index) => `- Change ${index + 1}.`).join("\n");

  assert.throws(
    () => parseUserReleaseNotesBlock(`
## User Release Notes
RU:
${sevenBullets}
`),
    /RU release notes exceed 6 bullets/
  );

  assert.throws(
    () => parseUserReleaseNotesBlock(`
## User Release Notes
RU:
- ${"a".repeat(121)}
`),
    /RU release note bullet exceeds 120 characters/
  );
});

test("preserves malformed oversized versions for sync to repair", () => {
  const version = `v.${"x".repeat(900)}`;
  const parsed = parseUserReleaseNotesBlock(`
## User Release Notes
audience: user
version: ${version}
RU:
- Short improvement.
`);

  assert.equal(parsed.version, version);
  assert.equal(parsed.bodyRu, "Short improvement.");
});

test("uses a valid requested public version only when it advances latest", () => {
  assert.equal(nextPublicReleaseVersion("v.1.18", "v.1.20"), "v.1.20");
  assert.equal(nextPublicReleaseVersion("v.1.18", "v.1.18"), "v.1.19");
  assert.equal(nextPublicReleaseVersion("v.1.18", "v.1.17"), "v.1.19");
  assert.equal(nextPublicReleaseVersion("v.1.18", "v0.1.20"), "v.1.19");
});

test("uses patch 17 as the invalid or absent latest-version baseline", () => {
  assert.equal(nextPublicReleaseVersion(null, null), "v.1.18");
  assert.equal(nextPublicReleaseVersion("invalid", null), "v.1.18");
  assert.equal(nextPublicReleaseVersion("v.1.9007199254740992", null), "v.1.18");
  assert.equal(nextPublicReleaseVersion(null, "v.1.19"), "v.1.19");
});

test("requires exact safe-integer requested versions", () => {
  assert.equal(nextPublicReleaseVersion("v.1.18", "v.1.19x"), "v.1.19");
  assert.equal(nextPublicReleaseVersion("v.1.18", " v.1.20"), "v.1.19");
  assert.equal(nextPublicReleaseVersion("v.1.18", "v.1.9007199254740992"), "v.1.19");
});

test("throws instead of overflowing the latest safe patch", () => {
  assert.throws(
    () => nextPublicReleaseVersion(`v.1.${Number.MAX_SAFE_INTEGER}`, null),
    /overflow/i
  );
});

test("GitHub PR fetch aborts after its timeout without exposing the token", async () => {
  const token = "never-expose-timeout-token";
  let receivedSignal = null;

  await assert.rejects(
    fetchGitHubPullRequest({
      repository: "owner/repo",
      prNumber: 42,
      token,
      timeoutMs: 5,
      fetchImpl: async (_url, options) => {
        receivedSignal = options.signal;
        await new Promise((resolve, reject) => {
          options.signal.addEventListener("abort", () => {
            reject(options.signal.reason);
          }, { once: true });
        });
      }
    }),
    (error) => {
      assert.equal(error.message, "GitHub PR fetch timed out");
      assert.doesNotMatch(error.message, new RegExp(token));
      return true;
    }
  );

  assert.equal(receivedSignal?.aborted, true);
});
