export function shouldShowCurrentMonthBudgetOverride(currentMonthBudget, now = new Date(), timeZone = "Asia/Bangkok") {
  return Boolean(
    currentMonthBudget?.hasOverride
    && currentMonthBudget?.isPartialMonth
    && currentMonthBudget?.monthKey === localMonthKey(now, timeZone)
  );
}

export const COMMON_TIMEZONES = [
  "Asia/Bangkok",
  "Europe/Moscow",
  "Asia/Tbilisi",
  "Asia/Yerevan",
  "Asia/Dubai",
  "Asia/Makassar",
  "Europe/Warsaw",
  "Europe/Berlin",
  "America/New_York",
  "America/Los_Angeles"
];

export function normalizeSettingsTimeZone(value) {
  return isValidTimeZone(value) ? value : "Asia/Bangkok";
}

export function isValidTimeZone(value, intl = Intl) {
  if (typeof value !== "string" || !value.trim()) return false;
  try {
    new intl.DateTimeFormat("en-US", { timeZone: value });
    return true;
  } catch {
    return false;
  }
}

export function allTimeZones(intl = Intl) {
  return IANA_TIME_ZONES.filter((timeZone) => isValidTimeZone(timeZone, intl));
}

export function timeZoneOffsetLabel(timeZone, instant = new Date(), intl = Intl) {
  const parts = new intl.DateTimeFormat("en-US", {
    timeZone,
    timeZoneName: "longOffset"
  }).formatToParts(instant);
  const raw = parts.find((part) => part.type === "timeZoneName")?.value ?? "GMT+00:00";
  const offset = raw.replace(/^GMT/, "UTC").replace("-", "−");
  return offset === "UTC" ? "UTC+00:00" : offset;
}

export function filterTimeZones(query = "", instant = new Date(), intl = Intl) {
  const normalizedQuery = normalizeTimeZoneSearch(query);
  return allTimeZones(intl)
    .filter((timeZone) => {
      const label = timeZoneCityLabel(timeZone);
      const offset = timeZoneOffsetLabel(timeZone, instant, intl);
      return !normalizedQuery || [timeZone, label, offset].some((value) => normalizeTimeZoneSearch(value).includes(normalizedQuery));
    })
    .sort((left, right) => {
      const offsetDifference = offsetMinutes(left, instant, intl) - offsetMinutes(right, instant, intl);
      return offsetDifference || timeZoneCityLabel(left).localeCompare(timeZoneCityLabel(right));
    });
}

function normalizeTimeZoneSearch(value) {
  return String(value).toLocaleLowerCase().replaceAll("_", " ").replaceAll("−", "-").replace(/\s+/g, " ").trim();
}

function offsetMinutes(timeZone, instant, intl) {
  const match = timeZoneOffsetLabel(timeZone, instant, intl).match(/^UTC([+−])(\d{2}):(\d{2})$/);
  if (!match) return 0;
  const minutes = Number(match[2]) * 60 + Number(match[3]);
  return match[1] === "−" ? -minutes : minutes;
}

export function detectBrowserTimeZone(intl = Intl) {
  try {
    return normalizeSettingsTimeZone(intl.DateTimeFormat().resolvedOptions().timeZone);
  } catch {
    return "Asia/Bangkok";
  }
}

export function createSettingsSaveQueue({ save, onSaved = () => {}, onError = () => {}, onIdle = () => {} }) {
  let confirmedState = null;
  let desiredState = null;
  let running = null;

  function reset(settings) {
    confirmedState = copySettings(settings);
    desiredState = copySettings(settings);
  }

  function confirmed() {
    return copySettings(confirmedState);
  }

  function enqueue(settings) {
    const nextState = copySettings(settings);
    if (sameSettings(nextState, desiredState)) return running ?? Promise.resolve({ status: "unchanged" });
    desiredState = nextState;
    if (!running) {
      running = drain().finally(() => {
        running = null;
      });
    }
    return running;
  }

  async function drain() {
    let savedSinceIdle = false;
    while (true) {
      while (!sameSettings(desiredState, confirmedState)) {
        const attemptedState = copySettings(desiredState);
        try {
          const serverState = await save(copySettings(attemptedState));
          confirmedState = copySettings(serverState ?? attemptedState);
          if (sameSettings(desiredState, attemptedState)) desiredState = copySettings(confirmedState);
          savedSinceIdle = true;
          onSaved(copySettings(confirmedState), copySettings(attemptedState));
        } catch (error) {
          desiredState = copySettings(confirmedState);
          onError(error, copySettings(confirmedState), attemptedState);
          return { status: "failed", error };
        }
      }
      if (!savedSinceIdle) return { status: "unchanged" };
      savedSinceIdle = false;
      await onIdle(copySettings(confirmedState));
      if (sameSettings(desiredState, confirmedState)) return { status: "saved" };
    }
  }

  return { confirmed, enqueue, reset };
}

export async function commitMonthlyBudgetChange({ currentValue, rawValue, confirm, save }) {
  const text = String(rawValue ?? "").trim();
  const nextValue = Number(text);
  const savedValue = Number(currentValue);
  if (!text || !Number.isFinite(nextValue) || nextValue <= 0) return { status: "invalid", currentValue: savedValue };
  if (nextValue === savedValue) return { status: "unchanged", currentValue: savedValue };
  if (!await confirm({ currentValue: savedValue, nextValue })) return { status: "cancelled", currentValue: savedValue };
  try {
    await save(nextValue);
    return { status: "saved", currentValue: nextValue };
  } catch (error) {
    return { status: "failed", currentValue: savedValue, error };
  }
}

function copySettings(settings) {
  return settings == null ? null : { ...settings };
}

function sameSettings(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function localMonthKey(now, timeZone = "Asia/Bangkok") {
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit"
  }).formatToParts(now).filter((part) => part.type !== "literal").map((part) => [part.type, part.value]));
  return `${parts.year}-${parts.month}`;
}
import { IANA_TIME_ZONES, timeZoneCityLabel } from "./timezones.js";
