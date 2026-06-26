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
  "dashboard.tooltip.month.title": "Сколько осталось от общего бюджета месяца: {remaining} из {budget} (потрачено {spent}).",
  "dashboard.tooltip.month.body": "month body text",
  "dashboard.tooltip.monthFree.title": "Деньги, которыми реально можно распоряжаться до конца месяца.",
  "dashboard.tooltip.monthFree.body": "monthFree body text",
  "dashboard.tooltip.planned.title": "planned title",
  "dashboard.tooltip.planned.body": "planned body",
  "dashboard.tooltip.heroToday.title": "Твой безопасный лимит на сегодня.",
  "dashboard.tooltip.heroToday.body": "hero body text",
  "dashboard.tooltip.week.title": "week title",
  "dashboard.tooltip.week.body": "По недельному темпу свободно {weeklyPace}, но месяц даёт только {monthlyAllowance} — берём меньшее.",
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
    state: "bad",
    tooltip: {
      title: "Твой безопасный лимит на сегодня.",
      body: "hero body text"
    }
  });
});

test("builds on-track hero title caption and tooltip", () => {
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
  assert.deepEqual(hero.tooltip, {
    title: "Твой безопасный лимит на сегодня.",
    body: "hero body text"
  });
});

test("renders card flip backs with separate bold title and body", () => {
  const cards = buildDashboardCards(semanticSnapshot, helpers);
  const container = { innerHTML: "" };

  renderDashboardCards(container, cards);

  assert.match(container.innerHTML, /data-flip-card/);
  assert.match(container.innerHTML, /data-flip-toggle/);
  assert.match(container.innerHTML, /dashboard-card__flip-inner/);
  assert.match(container.innerHTML, /dashboard-card__face dashboard-card__face--front/);
  assert.match(container.innerHTML, /dashboard-card__face dashboard-card__face--back/);
  assert.match(container.innerHTML, /dashboard-card__back-text/);
  assert.match(container.innerHTML, /dashboard-card__info/);
  assert.doesNotMatch(container.innerHTML, /dashboard-card__tooltip/);
  assert.match(container.innerHTML, /aria-label="Объяснить: До конца месяца"/);
  assert.match(container.innerHTML, /<strong class="dashboard-card__back-title">[^]*<\/strong>\s*<span class="dashboard-card__back-body">/s);
  assert.match(container.innerHTML, /Деньги, которыми реально/);
});

test("month tooltip shows remaining (budget minus spent), not spent", () => {
  const cards = buildDashboardCards(semanticSnapshot, helpers);
  const monthCard = cards.find((card) => card.title === "Месяц");

  assert.equal(monthCard.tooltip.title, "Сколько осталось от общего бюджета месяца: 2519 THB из 48000 THB (потрачено 45481 THB).");
  assert.equal(semanticSnapshot.month, 45481);
  assert.equal(semanticSnapshot.monthlyBudget, 48000);
  assert.equal(semanticSnapshot.monthRemaining, 2519);
});

test("tooltips never leak raw placeholders into rendered markup", () => {
  const cards = buildDashboardCards(semanticSnapshot, helpers);
  const container = { innerHTML: "" };

  renderDashboardCards(container, cards);

  assert.doesNotMatch(container.innerHTML, /\{remaining\}/);
  assert.doesNotMatch(container.innerHTML, /\{spent\}/);
  assert.doesNotMatch(container.innerHTML, /\{budget\}/);
  assert.doesNotMatch(container.innerHTML, /\{weeklyPace\}/);
  assert.doesNotMatch(container.innerHTML, /\{monthlyAllowance\}/);
});
