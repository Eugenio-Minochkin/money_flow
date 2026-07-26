import test from "node:test";
import assert from "node:assert/strict";

import {
  monthlyPeriodForSend,
  priorMonthlyBounds,
  priorWeeklyBounds,
  shouldSendMonthlyReportForUser,
  shouldSendWeeklyReportForUser,
  weeklyPeriodForSend
} from "../src/reportPeriods.js";

test("weekly gate is Monday 09:00 through before 14:00 in user timezone", () => {
  assert.equal(shouldSendWeeklyReportForUser(new Date("2026-06-22T02:00:00Z"), "Asia/Bangkok"), true);
  assert.equal(shouldSendWeeklyReportForUser(new Date("2026-06-22T06:59:59Z"), "Asia/Bangkok"), true);
  assert.equal(shouldSendWeeklyReportForUser(new Date("2026-06-22T07:00:00Z"), "Asia/Bangkok"), false);
  assert.equal(shouldSendWeeklyReportForUser(new Date("2026-06-21T14:00:00Z"), "Asia/Bangkok"), false);
});

test("monthly gate is first day 09:00 through before 14:00 in user timezone", () => {
  assert.equal(shouldSendMonthlyReportForUser(new Date("2026-07-01T02:00:00Z"), "Asia/Bangkok"), true);
  assert.equal(shouldSendMonthlyReportForUser(new Date("2026-07-01T06:59:59Z"), "Asia/Bangkok"), true);
  assert.equal(shouldSendMonthlyReportForUser(new Date("2026-07-01T07:00:00Z"), "Asia/Bangkok"), false);
  assert.equal(shouldSendMonthlyReportForUser(new Date("2026-07-02T02:00:00Z"), "Asia/Bangkok"), false);
});

test("weekly period uses previous completed local ISO week and UTC boundaries", () => {
  const period = weeklyPeriodForSend(new Date("2026-06-22T03:00:00Z"), "Asia/Bangkok");

  assert.equal(period.reportType, "weekly");
  assert.equal(period.periodKey, "2026-W25");
  assert.equal(period.localStartDate, "2026-06-15");
  assert.equal(period.localEndDate, "2026-06-21");
  assert.equal(period.periodStartUtc.toISOString(), "2026-06-14T17:00:00.000Z");
  assert.equal(period.periodEndUtc.toISOString(), "2026-06-21T17:00:00.000Z");
});

test("weekly period key uses ISO week-year across New Year", () => {
  const period = weeklyPeriodForSend(new Date("2021-01-04T03:00:00Z"), "Asia/Bangkok");

  assert.equal(period.periodKey, "2020-W53");
  assert.equal(period.localStartDate, "2020-12-28");
  assert.equal(period.localEndDate, "2021-01-03");
});

test("monthly period uses previous completed local month and UTC boundaries", () => {
  const period = monthlyPeriodForSend(new Date("2026-07-01T03:00:00Z"), "Asia/Bangkok");

  assert.equal(period.reportType, "monthly");
  assert.equal(period.periodKey, "2026-06");
  assert.equal(period.localStartDate, "2026-06-01");
  assert.equal(period.localEndDate, "2026-06-30");
  assert.equal(period.periodStartUtc.toISOString(), "2026-05-31T17:00:00.000Z");
  assert.equal(period.periodEndUtc.toISOString(), "2026-06-30T17:00:00.000Z");
});

test("period helpers fall back to project timezone for invalid user timezone", () => {
  const weekly = weeklyPeriodForSend(new Date("2026-06-22T03:00:00Z"), "No/Such_Zone");
  const monthly = monthlyPeriodForSend(new Date("2026-07-01T03:00:00Z"), "");

  assert.equal(weekly.timezoneUsed, "Asia/Bangkok");
  assert.equal(monthly.timezoneUsed, "Asia/Bangkok");
});

function berlinWeekdayHour(date) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "Europe/Berlin", weekday: "short", hour: "2-digit", minute: "2-digit", hourCycle: "h23"
  }).formatToParts(date);
  const values = {};
  for (const part of parts) if (part.type !== "literal") values[part.type] = part.value;
  return { weekday: values.weekday, hour: Number(values.hour) };
}

