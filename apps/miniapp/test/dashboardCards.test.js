import test from "node:test";
import assert from "node:assert/strict";
import { buildDashboardCards, buildHeroMetric, renderDashboardCards } from "../src/dashboardCards.js";

const labels = {
  "dashboard.available": "доступно",
  "dashboard.budget": "бюджет",
  "dashboard.explain": "Объяснить",
  "dashboard.freeAfterPlanned": "свободно после плановых оплат",
  "dashboard.freeAfterPlannedAndReserve": "свободно после плановых и резерва",
  "dashboard.month": "Месяц",
  "dashboard.noPlannedAhead": "нет оплат впереди",
  "dashboard.plannedAhead": "Плановые",
  "dashboard.plannedAheadCaption": "оплаты впереди до конца месяца",
  "dashboard.reserveIncluded": "резерв {amount} учтен",
  "dashboard.spent": "потрачено",
  "dashboard.todayCaption": "потрачено {spent} · бюджет дня {budget}",
  "dashboard.todayOverrun": "Перерасход сегодня",
  "dashboard.todayRemaining": "Осталось сегодня",
  "dashboard.tooltip.month": "Остаток бюджета месяца. Потрачено {monthSpent} из {monthBudget} → остаток {monthRemaining}. Плановые и резерв здесь не вычтены — их учитывает «До конца месяца».",
  "dashboard.tooltip.monthFree": "Сколько реально можно потратить до конца месяца. Остаток бюджета {monthRemaining}, плановые {plannedRemaining} → свободно {freeRemaining}.",
  "dashboard.tooltip.monthFreeWithReserve": "Сколько реально можно потратить до конца месяца. Остаток бюджета {monthRemaining}, плановые {plannedRemaining}, резерв {reserveAmount} → свободно {freeRemaining}.",
  "dashboard.tooltip.planned": "Будущие плановые оплаты до конца месяца. Сейчас впереди {plannedRemaining}.",
  "dashboard.tooltip.weekMonthBinding": "Доступно на неделю, но не больше, чем свободно до конца месяца. По неделе осталось {weekRemainingRaw}, месяц разрешает {freeRemaining} → доступно {weekAvailable}.",
  "dashboard.tooltip.weekWeekBinding": "Остаток недели. Потрачено {weekSpent} из {weekBudget} → доступно {weekAvailable}.",
  "dashboard.untilMonthEnd": "До конца месяца",
  "dashboard.week": "Неделя"
};

const helpers = {
  t: (key, values = {}) => {
    const template = labels[key] ?? key;
    return Object.entries(values).reduce((text, [name, value]) => text.replaceAll(`{${name}}`, String(value)), template);
  },
  moneyBase: (value) => `${value} THB`,
  moneyDisplay: (value) => (value == null ? "" : `~$${value}`),
  percent: (value) => `${value}%`
};

const semanticSnapshot = {
  today: 676,
  dayRemaining: 0,
  dayOverrun: 279,
  dayPlanLimit: 397,
  week: 3813,
  weekRemainingRaw: 7387,
  weekAvailable: 1807,
  weekPlanLimit: 11200,
  isMonthBinding: true,
  month: 45481,
  monthRemaining: 2519,
  monthlyBudget: 48000,
  plannedRemaining: 712,
  freeRemaining: 1807,
  reserve: null,
  weekProgressPercent: 34.04,
  budgetProgressPercent: 94.75,
  progress: {
    week: { percent: 34.04, state: "good" },
    month: { percent: 94.75, state: "danger" }
  },
  display: {
    currency: "USD",
    dayOverrun: 8.07,
    dayRemaining: 0,
    dayPlanLimit: 12.16,
    today: 20.71,
    weekAvailable: 55.35,
    monthRemaining: 77.15,
    plannedRemaining: 21.81,
    freeRemaining: 55.35
  }
};

test("builds the semantic dashboard card grid", () => {
  const cards = buildDashboardCards(semanticSnapshot, helpers);

  assert.equal(cards.length, 4);
  assert.deepEqual(cards.map((card) => card.title), ["До конца месяца", "Плановые", "Месяц", "Неделя"]);
  assert.equal(cards.some((card) => card.title === "Сегодня"), false);
  assert.equal(cards[0].amount, "1807 THB");
  assert.equal(cards[0].caption, "свободно после плановых оплат");
  assert.equal(cards[1].amount, "712 THB");
  assert.equal(cards[1].caption, "оплаты впереди до конца месяца");
  assert.equal(cards[2].amount, "2519 THB");
  assert.deepEqual(cards[2].lines.map((line) => `${line.label} ${line.amount}`), [
    "потрачено 45481 THB",
    "бюджет 48000 THB"
  ]);
  assert.equal(cards[3].amount, "1807 THB");
  assert.deepEqual(cards[3].lines.map((line) => `${line.label} ${line.amount}`), [
    "потрачено 3813 THB",
    "бюджет 11200 THB"
  ]);
});

test("uses reserve-aware caption without adding reserve to planned card", () => {
  const cards = buildDashboardCards({
    ...semanticSnapshot,
    reserve: { amount: 4000, savedAmount: 4000, eatenAmount: 0, status: "saved" },
    display: { ...semanticSnapshot.display, reserveAmount: 122.51 }
  }, helpers);

  assert.equal(cards.length, 4);
  assert.equal(cards[0].caption, "свободно после плановых и резерва");
  assert.equal(cards[0].reserveLine, "резерв 4000 THB учтен");
  assert.equal(cards[1].amount, "712 THB");
});

test("marks negative month-free values as danger and does not clamp them", () => {
  const cards = buildDashboardCards({
    ...semanticSnapshot,
    freeRemaining: -320,
    weekAvailable: -320,
    display: { ...semanticSnapshot.display, freeRemaining: -9.8, weekAvailable: -9.8 }
  }, helpers);

  assert.equal(cards[0].amount, "-320 THB");
  assert.equal(cards[0].state, "danger");
  assert.equal(cards[3].amount, "-320 THB");
  assert.equal(cards[3].state, "danger");
});

test("builds hero metric from today-only budget fields", () => {
  const hero = buildHeroMetric(semanticSnapshot, helpers);

  assert.deepEqual(hero, {
    title: "Перерасход сегодня",
    amount: "279 THB",
    display: "~$8.07",
    caption: "потрачено 676 THB · бюджет дня 397 THB",
    state: "bad"
  });
});

test("builds on-track hero title and caption", () => {
  const hero = buildHeroMetric({
    today: 250,
    dayRemaining: 147,
    dayOverrun: 0,
    dayPlanLimit: 397,
    display: { currency: "USD", dayRemaining: 4.5 }
  }, helpers);

  assert.equal(hero.title, "Осталось сегодня");
  assert.equal(hero.amount, "147 THB");
  assert.equal(hero.caption, "потрачено 250 THB · бюджет дня 397 THB");
});

test("renders tooltips and avoids the old limit wording", () => {
  const cards = buildDashboardCards(semanticSnapshot, helpers);
  const container = { innerHTML: "" };

  renderDashboardCards(container, cards);

  assert.match(container.innerHTML, /dashboard-card__info/);
  assert.match(container.innerHTML, /aria-label="Объяснить: До конца месяца"/);
  assert.match(container.innerHTML, /Сколько реально можно потратить/);
  assert.doesNotMatch(container.innerHTML, /лимит/);
  assert.doesNotMatch(container.innerHTML, /limit/);
});
