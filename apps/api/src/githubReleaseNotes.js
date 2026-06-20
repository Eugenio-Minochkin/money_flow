import { validateReleaseNoteInput } from "./releaseNotesService.js";

const AUDIENCES = new Set(["user", "admin", "internal"]);
const RELEASE_HEADING_PATTERN = /^ {0,3}## User Release Notes\s*$/;
const LEVEL_TWO_HEADING_PATTERN = /^ {0,3}##(?:\s|$)/;
const VERSION_PATTERN = /^v\.1\.(\d+)$/;
const VALIDATION_VERSION_FALLBACK = "v.1.18";

export async function fetchGitHubPullRequest({
  repository,
  prNumber,
  token,
  fetchImpl = fetch,
  timeoutMs = 10000
}) {
  const repositoryName = String(repository ?? "").trim();
  const accessToken = String(token ?? "").trim();
  if (!repositoryName) throw new Error("GitHub repository is required");
  if (!accessToken) throw new Error("GitHub token is required");

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
  let response;
  try {
    response = await fetchImpl(
      `https://api.github.com/repos/${repositoryName}/pulls/${prNumber}`,
      {
        method: "GET",
        headers: {
          accept: "application/vnd.github+json",
          authorization: `Bearer ${accessToken}`,
          "x-github-api-version": "2022-11-28"
        },
        signal: controller.signal
      }
    );
  } catch (error) {
    if (controller.signal.aborted) {
      throw new Error("GitHub PR fetch timed out");
    }
    throw error;
  } finally {
    clearTimeout(timeoutId);
  }
  if (!response.ok) {
    throw new Error(`GitHub PR fetch failed with status ${response.status}`);
  }
  return response.json();
}

export function parseUserReleaseNotesBlock(markdown) {
  const lines = stripFencedCodeBlocks(String(markdown ?? "")).split(/\r?\n/);
  const headingIndexes = [];

  for (let index = 0; index < lines.length; index += 1) {
    if (RELEASE_HEADING_PATTERN.test(lines[index])) {
      headingIndexes.push(index);
    }
  }

  if (headingIndexes.length === 0) return null;
  if (headingIndexes.length > 1) {
    throw new Error("Ambiguous User Release Notes blocks");
  }

  const sectionStart = headingIndexes[0] + 1;
  let sectionEnd = lines.length;
  for (let index = sectionStart; index < lines.length; index += 1) {
    if (LEVEL_TWO_HEADING_PATTERN.test(lines[index])) {
      sectionEnd = index;
      break;
    }
  }

  const section = lines.slice(sectionStart, sectionEnd);
  const ruIndex = section.findIndex((line) => /^RU:\s*$/.test(line));
  if (ruIndex === -1) {
    throw new Error("User Release Notes RU bullets are required");
  }

  const enBeforeRu = section.slice(0, ruIndex).some((line) => /^EN:\s*$/.test(line));
  if (enBeforeRu) {
    throw new Error("User Release Notes EN section must follow RU");
  }

  const metadataLines = section.slice(0, ruIndex);
  const audience = metadataField(metadataLines, "audience") || "internal";
  if (!AUDIENCES.has(audience)) {
    throw new Error(`Unsupported release audience: ${audience}`);
  }

  const enIndex = section.findIndex((line, index) => index > ruIndex && /^EN:\s*$/.test(line));
  const ruLines = section.slice(ruIndex + 1, enIndex === -1 ? section.length : enIndex);
  const enLines = enIndex === -1 ? null : section.slice(enIndex + 1);
  const bodyRu = languageBullets(ruLines, "RU");
  const bodyEn = enLines === null ? null : languageBullets(enLines, "EN") || null;

  if (!bodyRu) {
    throw new Error("User Release Notes RU bullets are required");
  }

  const parsed = {
    audience,
    version: metadataField(metadataLines, "version") || null,
    category: metadataField(metadataLines, "category") || null,
    bodyRu,
    bodyEn
  };
  validateReleaseNoteInput({
    version: releaseNoteParserValidationVersion(parsed.version),
    bodyRu: parsed.bodyRu,
    bodyEn: parsed.bodyEn
  });
  return parsed;
}

function releaseNoteParserValidationVersion(version) {
  return parseVersionPatch(version) === null ? VALIDATION_VERSION_FALLBACK : version;
}

export function nextPublicReleaseVersion(latestVersion, requestedVersion) {
  const latestPatch = parseVersionPatch(latestVersion) ?? 17;
  const requestedPatch = parseVersionPatch(requestedVersion);

  if (requestedPatch !== null && requestedPatch > latestPatch) {
    return `v.1.${requestedPatch}`;
  }
  if (latestPatch === Number.MAX_SAFE_INTEGER) {
    throw new Error("Public release version overflow");
  }
  return `v.1.${latestPatch + 1}`;
}

function stripFencedCodeBlocks(markdown) {
  const keptLines = [];
  let fence = null;

  for (const line of markdown.split(/\r?\n/)) {
    if (fence) {
      const closing = /^ {0,3}(`{3,}|~{3,})[ \t]*$/.exec(line);
      if (
        closing &&
        closing[1][0] === fence.marker &&
        closing[1].length >= fence.length
      ) {
        fence = null;
      }
      continue;
    }

    const opening = /^ {0,3}(`{3,}|~{3,})/.exec(line);
    if (opening) {
      fence = {
        marker: opening[1][0],
        length: opening[1].length
      };
      continue;
    }
    keptLines.push(line);
  }

  return keptLines.join("\n");
}

function metadataField(lines, name) {
  const pattern = new RegExp(`^${name}:\\s*(.*?)\\s*$`);
  const values = [];
  for (const line of lines) {
    const match = pattern.exec(line);
    if (match) values.push(match[1]);
  }
  if (values.length > 1) {
    throw new Error(`Duplicate ${name} release note metadata`);
  }
  return values[0] ?? "";
}

function languageBullets(lines, language) {
  const bullets = [];

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    if (!trimmed.startsWith("- ")) {
      throw new Error(`${language} content must contain only "- " bullets`);
    }
    const bullet = trimmed.slice(2).trim();
    if (bullet) bullets.push(bullet);
  }

  return bullets.join("\n");
}

function parseVersionPatch(version) {
  const match = VERSION_PATTERN.exec(typeof version === "string" ? version : "");
  if (!match) return null;
  const patch = Number(match[1]);
  return Number.isSafeInteger(patch) ? patch : null;
}
