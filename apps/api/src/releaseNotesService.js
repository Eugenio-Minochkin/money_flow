const USER_AUDIENCE = "user";
const ADMIN_AUDIENCE = "admin";
const INTERNAL_AUDIENCE = "internal";
const INTERNAL_DEFAULT_CATEGORIES = new Set(["internal", "infra", "analytics"]);

export const MAX_BULLETS = 6;
export const MAX_BULLET_CHARS = 120;
export const MAX_MESSAGE_CHARS = 900;

export function normalizeReleaseNoteInput(input = {}) {
  const category = input.category ? String(input.category).trim() : null;
  return {
    version: input.version,
    titleRu: input.titleRu,
    titleEn: input.titleEn ?? null,
    bodyRu: input.bodyRu,
    bodyEn: input.bodyEn ?? null,
    isPublic: input.isPublic !== false,
    audience: normalizeAudience(input.audience ?? defaultAudienceForCategory(category)),
    category
  };
}

export function formatReleaseDigest(releaseNotes, language = "ru") {
  const notes = Array.isArray(releaseNotes) ? releaseNotes : [];
  const lang = language === "en" ? "en" : "ru";
  const version = notes.at(-1)?.version ?? "";
  const heading = lang === "en" ? "What's new:" : "Что нового:";
  const bullets = notes
    .flatMap((note) => bodyLinesForLanguage(note, lang))
    .map((line) => `• ${line}`);

  return [
    `✨ Money Flow ${version}`.trim(),
    "",
    heading,
    "",
    bullets.join("\n")
  ].join("\n").trim();
}

export function validateReleaseNoteContent(input) {
  const ruLines = bodyLines(input.bodyRu);
  if (ruLines.length === 0) {
    throw new Error("RU release notes require at least one bullet");
  }

  for (const [label, body] of [["RU", input.bodyRu], ["EN", input.bodyEn]]) {
    if (!body) continue;
    const lines = bodyLines(body);
    if (lines.length > MAX_BULLETS) {
      throw new Error(`${label} release notes exceed ${MAX_BULLETS} bullets`);
    }
    if (lines.some((line) => graphemeLength(line) > MAX_BULLET_CHARS)) {
      throw new Error(`${label} release note bullet exceeds ${MAX_BULLET_CHARS} characters`);
    }
  }
  return input;
}

export function validateReleaseNoteInput(input) {
  validateReleaseNoteContent(input);
  const note = {
    version: input.version,
    body_ru: input.bodyRu,
    body_en: input.bodyEn
  };
  for (const language of ["ru", "en"]) {
    if (graphemeLength(formatReleaseDigest([note], language)) > MAX_MESSAGE_CHARS) {
      throw new Error(`${language.toUpperCase()} release digest exceeds ${MAX_MESSAGE_CHARS} characters`);
    }
  }
  return input;
}

export function selectDigestReleaseNotes(notes) {
  const selected = [];
  for (const note of Array.isArray(notes) ? notes : []) {
    validateReleaseNoteContent({
      bodyRu: note.body_ru,
      bodyEn: note.body_en
    });
    const candidate = [...selected, note];
    const ruBulletCount = candidate.flatMap((item) => bodyLinesForLanguage(item, "ru")).length;
    const enBulletCount = candidate.flatMap((item) => bodyLinesForLanguage(item, "en")).length;
    if (ruBulletCount > MAX_BULLETS || enBulletCount > MAX_BULLETS) break;
    if (
      graphemeLength(formatReleaseDigest(candidate, "ru")) > MAX_MESSAGE_CHARS ||
      graphemeLength(formatReleaseDigest(candidate, "en")) > MAX_MESSAGE_CHARS
    ) break;
    selected.push(note);
  }
  return selected;
}

export function hiddenReleaseNoteLabel(note) {
  return `${note.audience}: ${note.title_ru}`;
}

