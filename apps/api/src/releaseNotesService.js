const USER_AUDIENCE = "user";
const ADMIN_AUDIENCE = "admin";
const INTERNAL_AUDIENCE = "internal";
const INTERNAL_DEFAULT_CATEGORIES = new Set(["internal", "infra", "analytics"]);

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

export function parseAdminTelegramIds(value) {
  return new Set(String(value ?? "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean));
}

export function isAdminTelegramId(telegramUserId, adminTelegramIds) {
  return adminTelegramIds instanceof Set && (
    adminTelegramIds.has(Number(telegramUserId)) ||
    adminTelegramIds.has(String(telegramUserId))
  );
}

export function formatReleaseDigest(releaseNotes, language = "ru") {
  const notes = Array.isArray(releaseNotes) ? releaseNotes : [];
  const lang = language === "en" ? "en" : "ru";
  const version = notes[0]?.version ?? "";
  const heading = lang === "en" ? "Today's updates:" : "Что изменилось сегодня:";
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

export function hiddenReleaseNoteLabel(note) {
  return `${note.audience}: ${note.title_ru}`;
}

export function createReleaseNotesService({ repository, sendMessage } = {}) {
  return {
    async createReleaseNote(input) {
      return repository.createReleaseNote(normalizeReleaseNoteInput(input));
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
  const body = language === "en" ? (note.body_en || note.body_ru) : note.body_ru;
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
