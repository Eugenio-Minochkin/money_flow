import test from "node:test";
import assert from "node:assert/strict";

import {
  monthlyPeriodForSend,
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