export function createReleaseNotesService({ repository, sendMessage } = {}) {
  return {
    async createReleaseNote(input) {
      const normalized = normalizeReleaseNoteInput(input);
      validateReleaseNoteInput(normalized);
      return repository.createReleaseNote(normalized);
    },
    async previewTodayReleaseDigest(now = new Date()) {
      const releaseNotes = await repository.getTodayUnsentPublicReleaseNotes(now);
      const hiddenNotes = await repository.getTodayHiddenReleaseNotes(now);
      if (releaseNotes.length === 0) {
        return {
          hasPublicNotes: false,
          hiddenNotes,
          text: [
            "Сегодня нет release notes — пуш пользователям отправляться не будет.",
            hiddenNotesBlock(hiddenNotes)
          ].filter(Boolean).join("\n\n")
        };
      }

      return {
        hasPublicNotes: true,
        releaseNotes,
        hiddenNotes,
        text: [
          "Пользователям будет отправлено:",
          "",
          formatReleaseDigest(releaseNotes, "ru"),
          hiddenNotesBlock(hiddenNotes)
        ].filter(Boolean).join("\n")
      };
    },
    async sendTodayReleaseDigest(now = new Date()) {
      const releaseNotes = await repository.getTodayUnsentPublicReleaseNotes(now);
      if (releaseNotes.length === 0) {
        return {
          sent: false,
          reason: "no_public_release_notes",
          version: null,
          users: 0,
          success: 0,
          errors: 0,
          blocked: 0
        };
      }
      return this.sendReleaseNotesToActiveUsers(releaseNotes);
    },
    async sendReleaseNotesToActiveUsers(releaseNotesInput) {
      if (!sendMessage) throw new Error("sendMessage is required");
      const releaseNotes = Array.isArray(releaseNotesInput) ? releaseNotesInput : [];
      const users = await repository.getActiveUsersForReleasePush();
      const summary = {
        sent: true,
        version: releaseNotes[0]?.version ?? null,
        users: users.length,
        success: 0,
        errors: 0,
        blocked: 0
      };

      for (const user of users) {
        for (const note of releaseNotes) {
          if (await repository.hasReleaseNoteDelivery(note.id, user.id)) continue;
          try {
            await sendMessage({
              chatId: Number(user.telegram_user_id),
              text: formatReleaseDigest([note], user.interface_language),
              user,
              releaseNote: note
            });
            await repository.markReleaseNoteDelivered(note.id, user.id);
            summary.success += 1;
          } catch (error) {
            summary.errors += 1;
            if (isBotBlockedError(error)) {
              summary.blocked += 1;
              await repository.markUserBotBlocked(user.id);
            }
          }
        }
      }

      if (summary.errors === 0) {
        for (const note of releaseNotes) {
          await repository.markReleaseNoteSent(note.id);
        }
      }
      return summary;
    }
  };
}

export function isBotBlockedError(error) {
  const text = `${error?.message ?? ""} ${error?.body ?? ""}`.toLowerCase();
  return error?.status === 403 && (text.includes("blocked") || text.includes("forbidden"));
}

function normalizeAudience(value) {
  return [USER_AUDIENCE, ADMIN_AUDIENCE, INTERNAL_AUDIENCE].includes(value) ? value : USER_AUDIENCE;
}

function defaultAudienceForCategory(category) {
  if (category === ADMIN_AUDIENCE) return ADMIN_AUDIENCE;
  if (INTERNAL_DEFAULT_CATEGORIES.has(category)) return INTERNAL_AUDIENCE;
  return USER_AUDIENCE;
}

function bodyLinesForLanguage(note, language) {
  const englishLines = bodyLines(note.body_en);
  const body = language === "en" && englishLines.length > 0 ? note.body_en : note.body_ru;
  return bodyLines(body);
}

function graphemeLength(value) {
  const text = String(value ?? "");
  if (typeof Intl?.Segmenter === "function") {
    return Array.from(new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(text)).length;
  }
  return Array.from(text).length;
}

function bodyLines(body) {
  return String(body ?? "")
    .split(/\r?\n/)
    .map((line) => line.trim().replace(/^•\s*/, ""))
    .filter(Boolean);
}

function hiddenNotesBlock(hiddenNotes) {
  if (!hiddenNotes?.length) return "";
  return [
    "Скрыто из пользовательского пуша:",
    ...hiddenNotes.map((note) => `• ${hiddenReleaseNoteLabel(note)}`)
  ].join("\n");
}
