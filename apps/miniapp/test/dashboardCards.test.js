import test from "node:test";
import assert from "node:assert/strict";
import { buildDashboardCards, buildHeroMetric, renderDashboardCards } from "../src/dashboardCards.js";

const helpers = {
  t: (key) => ({
    "dashboard.today": "Сегодня",
    "dashboard.week": "Неделя",
    "dashboard.remaining": "Осталось",
    "dashboard.month": "Месяц",
    "dashboard.remainingPrefix": "осталось",
    "dashboard.limitPrefix": "лимит",
    "dashboard.budget": "бюджет",
    "dashboard.dayBudget": "бюджет дня",
    "dashboard.ofDayBudget": "из бюджета дня",
    "dashboard.canStillSpendToday": "Можно ещё сегодня",
    "dashboard.todayOverrun": "Перерасход сегодня",
    "dashboard.overrun": "перерасход",
    "dashboard.safeToSpendPerDay": "Можно в день до конца месяца",
    "dashboard.afterExpensesAndPlanned": "после расходов и плановых оплат"
  })[key] ?? key,
  moneyBase: (value) => `${value} THB`,
  moneyDisplay: (value) => `~$${value}`,
  percent: (value) => `${value}%`
};

test("builds dashboard cards with MVP priority before secondary weekly analytics", () => {
  const cards = buildDashboardCards({
    today: 100,
    week: 700,
    month: 3000,
    dayRemaining: 650,
    dayPlanLimit: 750,
    safeToSpendPerDay: 650,
    weekRemaining: 1200,
    weekPlanLimit: 1900,
    freeRemaining: 16000,
    monthRemaining: 34000,
    monthlyBudget: 42000,
    dayProgressPercent: 10,
    weekProgressPercent: 80.61,
    budgetProgressPercent: 18.81,
    progress: {
      day: { percent: 10, state: "good" },
      week: { percent: 80.61, state: "warn" },
      month: { percent: 18.81, state: "good" }
    },
    display: { currency: "USD", freeRemaining: 519.2 }
  }, helpers);

  assert.equal(cards.length, 4);
  assert.deepEqual(cards.map((card) => card.title), ["Сегодня", "Осталось", "Месяц", "Неделя"]);
  assert.deepEqual(cards[0].lines.map((line) => line.label), ["осталось", "бюджет дня"]);
  assert.deepEqual(cards[0].lines.map((line) => line.amount), ["650 THB", "750 THB"]);
  assert.deepEqual(cards[2].lines.map((line) => line.label), ["осталось", "бюджет"]);
  assert.deepEqual(cards[3].lines.map((line) => line.label), ["осталось", "лимит"]);
});

test("builds today's card as overrun when regular spend exceeds today's budget", () => {
  const cards = buildDashboardCards({
    today: 802,
    dayRemaining: 0,
    dayOverrun: 187,
    dayPlanLimit: 615,
    safeToSpendPerDay: 428,
    dayProgressPercent: 130.41
  }, helpers);

  assert.deepEqual(cards[0].lines.map((line) => line.label), ["перерасход", "бюджет дня"]);
  assert.deepEqual(cards[0].lines.map((line) => line.amount), ["187 THB", "615 THB"]);
});

test("today card shows the fixed daily budget and remaining, not the live pace", () => {
  const cards = buildDashboardCards({
    today: 10,
    dayPlanLimit: 427,
    dayRemaining: 417,
    dayOverrun: 0,
    safeToSpendPerDay: 428,
    dayProgressPercent: 2.34,
    progress: {
      day: { percent: 2.34, state: "good" }
    }
  }, helpers);

  assert.equal(cards[0].amount, "10 THB");
  assert.deepEqual(cards[0].lines.map((line) => line.label), ["осталось", "бюджет дня"]);
  assert.deepEqual(cards[0].lines.map((line) => line.amount), ["417 THB", "427 THB"]);
  assert.ok(!cards[0].lines.some((line) => line.amount === "428 THB"));
  assert.equal(cards[0].percent, "2.34%");
  assert.deepEqual(cards[0].progress, { percent: 2.34, state: "good" });
});

test("today card restores percent and visible progress from daily budget fields", () => {
  const cards = buildDashboardCards({
    today: 120,
    dayPlanLimit: 214,
    dayRemaining: 94,
    dayOverrun: 0,
    safeToSpendPerDay: 180,
    dayProgressPercent: 56.07,
    progress: {
      day: { percent: 56.07, state: "good" }
    }
  }, helpers);
  const container = { innerHTML: "" };

  renderDashboardCards(container, [cards[0]]);

  assert.equal(cards[0].amount, "120 THB");
  assert.equal(cards[0].percent, "56.07%");
  assert.equal(cards[0].state, "good");
  assert.deepEqual(cards[0].lines.map((line) => `${line.label} ${line.amount}`), [
    "осталось 94 THB",
    "бюджет дня 214 THB"
  ]);
  assert.deepEqual(cards[0].progress, { percent: 56.07, state: "good" });
  assert.doesNotMatch(container.innerHTML, /dashboard-card__progress--hidden/);
  assert.match(container.innerHTML, /style="width: 56\.07%"/);
});

