import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  fetchGitHubPullRequest,
  nextPublicReleaseVersion,
  parseUserReleaseNotesBlock
} from "../src/githubReleaseNotes.js";
import { validateReleaseNoteInput } from "../src/releaseNotesService.js";

const INTERNAL_VERSION_FALLBACK = "v.1.18";
const MAX_PUBLIC_VERSION_ATTEMPTS = 5;
const PUBLIC_VERSION_CONSTRAINT = "release_notes_public_version_unique";

export function parseSyncPrArgs(args) {
  let prNumber = null;

  for (const arg of args) {
    const match = /^--pr=([1-9]\d*)$/.exec(arg);
    if (!match) {
      if (arg.startsWith("--pr=")) {
        throw new Error("--pr must be an exact positive integer");
      }
      throw new Error(`Unknown argument: ${arg}`);
    }
    if (prNumber !== null) throw new Error("Duplicate --pr argument");

    const parsed = Number(match[1]);
    if (!Number.isSafeInteger(parsed)) {
      throw new Error("--pr must be an exact positive integer");
    }
    prNumber = parsed;
  }

  if (prNumber === null) throw new Error("--pr is required");
  return { prNumber };
}

export function validateSyncEnvironment(env) {
  const databaseUrl = String(env?.DATABASE_URL ?? "").trim();
  const token = String(env?.GITHUB_TOKEN ?? "").trim();
  const githubRepository = String(env?.GITHUB_REPOSITORY ?? "").trim();

  if (!databaseUrl) throw new Error("DATABASE_URL is required");
  if (!token) throw new Error("GITHUB_TOKEN is required");
  if (!githubRepository) throw new Error("GITHUB_REPOSITORY is required");

  return { databaseUrl, token, githubRepository };
}

export async function syncReleaseNotesFromPr({
  prNumber,
  repository,
  fetchPullRequest
}) {
  const pullRequest = await fetchPullRequest(prNumber);
  const parsed = parseUserReleaseNotesBlock(pullRequest?.body);
  if (!parsed) {
    return { synced: false, reason: "missing_release_block" };
  }

  const isPublic = parsed.audience === "user";
  const title = String(pullRequest?.title ?? "").trim() || `PR #${prNumber}`;

  if (isPublic) {
    for (let attempt = 1; attempt <= MAX_PUBLIC_VERSION_ATTEMPTS; attempt += 1) {
      const latestVersion = await repository.getLatestPublicReleaseVersion();
      const input = buildReleaseNoteInput({
        parsed,
        prNumber,
        title,
        version: nextPublicReleaseVersion(latestVersion, parsed.version),
        isPublic
      });
      validateReleaseNoteInput(input);

      try {
        const note = await repository.createReleaseNoteFromSource(input);
        return { synced: true, note };
      } catch (error) {
        if (!isPublicVersionConflict(error)) throw error;
        if (attempt === MAX_PUBLIC_VERSION_ATTEMPTS) {
          throw new Error(
            `Failed to allocate a unique public release version after ${MAX_PUBLIC_VERSION_ATTEMPTS} attempts`,
            { cause: error }
          );
        }
      }
    }
  }

  const latestVersion = await repository.getLatestPublicReleaseVersion();
  const input = buildReleaseNoteInput({
    parsed,
    prNumber,
    title,
    version: latestVersion ?? INTERNAL_VERSION_FALLBACK,
    isPublic
  });
  validateReleaseNoteInput(input);
  const note = await repository.createReleaseNoteFromSource(input);
  return { synced: true, note };
}

function buildReleaseNoteInput({ parsed, prNumber, title, version, isPublic }) {
  return {
    version,
    audience: parsed.audience,
    category: parsed.category,
    titleRu: title,
    titleEn: title,
    bodyRu: parsed.bodyRu,
    bodyEn: parsed.bodyEn,
    isPublic,
    sourceType: "github_pr",
    sourceId: String(prNumber)
  };
}

function isPublicVersionConflict(error) {
  return error?.code === "23505" && error?.constraint === PUBLIC_VERSION_CONSTRAINT;
}

async function main() {
  const { prNumber } = parseSyncPrArgs(process.argv.slice(2));
  const { token, githubRepository } = validateSyncEnvironment(process.env);

  const [{ closeDb, pool }, { createRepository }] = await Promise.all([
    import("../src/db.js"),
    import("../src/repository.js")
  ]);

  try {
    const repository = createRepository(pool);
    const result = await syncReleaseNotesFromPr({
      prNumber,
      repository,
      fetchPullRequest: (number) => fetchGitHubPullRequest({
        repository: githubRepository,
        prNumber: number,
        token
      })
    });

    if (!result.synced) {
      console.warn(`PR #${prNumber}: release notes block missing`);
      return;
    }
    console.log(
      `PR #${prNumber}: synced ${result.note.audience} ${result.note.version}`
    );
  } finally {
    await closeDb();
  }
}

if (process.argv[1] && resolve(fileURLToPath(import.meta.url)) === resolve(process.argv[1])) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
