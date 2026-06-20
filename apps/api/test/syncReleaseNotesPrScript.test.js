import test from "node:test";
import assert from "node:assert/strict";

import { fetchGitHubPullRequest } from "../src/githubReleaseNotes.js";
import {
  parseSyncPrArgs,
  syncReleaseNotesFromPr,
  validateSyncEnvironment
} from "../scripts/sync-release-notes-pr.js";

test("parses one exact positive PR number", () => {
  assert.deepEqual(parseSyncPrArgs(["--pr=42"]), { prNumber: 42 });

  for (const args of [
    [],
    ["--pr="],
    ["--pr=0"],
    ["--pr=-1"],
    ["--pr=1.5"],
    ["--pr=01"],
    ["--pr=1x"],
    ["--pr=1", "--pr=2"],
    ["--pr=1", "--unknown=value"]
  ]) {
    assert.throws(() => parseSyncPrArgs(args), /--pr|unknown|duplicate/i);
  }
});

test("validates all release sync runtime environment values", () => {
  assert.deepEqual(validateSyncEnvironment({
    DATABASE_URL: "postgres://user:password@db/release",
    GITHUB_TOKEN: "github-secret-token",
    GITHUB_REPOSITORY: "owner/repo"
  }), {
    databaseUrl: "postgres://user:password@db/release",
    token: "github-secret-token",
    githubRepository: "owner/repo"
  });
});

test("requires each release sync runtime environment value without exposing secrets", () => {
  const values = {
    DATABASE_URL: "postgres://secret-user:secret-password@db/release",
    GITHUB_TOKEN: "github-secret-token",
    GITHUB_REPOSITORY: "secret-owner/secret-repo"
  };

  for (const missingName of Object.keys(values)) {
    const env = { ...values, [missingName]: "   " };

    assert.throws(
      () => validateSyncEnvironment(env),
      (error) => {
        assert.match(error.message, new RegExp(`${missingName} is required`));
        for (const secret of Object.values(values)) {
          assert.doesNotMatch(error.message, new RegExp(secret));
        }
        return true;
      }
    );
  }
});

test("fetches a GitHub pull request with REST API headers", async () => {
  const calls = [];
  const pullRequest = { number: 42, title: "History filters", body: "Body" };

  const result = await fetchGitHubPullRequest({
    repository: "owner/repo",
    prNumber: 42,
    token: "top-secret-token",
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      return {
        ok: true,
        async json() {
          return pullRequest;
        }
      };
    }
  });

  assert.deepEqual(result, pullRequest);
  assert.deepEqual(calls, [{
    url: "https://api.github.com/repos/owner/repo/pulls/42",
    options: {
      method: "GET",
      headers: {
        accept: "application/vnd.github+json",
        authorization: "Bearer top-secret-token",
        "x-github-api-version": "2022-11-28"
      }
    }
  }]);
});

test("requires GitHub repository and token", async () => {
  await assert.rejects(
    fetchGitHubPullRequest({
      repository: "",
      prNumber: 42,
      token: "token",
      fetchImpl: async () => assert.fail("fetch should not run")
    }),
    /repository/i
  );
  await assert.rejects(
    fetchGitHubPullRequest({
      repository: "owner/repo",
      prNumber: 42,
      token: "",
      fetchImpl: async () => assert.fail("fetch should not run")
    }),
    /token/i
  );
});

test("GitHub fetch errors include status without exposing the token", async () => {
  const token = "never-log-this-token";

  await assert.rejects(
    fetchGitHubPullRequest({
      repository: "owner/repo",
      prNumber: 42,
      token,
      fetchImpl: async () => ({
        ok: false,
        status: 403,
        async text() {
          return `Denied for ${token}`;
        }
      })
    }),
    (error) => {
      assert.match(error.message, /403/);
      assert.doesNotMatch(error.message, new RegExp(token));
      return true;
    }
  );
});

test("sync repairs a user version and validates the final note before insert", async () => {
  const repository = fakeRepository("v.1.18");

  const result = await syncReleaseNotesFromPr({
    prNumber: 42,
    repository,
    fetchPullRequest: async (prNumber) => {
      assert.equal(prNumber, 42);
      return {
        title: "  History filters  ",
        body: releaseBlock({
          audience: "user",
          version: "invalid",
          bodyRu: "История получила выбор периода.",
          bodyEn: "History now has a period picker."
        })
      };
    }
  });

  assert.equal(result.synced, true);
  assert.equal(result.note.version, "v.1.19");
  assert.deepEqual(repository.inputs, [{
    version: "v.1.19",
    audience: "user",
    category: null,
    titleRu: "History filters",
    titleEn: "History filters",
    bodyRu: "История получила выбор периода.",
    bodyEn: "History now has a period picker.",
    isPublic: true,
    sourceType: "github_pr",
    sourceId: "42"
  }]);
});

