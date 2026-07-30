import test from "node:test";
import assert from "node:assert/strict";
import { buildDashboardCards, buildHeroMetric, renderBudgetTopupBreakdown, renderDashboardCards } from "../src/dashboardCards.js";

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
  "dashboard.hero.safeToday": "Можно потратить сегодня",
  "dashboard.hero.dayOverrun": "Сегодня выше ориентира",
  "dashboard.hero.dayOverrunHint": "на столько превышен дневной ориентир",
  "dashboard.hero.shortAfterPlanned": "После плановых оплат не хватит",
  "dashboard.hero.freeDeficit": "После плановых оплат не хватит",
  "dashboard.hero.freeDeficitHint": "До конца месяца",
  "dashboard.hero.monthOverrun": "Бюджет месяца превышен",
  "dashboard.hero.monthOverrunHint": "Уже потрачено больше бюджета",
  "dashboard.hero.dangerHint": "Осталось немного от дневного ориентира",
  "dashboard.hero.spentToday": "Сегодня потрачено",
  "dashboard.hero.freeThroughMonthEnd": "До конца месяца",
  "dashboard.hero.budgetOverrun": "Превышение бюджета",
  "dashboard.weekPlanExceeded": "Недельный план превышен",
  "dashboard.monthBudgetExhausted": "Свободный бюджет месяца уже исчерпан",
  "dashboard.tooltip.heroTodayOnTrack": "Можно потратить сегодня и не сломать месяц. Плановые оплаты уже вычтены.",
  "dashboard.tooltip.heroTodayOverspend": "Перерасход относительно бюджета дня. Плановые оплаты уже вычтены.",
  "dashboard.tooltip.monthFree": "Деньги, которыми реально можно распоряжаться до конца месяца. Плановые оплаты уже отложены.",
  "dashboard.tooltip.planned": "Деньги на будущие оплаты: аренда, подписки и другие платежи впереди.",
  "dashboard.tooltip.month": "Остаток общего бюджета месяца. Плановые, которые ещё не оплачены, здесь не вычтены.",
  "dashboard.tooltip.weekMonthBinding": "Лимит недели ограничен месяцем. Берём меньшее из недели и свободного остатка месяца.",
  "dashboard.tooltip.weekWeekBinding": "Остаток недельного бюджета.",
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
  assert.deepEqual(cards[2].progress, { percent: 94.75, state: "danger" });
  assert.deepEqual(cards[2].lines.map((line) => `${line.label} ${line.amount}`), [
    "потрачено 45481 THB",
    "бюджет 48000 THB"
  ]);
  assert.equal(cards[3].amount, "7387 THB");
  assert.deepEqual(cards[3].progress, { percent: 34.04, state: "good" });
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
  assert.equal(cards[3].amount, "7387 THB");
  assert.equal(cards[3].state, "good");
  assert.equal(cards[3].warning, "Свободный бюджет месяца уже исчерпан");
});

test("prioritizes monthly state over daily overrun in the hero", () => {
  const hero = buildHeroMetric(semanticSnapshot, helpers);
  assert.equal(hero.kind, "dayOverrun");
  assert.equal(hero.title, "Сегодня выше ориентира");
  assert.equal(hero.amount, "279 THB");
  assert.equal(hero.state, "danger");
  assert.equal(hero.progress.percent, 100);
  const monthOverrun = buildHeroMetric({ ...semanticSnapshot, monthRemaining: -1250, display: { ...semanticSnapshot.display, monthRemaining: -38.3 } }, helpers);
  assert.equal(monthOverrun.kind, "monthOverrun");
  assert.equal(monthOverrun.amount, "1250 THB");
  assert.equal(monthOverrun.display, "~$38.3");
  assert.equal(monthOverrun.title, "Бюджет месяца превышен");
  assert.equal(monthOverrun.hint, "Уже потрачено больше бюджета");
  assert.equal(monthOverrun.progress.percent, 100);
});

test("builds on-track hero title caption and tooltip", () => {
  const hero = buildHeroMetric({
    today: 250,
    dayRemaining: 147,
    dayOverrun: 0,
    dayPlanLimit: 397,
    display: { currency: "USD", dayRemaining: 4.5 }
  }, helpers);

  assert.equal(hero.title, "Можно потратить сегодня");
  assert.equal(hero.amount, "147 THB");
  assert.equal(hero.caption, "потрачено 250 THB · бюджет дня 397 THB");
  assert.equal(hero.state, "good");
  assert.equal(hero.tooltip, "Можно потратить сегодня и не сломать месяц. Плановые оплаты уже вычтены.");
});