test("priorWeeklyBounds spans a normal summer week as two local Mondays at 00:00", () => {
  const report = weeklyPeriodForSend(new Date("2026-07-20T08:00:00Z"), "Europe/Berlin");
  const prior = priorWeeklyBounds(report, "Europe/Berlin");

  assert.equal(prior.localStartDate, "2026-07-06");
  assert.equal(prior.localEndDate, "2026-07-12");
  assert.equal(prior.start.toISOString(), "2026-07-05T22:00:00.000Z");
  assert.equal(prior.end.toISOString(), "2026-07-12T22:00:00.000Z");
  assert.equal((prior.end - prior.start) / 3_600_000, 168);
  assert.deepEqual(berlinWeekdayHour(prior.start), { weekday: "Mon", hour: 0 });
  assert.deepEqual(berlinWeekdayHour(prior.end), { weekday: "Mon", hour: 0 });
});

test("priorWeeklyBounds is 167 hours across the Berlin spring DST transition", () => {
  const report = weeklyPeriodForSend(new Date("2026-04-06T08:00:00Z"), "Europe/Berlin");
  const prior = priorWeeklyBounds(report, "Europe/Berlin");

  assert.equal(report.localStartDate, "2026-03-30");
  assert.equal(prior.localStartDate, "2026-03-23");
  assert.equal(prior.start.toISOString(), "2026-03-22T23:00:00.000Z");
  assert.equal(prior.end.toISOString(), "2026-03-29T22:00:00.000Z");
  assert.equal((prior.end - prior.start) / 3_600_000, 167);
  assert.deepEqual(berlinWeekdayHour(prior.start), { weekday: "Mon", hour: 0 });
  assert.deepEqual(berlinWeekdayHour(prior.end), { weekday: "Mon", hour: 0 });
});

test("priorWeeklyBounds is 169 hours across the Berlin autumn DST transition", () => {
  const report = weeklyPeriodForSend(new Date("2026-11-02T08:00:00Z"), "Europe/Berlin");
  const prior = priorWeeklyBounds(report, "Europe/Berlin");

  assert.equal(report.localStartDate, "2026-10-26");
  assert.equal(prior.localStartDate, "2026-10-19");
  assert.equal(prior.start.toISOString(), "2026-10-18T22:00:00.000Z");
  assert.equal(prior.end.toISOString(), "2026-10-25T23:00:00.000Z");
  assert.equal((prior.end - prior.start) / 3_600_000, 169);
  assert.deepEqual(berlinWeekdayHour(prior.start), { weekday: "Mon", hour: 0 });
  assert.deepEqual(berlinWeekdayHour(prior.end), { weekday: "Mon", hour: 0 });
});

test("priorMonthlyBounds spans the previous local calendar month with timezone-aware UTC edges", () => {
  const report = monthlyPeriodForSend(new Date("2026-07-01T03:00:00Z"), "Asia/Bangkok");
  assert.equal(report.periodKey, "2026-06");
  const prior = priorMonthlyBounds(report, "Asia/Bangkok");

  assert.equal(prior.periodKey, "2026-05");
  assert.equal(prior.localStartDate, "2026-05-01");
  assert.equal(prior.localEndDate, "2026-05-31");
  assert.equal(prior.start.toISOString(), "2026-04-30T17:00:00.000Z");
  assert.equal(prior.end.toISOString(), "2026-05-31T17:00:00.000Z");
  assert.equal((prior.end - prior.start) / 3_600_000, 744);
});

test("priorMonthlyBounds rolls back across the year boundary", () => {
  const prior = priorMonthlyBounds({ periodKey: "2026-01" }, "Asia/Bangkok");
  assert.equal(prior.periodKey, "2025-12");
  assert.equal(prior.localStartDate, "2025-12-01");
  assert.equal(prior.localEndDate, "2025-12-31");
});

test("priorMonthlyBounds spans the DST transition month in Europe/Berlin as 743 hours", () => {
  // Reporting April 2026 -> prior month March 2026 contains the CET->CEST spring transition.
  const prior = priorMonthlyBounds({ periodKey: "2026-04" }, "Europe/Berlin");

  assert.equal(prior.periodKey, "2026-03");
  assert.equal(prior.localStartDate, "2026-03-01");
  assert.equal(prior.localEndDate, "2026-03-31");
  assert.equal(prior.start.toISOString(), "2026-02-28T23:00:00.000Z");
  assert.equal(prior.end.toISOString(), "2026-03-31T22:00:00.000Z");
  assert.equal((prior.end - prior.start) / 3_600_000, 743);
});