test("sync rejects an oversized final assigned version before insert", async () => {
  const repository = fakeRepository(`v.1.${"9".repeat(901)}`);

  await assert.rejects(
    syncReleaseNotesFromPr({
      prNumber: 42,
      repository,
      fetchPullRequest: async () => ({
        title: "Admin update",
        body: releaseBlock({
          audience: "admin",
          bodyRu: "Новая административная команда."
        })
      })
    }),
    /release digest exceeds 900 characters/i
  );
  assert.equal(repository.inputs.length, 0);
});

test("admin and internal notes keep the latest version and remain private", async () => {
  for (const audience of ["admin", "internal"]) {
    const repository = fakeRepository("v.1.25");
    const result = await syncReleaseNotesFromPr({
      prNumber: 9,
      repository,
      fetchPullRequest: async () => ({
        title: "Operations",
        body: releaseBlock({
          audience,
          version: "v.1.99",
          bodyRu: "Внутреннее улучшение."
        })
      })
    });

    assert.equal(result.note.version, "v.1.25");
    assert.equal(result.note.isPublic, false);
    assert.equal(repository.inputs[0].audience, audience);
  }
});

test("admin notes use the baseline version and fallback title when needed", async () => {
  const repository = fakeRepository(null);
  const result = await syncReleaseNotesFromPr({
    prNumber: 7,
    repository,
    fetchPullRequest: async () => ({
      title: "   ",
      body: releaseBlock({
        audience: "admin",
        bodyRu: "Внутреннее улучшение."
      })
    })
  });

  assert.equal(result.note.version, "v.1.18");
  assert.equal(result.note.titleRu, "PR #7");
  assert.equal(result.note.titleEn, "PR #7");
});

test("sync skips a pull request without a release block", async () => {
  let latestVersionCalls = 0;
  const result = await syncReleaseNotesFromPr({
    prNumber: 42,
    repository: {
      async getLatestPublicReleaseVersion() {
        latestVersionCalls += 1;
      }
    },
    fetchPullRequest: async () => ({ title: "Internal", body: "No release block" })
  });

  assert.deepEqual(result, { synced: false, reason: "missing_release_block" });
  assert.equal(latestVersionCalls, 0);
});

test("repeated sync delegates idempotence to the repository source key", async () => {
  const repository = fakeRepository("v.1.18");
  const fetchPullRequest = async () => ({
    title: "History filters",
    body: releaseBlock({
      audience: "user",
      version: "v.1.19",
      bodyRu: "История получила выбор периода."
    })
  });

  const first = await syncReleaseNotesFromPr({
    prNumber: 42,
    repository,
    fetchPullRequest
  });
  const second = await syncReleaseNotesFromPr({
    prNumber: 42,
    repository,
    fetchPullRequest
  });

  assert.equal(first.note.id, "github_pr:42:user");
  assert.equal(second.note.id, first.note.id);
  assert.equal(repository.inputs.length, 2);
  assert.deepEqual(
    repository.inputs.map(({ sourceType, sourceId, audience }) => ({
      sourceType,
      sourceId,
      audience
    })),
    [
      { sourceType: "github_pr", sourceId: "42", audience: "user" },
      { sourceType: "github_pr", sourceId: "42", audience: "user" }
    ]
  );
});

function fakeRepository(latestVersion) {
  return {
    inputs: [],
    async getLatestPublicReleaseVersion() {
      return latestVersion;
    },
    async createReleaseNoteFromSource(input) {
      this.inputs.push(input);
      return {
        id: `${input.sourceType}:${input.sourceId}:${input.audience}`,
        ...input
      };
    }
  };
}

function releaseBlock({
  audience,
  version = null,
  bodyRu,
  bodyEn = null
}) {
  return [
    "## User Release Notes",
    `audience: ${audience}`,
    version ? `version: ${version}` : "",
    "RU:",
    `- ${bodyRu}`,
    bodyEn ? "EN:" : "",
    bodyEn ? `- ${bodyEn}` : ""
  ].filter(Boolean).join("\n");
}
