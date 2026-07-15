import test from "node:test";
import assert from "node:assert/strict";

import {
  DEFAULT_TIMEZONE,
  localDateTimeToUtc,
  localDateKey,
  localDateRangeBounds,
  localHour,
  localMonthKey,
  localPeriodBounds,
  normalizeTimeZone,
  resolveUserTimeZone,
  timeZoneDayBounds,
  timeZoneDayKey,
  timeZoneMonthBounds,
  timeZoneMonthKey,
  timeZoneMonthState,
  toZonedIso
} from "../src/time.js";

test("converts validated local date-time components to UTC", () => {
  assert.equal(
    localDateTimeToUtc({ year: 2026, month: 7, day: 15, hour: 19, minute: 30 }, "Asia/Bangkok").toISOString(),
    "2026-07-15T12:30:00.000Z"
  );
  assert.equal(
    localDateTimeToUtc({ year: 2026, month: 3, day: 8, hour: 1, minute: 30 }, "America/New_York").toISOString(),
    "2026-03-08T06:30:00.000Z"
  );
});

test("rejects invalid local calendar and DST-gap times", () => {
  assert.throws(
    () => localDateTimeToUtc({ year: 2026, month: 2, day: 29, hour: 10, minute: 0 }, "Asia/Bangkok"),
    { message: "invalid_local_date_time" }
  );
  assert.throws(
    () => localDateTimeToUtc({ year: 2026, month: 3, day: 8, hour: 2, minute: 30 }, "America/New_York"),
    { message: "invalid_local_date_time" }
  );
});

test("returns current week bounds from Monday in local timezone", () => {
  const bounds = localPeriodBounds(new Date("2026-06-07T10:00:00+07:00"), "week");

  assert.equal(bounds.start.toISOString(), "2026-05-31T17:00:00.000Z");
  assert.equal(bounds.end.toISOString(), "2026-06-07T17:00:00.000Z");
});

test("today gives bounds of a single local day", () => {
  const bounds = localPeriodBounds(new Date("2026-06-16T15:00:00+07:00"), "today");

  assert.equal(bounds.start.toISOString(), "2026-06-15T17:00:00.000Z");
  assert.equal(bounds.end.toISOString(), "2026-06-16T17:00:00.000Z");
});

test("yesterday gives the previous local day bounds", () => {
  const bounds = localPeriodBounds(new Date("2026-06-16T15:00:00+07:00"), "yesterday");

  assert.equal(bounds.start.toISOString(), "2026-06-14T17:00:00.000Z");
  assert.equal(bounds.end.toISOString(), "2026-06-15T17:00:00.000Z");
});

test("last7 includes today and 6 previous days", () => {
  const bounds = localPeriodBounds(new Date("2026-06-16T15:00:00+07:00"), "last7");

  assert.equal(bounds.start.toISOString(), "2026-06-09T17:00:00.000Z");
  assert.equal(bounds.end.toISOString(), "2026-06-16T17:00:00.000Z");
  assert.equal((bounds.end - bounds.start) / (24 * 60 * 60_000), 7);
});

test("month starts on the 1st", () => {
  const bounds = localPeriodBounds(new Date("2026-06-16T15:00:00+07:00"), "month");

  assert.equal(bounds.start.toISOString(), "2026-05-31T17:00:00.000Z");
  assert.equal(bounds.end.toISOString(), "2026-06-30T17:00:00.000Z");
});

test("previous_month gives the full previous calendar month", () => {
  const bounds = localPeriodBounds(new Date("2026-06-16T15:00:00+07:00"), "previous_month");

  assert.equal(bounds.start.toISOString(), "2026-04-30T17:00:00.000Z");
  assert.equal(bounds.end.toISOString(), "2026-05-31T17:00:00.000Z");
});

test("localDateRangeBounds returns end at the start of the day after toDate", () => {
  const bounds = localDateRangeBounds("2026-06-01", "2026-06-15");

  assert.ok(bounds);
  assert.equal(bounds.start.toISOString(), "2026-05-31T17:00:00.000Z");
  assert.equal(bounds.end.toISOString(), "2026-06-15T17:00:00.000Z");
});

test("localDateRangeBounds returns null for invalid or reversed ranges", () => {
  assert.equal(localDateRangeBounds("not-a-date", "2026-06-15"), null);
  assert.equal(localDateRangeBounds("2026-06-15", "2026-06-01"), null);
});

test("normalizes valid IANA timezones and falls back for missing or invalid values", () => {
  assert.deepEqual(normalizeTimeZone("America/New_York"), {
    timeZone: "America/New_York",
    fallback: false,
    reason: null
  });
  assert.deepEqual(normalizeTimeZone(""), {
    timeZone: DEFAULT_TIMEZONE,
    fallback: true,
    reason: "timezone_missing"
  });
  assert.deepEqual(normalizeTimeZone("Mars/Olympus"), {
    timeZone: DEFAULT_TIMEZONE,
    fallback: true,
    reason: "timezone_invalid"
  });
});

