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
  let digestSendInProgress = false;

  return {
    async createReleaseNote(input) {
      const normalized = normalizeReleaseNoteInput(input);
      validateReleaseNoteInput(normalized);
      return repository.createReleaseNote(normalized);
    },
    async previewReleaseDigestSinceLastRun(now = new Date()) {
      const context = await getPendingReleaseContext(repository, now);
      const missingEnglish = context.selectedNotes.some(
        (note) => bodyLines(note.body_en).length === 0
      );
      const period = `${formatIsoMinute(context.sentFrom)} -> ${formatIsoMinute(context.sentTo)}`;
      if (context.selectedNotes.length === 0) {
        return {
          hasPublicNotes: false,
          ...context,
          text: [
            "Нет новых публичных изменений для пользователей с прошлого дайджеста — отправлять нечего.",
            `Период: ${period}`,
            hiddenNotesBlock(context.hiddenNotes)
          ].filter(Boolean).join("\n\n")
        };
      }

      return {
        hasPublicNotes: true,
        ...context,
        text: [
          "Пользователям будет отправлено в следующий digest:",
          "",
          "RU preview:",
          formatReleaseDigest(context.selectedNotes, "ru"),
          "",
          "EN preview:",
          formatReleaseDigest(context.selectedNotes, "en"),
          "",
          `Период: ${period}`,
          hiddenNotesBlock(context.hiddenNotes),
          missingEnglish
            ? "Предупреждение: у некоторых release notes нет EN-текста. Английские пользователи получат русский fallback."
            : ""
        ].filter(Boolean).join("\n")
      };
    },
    async sendReleaseDigestSinceLastRun(now = new Date(), options = {}) {
      if (digestSendInProgress) {
        return { ...emptyReleaseSummary(), reason: "digest_already_running" };
      }
      digestSendInProgress = true;

      try {
        const trigger = options.trigger ?? "manual";
        const timezone = options.timezone ?? "Asia/Bangkok";
        const localDate = options.localDate ?? formatLocalDate(now, timezone);
        const context = await getPendingReleaseContext(repository, now);
        const run = await repository.createReleaseDigestRun({
          trigger,
          sentFrom: context.sentFrom,
          sentTo: context.sentTo,
          digestLocalDate: localDate,
          timezone
        });

        if (!run) {
          return { ...emptyReleaseSummary(), reason: "digest_already_running" };
        }
        if (context.selectedNotes.length === 0) {
          await repository.markReleaseDigestRunSkipped(run.id, "no_public_release_notes");
          return emptyReleaseSummary();
        }

        const summary = {
          sent: true,
          version: context.selectedNotes.at(-1)?.version ?? null,
          versionFrom: context.selectedNotes[0]?.version ?? null,
          versionTo: context.selectedNotes.at(-1)?.version ?? null,
          notes: context.selectedNotes.length,
          users: 0,
          success: 0,
          errors: 0,
          skipped: 0,
          blocked: 0
        };

        try {
          if (!sendMessage) throw new Error("sendMessage is required");
          const users = await repository.getActiveUsersForReleasePush();
          summary.users = users.length;

          for (const user of users) {
            try {
              const missingNotes = [];
              for (const note of context.selectedNotes) {
                if (!await repository.hasReleaseNoteDelivery(note.id, user.id)) {
                  missingNotes.push(note);
                }
              }
              if (missingNotes.length === 0) {
                summary.skipped += 1;
                continue;
              }

              try {
                await sendMessage({
                  chatId: Number(user.telegram_user_id),
                  text: formatReleaseDigest(missingNotes, user.interface_language),
                  user,
                  releaseNotes: missingNotes
                });
              } catch (error) {
                summary.errors += 1;
                if (isBotBlockedError(error)) {
                  summary.blocked += 1;
                  try {
                    await repository.markUserBotBlocked(user.id);
                  } catch {
                    // The Telegram error is already counted; keep processing users.
                  }
                }
                continue;
              }

              try {
                // Bot API has no idempotency key; retry only persistence to minimize post-send ambiguity.
                await retryReleaseDeliveryWrite(() => (
                  repository.markReleaseNotesDelivered(
                    missingNotes.map((note) => note.id),
                    user.id
                  )
                ));
                summary.success += 1;
              } catch {
                summary.errors += 1;
              }
            } catch {
              summary.errors += 1;
            }
          }

          for (const note of context.selectedNotes) {
            if (await repository.countMissingReleaseNoteDeliveries(note.id) === 0) {
              await repository.markReleaseNoteSent(note.id);
            }
          }

          if (summary.errors > summary.blocked) {
            await repository.markReleaseDigestRunFailed(
              run.id,
              new Error("release_digest_partial_failure"),
              summary
            );
          } else {
            await repository.markReleaseDigestRunSuccess(run.id, summary);
          }
          return summary;
        } catch (error) {
          await repository.markReleaseDigestRunFailed(run.id, error, summary);
          throw error;
        }
      } finally {
        digestSendInProgress = false;
      }
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
        try {
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
        } catch (error) {
          summary.errors += 1;
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

async function getPendingReleaseContext(repository, now) {
  const lastRun = await repository.getLastSuccessfulReleaseDigestRun();
  const sentFrom = lastRun?.sent_to ?? null;
  const releaseNotes = await repository.getUnsentPublicReleaseNotesSince(sentFrom, now);
  const hiddenNotes = await repository.getHiddenReleaseNotesSince(sentFrom, now);
  return {
    sentFrom,
    sentTo: now,
    releaseNotes,
    selectedNotes: selectDigestReleaseNotes(releaseNotes),
    hiddenNotes
  };
}

function emptyReleaseSummary() {
  return {
    sent: false,
    reason: "no_public_release_notes",
    version: null,
    versionFrom: null,
    versionTo: null,
    notes: 0,
    users: 0,
    success: 0,
    errors: 0,
    skipped: 0,
    blocked: 0
  };
}

async function retryReleaseDeliveryWrite(write) {
  let lastError;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      await write();
      return;
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError;
}

function formatIsoMinute(value) {
  return value
    ? new Date(value).toISOString().slice(0, 16).replace("T", " ")
    : "первый digest";
}

function formatLocalDate(now, timezone) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).formatToParts(now);
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}`;
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