test("uses existing day state and free deficit without inventing thresholds", () => {
  const warn = buildHeroMetric({ ...semanticSnapshot, dayOverrun: 0, dayRemaining: 120, progress: { day: { percent: 73, state: "warn" } } }, helpers);
  assert.equal(warn.kind, "remaining");
  assert.equal(warn.state, "warn");
  assert.equal(warn.progress.percent, 73);
  const deficit = buildHeroMetric({ ...semanticSnapshot, dayOverrun: 0, monthRemaining: 500, freeRemaining: -250, display: { ...semanticSnapshot.display, freeRemaining: -7.6 } }, helpers);
  assert.equal(deficit.kind, "freeDeficit");
  assert.equal(deficit.title, "После плановых оплат не хватит");
  assert.equal(deficit.amount, "250 THB");
  assert.equal(deficit.display, "~$7.6");
  assert.equal(deficit.hint, "До конца месяца");
  assert.equal(deficit.monthLabel, "После плановых оплат не хватит");
  assert.equal(deficit.monthValue, "250 THB");
  assert.equal(deficit.progress.percent, 100);
});

test("hero progress follows the metric shown and handles a zero daily target", () => {
  const onTrack = buildHeroMetric({
    today: 250,
    dayRemaining: 750,
    dayOverrun: 0,
    dayPlanLimit: 1000,
    freeRemaining: 18700,
    monthRemaining: 25100,
    monthlyBudget: 51000,
    progress: { day: { percent: 25, state: "good" } }
  }, helpers);
  assert.deepEqual(onTrack.progress, { percent: 25, state: "good" });

  const zeroTarget = buildHeroMetric({
    today: 0,
    dayRemaining: 0,
    dayOverrun: 0,
    dayPlanLimit: 0,
    freeRemaining: 0,
    monthRemaining: 0,
    monthlyBudget: 0,
    progress: { day: { percent: Number.NaN, state: "good" } }
  }, helpers);
  assert.deepEqual(zeroTarget.progress, { percent: 0, state: "good" });
  assert.equal(zeroTarget.spent, "0 THB");
});

test("week card keeps weekly remaining independent from exhausted month budget", () => {
  const cards = buildDashboardCards({
    ...semanticSnapshot,
    freeRemaining: -3023,
    weekAvailable: -3023,
    weekRemainingRaw: 7387
  }, helpers);
  const weekCard = cards.at(-1);

  assert.equal(weekCard.amount, "7387 THB");
  assert.equal(weekCard.state, "good");
  assert.equal(weekCard.caption, undefined);
  assert.equal(weekCard.warning, "Свободный бюджет месяца уже исчерпан");
});

test("week card adds a short caption only when the weekly plan is exceeded", () => {
  const cards = buildDashboardCards({
    ...semanticSnapshot,
    week: 12436,
    weekRemainingRaw: -920,
    weekPlanLimit: 11516,
    weekProgressPercent: 108,
    progress: {
      ...semanticSnapshot.progress,
      week: { percent: 108, state: "danger" }
    },
    display: {
      ...semanticSnapshot.display,
      weekRemainingRaw: -28.2
    }
  }, helpers);
  const weekCard = cards.at(-1);

  assert.equal(weekCard.amount, "-920 THB");
  assert.equal(weekCard.state, "danger");
  assert.equal(weekCard.caption, "Недельный план превышен");
});

test("renders card flip backs as a single compact paragraph", () => {
  const cards = buildDashboardCards(semanticSnapshot, helpers);
  const container = { innerHTML: "" };

  renderDashboardCards(container, cards);

  assert.match(container.innerHTML, /data-flip-card/);
  assert.match(container.innerHTML, /data-flip-toggle/);
  assert.match(container.innerHTML, /dashboard-card__flip-inner/);
  assert.match(container.innerHTML, /dashboard-card__face dashboard-card__face--front/);
  assert.match(container.innerHTML, /dashboard-card__face dashboard-card__face--back/);
  assert.match(container.innerHTML, /<p class="dashboard-card__back-text">/);
  assert.match(container.innerHTML, /dashboard-card__info/);
  assert.doesNotMatch(container.innerHTML, /dashboard-card__tooltip/);
  assert.doesNotMatch(container.innerHTML, /dashboard-card__back-title/);
  assert.doesNotMatch(container.innerHTML, /dashboard-card__back-body/);
  assert.match(container.innerHTML, /aria-label="Объяснить: До конца месяца"/);
  assert.match(container.innerHTML, /Деньги, которыми реально/);
});

