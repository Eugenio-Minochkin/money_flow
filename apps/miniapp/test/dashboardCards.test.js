import test from "node:test";
import assert from "node:assert/strict";
import { buildDashboardCards, renderDashboardCards } from "../src/dashboardCards.js";

const helpers = {
  t: (key) => ({
    "dashboard.today": "Сегодня",
    "dashboard.week": "Неделя",
    "dashboard.remaining": "Осталось",
    "dashboard.month": "Месяц",
    "dashboard.remainingPrefix": "осталось",
    "dashboard.limitPrefix": "лимит",
    "dashboard.budget": "бюджет",
    "dashboard.overrun": "перерасход",
    "dashboard.safeToSpendPerDay": "Можно в день до конца месяца",
    "dashboard.afterExpensesAndPlanned": "после расходов и плановых оплат"
  })[key] ?? key,
  moneyBase: (value) => `${value} THB`,
  moneyDisplay: (value) => `~$${value}`,
  percent: (value) => `${value}%`
};

test("builds dashboard cards with remaining before limit and budget lines", () => {
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
  assert.deepEqual(cards[0].lines.map((line) => line.label), ["Можно в день до конца месяца"]);
  assert.deepEqual(cards[0].lines.map((line) => line.amount), ["650 THB"]);
  assert.deepEqual(cards[1].lines.map((line) => line.label), ["осталось", "лимит"]);
  assert.deepEqual(cards[3].lines.map((line) => line.label), ["осталось", "бюджет"]);
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

  assert.deepEqual(cards[0].lines.map((line) => line.label), ["Можно в день до конца месяца"]);
  assert.deepEqual(cards[0].lines.map((line) => line.amount), ["428 THB"]);
});

test("today card shows safe-to-spend pace instead of stable day plan limit", () => {
  const cards = buildDashboardCards({
    today: 10,
    dayPlanLimit: 1600,
    dayRemaining: 1590,
    safeToSpendPerDay: 428,
    dayProgressPercent: 0.625,
    progress: {
      day: { percent: 0.625, state: "good" }
    }
  }, {
    ...helpers,
    t: (key) => key === "dashboard.safeToSpendPerDay"
      ? "Можно в день до конца месяца"
      : helpers.t(key)
  });

  assert.equal(cards[0].amount, "10 THB");
  assert.deepEqual(cards[0].lines.map((line) => line.label), ["Можно в день до конца месяца"]);
  assert.deepEqual(cards[0].lines.map((line) => line.amount), ["428 THB"]);
  assert.equal(cards[0].progress, null);
  assert.equal(cards[0].percent, null);
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
  assert.match(container.innerHTML, /class="dashboard-card__label">осталось/);
  assert.match(container.innerHTML, /class="dashboard-card__value">650 THB/);
  assert.match(container.innerHTML, /class="dashboard-card__display">~\$519\.2/);
  assert.match(container.innerHTML, /class="dashboard-card__progress-fill" data-state="warn" style="width: 80\.61%"/);
});

test("adds a reserve card when an active reserve is present", () => {
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
    t: (key) => key === "reserve.atRisk" ? "Reserve at risk" : helpers.t(key)
  });

  const reserve = cards.find((card) => card.title === "Reserve at risk");
  assert.ok(reserve);
  assert.equal(reserve.amount, "2500 THB");
});