test("resolves user timezone with Asia/Bangkok fallback", () => {
  assert.equal(resolveUserTimeZone({ timezone: "Europe/Moscow" }), "Europe/Moscow");
  assert.equal(resolveUserTimeZone({ timezone: "Asia/Bangkok" }), "Asia/Bangkok");
  assert.equal(resolveUserTimeZone({ timezone: null }), "Asia/Bangkok");
  assert.equal(resolveUserTimeZone({ timezone: "" }), "Asia/Bangkok");
  assert.equal(resolveUserTimeZone({}), "Asia/Bangkok");
  assert.equal(resolveUserTimeZone({ timezone: "Not/A_Timezone" }), "Asia/Bangkok");
});

test("derives month key and day state from an IANA timezone", () => {
  const now = new Date("2026-06-30T18:30:00.000Z");

  assert.equal(timeZoneMonthKey(now, "UTC"), "2026-06");
  assert.equal(timeZoneMonthKey(now, "Asia/Bangkok"), "2026-07");
  assert.deepEqual(timeZoneMonthState(now, "Asia/Bangkok"), {
    period: "2026-07",
    dayOfMonth: 1,
    daysInMonth: 31,
    remainingDays: 31
  });
});

test("returns DST-aware month bounds for an IANA timezone", () => {
  const bounds = timeZoneMonthBounds("2026-03", "America/New_York");

  assert.equal(bounds.start.toISOString(), "2026-03-01T05:00:00.000Z");
  assert.equal(bounds.end.toISOString(), "2026-04-01T04:00:00.000Z");
});

test("derives the local day key from an IANA timezone", () => {
  const now = new Date("2026-06-23T17:00:00.000Z");

  assert.equal(timeZoneDayKey(now, "Asia/Bangkok"), "2026-06-24");
  assert.equal(timeZoneDayKey(now, "Europe/Moscow"), "2026-06-23");
  assert.equal(timeZoneDayKey(now, "UTC"), "2026-06-23");
});

test("daily snapshot day key changes at the user's local midnight", () => {
  assert.equal(timeZoneDayKey(new Date("2026-06-23T16:59:00.000Z"), "Asia/Bangkok"), "2026-06-23");
  assert.equal(timeZoneDayKey(new Date("2026-06-23T17:00:00.000Z"), "Asia/Bangkok"), "2026-06-24");
  assert.equal(timeZoneDayKey(new Date("2026-06-23T20:59:00.000Z"), "Europe/Moscow"), "2026-06-23");
  assert.equal(timeZoneDayKey(new Date("2026-06-23T21:00:00.000Z"), "Europe/Moscow"), "2026-06-24");
});

test("timeZoneDayBounds spans a single local day in the given timezone", () => {
  const bangkok = timeZoneDayBounds(new Date("2026-06-24T03:00:00.000Z"), "Asia/Bangkok");
  assert.equal(bangkok.start.toISOString(), "2026-06-23T17:00:00.000Z");
  assert.equal(bangkok.end.toISOString(), "2026-06-24T17:00:00.000Z");

  const moscow = timeZoneDayBounds(new Date("2026-06-23T22:00:00.000Z"), "Europe/Moscow");
  assert.equal(moscow.start.toISOString(), "2026-06-23T21:00:00.000Z");
  assert.equal(moscow.end.toISOString(), "2026-06-24T21:00:00.000Z");
});

test("formats instants as ISO strings in the supplied timezone", () => {
  assert.equal(toZonedIso(new Date("2026-06-01T03:30:00.000Z"), "America/New_York"), "2026-05-31T23:30:00.000-04:00");
  assert.equal(toZonedIso(new Date("2026-05-31T17:00:00.000Z"), "Asia/Bangkok"), "2026-06-01T00:00:00.000+07:00");
});

test("localDateKey uses the supplied timezone", () => {
  const instant = new Date("2026-06-01T03:30:00Z");
  assert.equal(localDateKey(instant, "Asia/Bangkok"), "2026-06-01");
  assert.equal(localDateKey(instant, "America/New_York"), "2026-05-31");
});

test("localMonthKey and localHour use the supplied timezone", () => {
  const instant = new Date("2026-06-30T17:30:00Z");
  assert.equal(localMonthKey(instant, "Asia/Bangkok"), "2026-07");
  assert.equal(localMonthKey(instant, "America/New_York"), "2026-06");
  assert.equal(localHour(new Date("2026-06-01T15:30:00Z"), "Asia/Bangkok"), 22);
  assert.equal(localHour(new Date("2026-06-01T15:30:00Z"), "America/New_York"), 11);
});

test("localPeriodBounds uses timezone-specific day boundaries", () => {
  const bounds = localPeriodBounds(new Date("2026-06-01T03:30:00Z"), "today", "America/New_York");
  assert.equal(bounds.start.toISOString(), "2026-05-31T04:00:00.000Z");
  assert.equal(bounds.end.toISOString(), "2026-06-01T04:00:00.000Z");
});