test("today card shows overrun percent while capping red progress width", () => {
  const cards = buildDashboardCards({
    today: 235,
    dayPlanLimit: 214,
    dayRemaining: 0,
    dayOverrun: 21,
    safeToSpendPerDay: 180,
    dayProgressPercent: 109.92,
    progress: {
      day: { percent: 109.92, state: "bad" }
    }
  }, helpers);
  const container = { innerHTML: "" };

  renderDashboardCards(container, [cards[0]]);

  assert.equal(cards[0].amount, "235 THB");
  assert.equal(cards[0].percent, "109.92%");
  assert.equal(cards[0].state, "bad");
  assert.deepEqual(cards[0].lines.map((line) => `${line.label} ${line.amount}`), [
    "перерасход 21 THB",
    "бюджет дня 214 THB"
  ]);
  assert.deepEqual(cards[0].progress, { percent: 109.92, state: "bad" });
  assert.doesNotMatch(container.innerHTML, /dashboard-card__progress--hidden/);
  assert.match(container.innerHTML, /data-state="bad" style="width: 100%"/);
  assert.match(container.innerHTML, />109\.92%<\/b>/);
});

test("builds hero metric from day remaining instead of safe-to-spend pace", () => {
  const hero = buildHeroMetric({
    dayRemaining: 94,
    dayPlanLimit: 214,
    dayOverrun: 0,
    safeToSpendPerDay: 180,
    display: {
      currency: "USD",
      dayRemaining: 2.88,
      safeToSpendPerDay: 5.51
    }
  }, helpers);

  assert.deepEqual(hero, {
    title: "Можно ещё сегодня",
    amount: "94 THB",
    display: "~$2.88",
    caption: "из бюджета дня 214 THB",
    state: "good"
  });
});

test("builds hero metric from day overrun when today is over budget", () => {
  const hero = buildHeroMetric({
    dayRemaining: 0,
    dayPlanLimit: 214,
    dayOverrun: 21,
    safeToSpendPerDay: 180,
    display: {
      currency: "USD",
      dayOverrun: 0.64,
      safeToSpendPerDay: 5.51
    }
  }, helpers);

  assert.deepEqual(hero, {
    title: "Перерасход сегодня",
    amount: "21 THB",
    display: "~$0.64",
    caption: "бюджет дня 214 THB",
    state: "bad"
  });
});

test("renders dashboard cards with explicit component classes and progress state", () => {
  const cards = buildDashboardCards({
    today: 100,
    week: 700,
    month: 3000,
    dayRemaining: 650,
    dayPlanLimit: 750,
    safeToSpendPerDay: 650,
    weekRemaining: 1200,
    weekPlanLimit: 1900,
    freeRemaining: 16000,
    monthRemaining: 34000,
    monthlyBudget: 42000,
    dayProgressPercent: 10,
    weekProgressPercent: 80.61,
    budgetProgressPercent: 18.81,
    progress: {
      day: { percent: 10, state: "good" },
      week: { percent: 80.61, state: "warn" },
      month: { percent: 18.81, state: "good" }
    },
    display: { currency: "USD", freeRemaining: 519.2 }
  }, helpers);
  const container = { innerHTML: "" };

  renderDashboardCards(container, cards);

  assert.match(container.innerHTML, /class="dashboard-card__title">Сегодня/);
  assert.match(container.innerHTML, /class="dashboard-card__title">Осталось/);
  assert.match(container.innerHTML, /class="dashboard-card__title">Месяц/);
  assert.match(container.innerHTML, /class="dashboard-card__title">Неделя/);
  assert.match(container.innerHTML, /class="dashboard-card__label">осталось/);
  assert.match(container.innerHTML, /class="dashboard-card__value">650 THB/);
  assert.match(container.innerHTML, /class="dashboard-card__display">~\$519\.2/);
  assert.match(container.innerHTML, /class="dashboard-card__progress-fill" data-state="warn" style="width: 80\.61%"/);
});

test("adds an active reserve row inside the remaining card without adding a fifth card", () => {
  const cards = buildDashboardCards({
    today: 100,
    week: 500,
    month: 45000,
    freeRemaining: 0,
    monthlyBudget: 60000,
    reserve: {
      amount: 4000,
      savedAmount: 2500,
      eatenAmount: 1500,
      status: "partially_used"
    },
    progress: {}
  }, {
    ...helpers,
    t: (key, values = {}) => {
      if (key === "reserve.dashboardPartiallyUsed") return `Reserve: used ${values.eaten} of ${values.amount}`;
      return helpers.t(key);
    }
  });

  assert.equal(cards.length, 4);
  assert.equal(cards[1].title, helpers.t("dashboard.remaining"));
  assert.equal(cards[1].reserveLine, "Reserve: used 1500 THB of 4000 THB");
  assert.equal(cards.some((card) => card.title === "Reserve at risk"), false);
});

test("does not render any reserve placeholder when reserve is absent", () => {
  const cards = buildDashboardCards({
    today: 100,
    week: 500,
    month: 45000,
    freeRemaining: 3000,
    monthlyBudget: 60000,
    progress: {}
  }, helpers);

  assert.equal(cards.length, 4);
  assert.equal(cards[1].reserveLine, undefined);
});