test("month tooltip explains unpaid planned payments without numbers", () => {
  const cards = buildDashboardCards(semanticSnapshot, helpers);
  const monthCard = cards.find((card) => card.title === "Месяц");

  assert.equal(
    monthCard.tooltip,
    "Остаток общего бюджета месяца. Плановые, которые ещё не оплачены, здесь не вычтены."
  );
  assert.match(monthCard.tooltip, /ещё не оплачены/);
  assert.match(monthCard.tooltip, /не вычтены/);
  assert.doesNotMatch(monthCard.tooltip, /\{|\d{3,}/);
});

test("week tooltip switches between month-bound and week-bound copy", () => {
  const bound = buildDashboardCards(semanticSnapshot, helpers).find((card) => card.title === "Неделя");
  const unbound = buildDashboardCards({ ...semanticSnapshot, isMonthBinding: false }, helpers).find((card) => card.title === "Неделя");

  assert.equal(bound.tooltip, "Лимит недели ограничен месяцем. Берём меньшее из недели и свободного остатка месяца.");
  assert.equal(unbound.tooltip, "Остаток недельного бюджета.");
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

test("renders compact budget top-up breakdown only when top-ups exist", () => {
  const container = { innerHTML: "", classList: { toggled: [], toggle(name, value) { this.toggled.push([name, value]); } } };
  renderBudgetTopupBreakdown(container, {
    baseBudget: 48000,
    topupsTotal: 5000,
    amount: 53000,
    topups: [{ amount_base: 5000, occurred_at: "2026-06-29T10:00:00Z" }]
  }, {
    t: (key, values = {}) => {
      const labels = {
        "budgetTopup.title": "Monthly budget",
        "budgetTopup.baseBudget": "Base budget",
        "budgetTopup.baseShort": "Base",
        "budgetTopup.topups": "Top-ups",
        "budgetTopup.topupsShort": "top-ups",
        "budgetTopup.totalBudget": "Total budget",
        "budgetTopup.details": "Details",
        "budgetTopup.historyTitle": "Recent top-ups",
        "budgetTopup.historyItem": `+${values.amount} · Budget top-up · ${values.date}`
      };
      return labels[key] ?? key;
    },
    moneyBase: (value) => `${value} THB`,
    formatDate: () => "Jun 29"
  });

  assert.match(container.innerHTML, /Monthly budget/);
  assert.match(container.innerHTML, /53000 THB/);
  assert.match(container.innerHTML, /Base 48000 THB/);
  assert.match(container.innerHTML, /top-ups \+5000 THB/);
  assert.match(container.innerHTML, /Details/);
  assert.doesNotMatch(container.innerHTML, /Base budget/);
  assert.doesNotMatch(container.innerHTML, /Top-ups/);
  assert.doesNotMatch(container.innerHTML, /Total budget/);
  assert.doesNotMatch(container.innerHTML, /Recent/);
  assert.doesNotMatch(container.innerHTML, /Budget top-up/);

  const empty = { innerHTML: "x", classList: { hidden: false, toggle(_name, value) { this.hidden = value; } } };
  renderBudgetTopupBreakdown(empty, { topupsTotal: 0, topups: [] }, { t: () => "", moneyBase: () => "", formatDate: () => "" });
  assert.equal(empty.innerHTML, "");
  assert.equal(empty.classList.hidden, true);
});

test("budget top-up breakdown is collapsed by default and expands locally", () => {
  let toggleHandler = null;
  const container = {
    innerHTML: "",
    classList: { toggle() {} },
    querySelector(selector) {
      if (selector !== "[data-budget-topup-toggle]") return null;
      return { addEventListener(_event, handler) { toggleHandler = handler; } };
    }
  };
  const helpers = {
    t: (key, values = {}) => {
      const labels = {
        "budgetTopup.title": "Monthly budget",
        "budgetTopup.baseBudget": "Base budget",
        "budgetTopup.baseShort": "Base",
        "budgetTopup.topups": "Top-ups",
        "budgetTopup.topupsShort": "top-ups",
        "budgetTopup.totalBudget": "Total budget",
        "budgetTopup.total": "Total",
        "budgetTopup.details": "Details",
        "budgetTopup.collapse": "Collapse",
        "budgetTopup.historyTitle": "Recent top-ups",
        "budgetTopup.recent": "Recent",
        "budgetTopup.historyItem": `+${values.amount} - Budget top-up - ${values.date}`,
        "budgetTopup.historyItemCompact": `+${values.amount} - ${values.date}`
      };
      return labels[key] ?? key;
    },
    moneyBase: (value) => `${value} THB`,
    formatDate: () => "Jun 29"
  };
  const currentMonthBudget = {
    baseBudget: 48000,
    topupsTotal: 5000,
    amount: 53000,
    topups: [{ amount_base: 5000, occurred_at: "2026-06-29T10:00:00Z" }]
  };

  renderBudgetTopupBreakdown(container, currentMonthBudget, helpers);

  assert.match(container.innerHTML, /budget-topup-card/);
  assert.match(container.innerHTML, /aria-expanded="false"/);
  assert.match(container.innerHTML, /Details/);
  assert.match(container.innerHTML, /Base 48000 THB/);
  assert.match(container.innerHTML, /top-ups \+5000 THB/);
  assert.doesNotMatch(container.innerHTML, /Base budget/);
  assert.doesNotMatch(container.innerHTML, /Top-ups/);
  assert.doesNotMatch(container.innerHTML, /Total budget/);
  assert.doesNotMatch(container.innerHTML, /Recent/);
  assert.equal(typeof toggleHandler, "function");

  toggleHandler();

  assert.match(container.innerHTML, /budget-topup-card--expanded/);
  assert.match(container.innerHTML, /aria-expanded="true"/);
  assert.match(container.innerHTML, /Collapse/);
  assert.match(container.innerHTML, /Base budget/);
  assert.match(container.innerHTML, /Top-ups/);
  assert.match(container.innerHTML, /Total budget/);
  assert.match(container.innerHTML, /Recent/);
  assert.match(container.innerHTML, /\+5000 THB - Jun 29/);
});
