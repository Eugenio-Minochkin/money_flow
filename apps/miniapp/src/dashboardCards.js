import { escapeHtml } from "./formatters.js";

export function remainingLine(label, amount) {
  return cardLine(label, amount);
}

export function limitLine(label, amount) {
  return cardLine(label, amount);
}

export function budgetLine(label, amount) {
  return cardLine(label, amount);
}

export function buildHeroMetric(snapshot, helpers) {
  const dayRemaining = Number(snapshot.dayRemaining ?? 0);
  const dayOverrun = Number(snapshot.dayOverrun ?? 0);
  const dayPlanLimit = Number(snapshot.dayPlanLimit ?? 0);
  const hasOverrun = dayOverrun > 0;
  const amount = hasOverrun ? dayOverrun : dayRemaining;
  const displayAmount = hasOverrun ? snapshot.display?.dayOverrun : snapshot.display?.dayRemaining;
  const captionKey = hasOverrun ? "dashboard.dayBudget" : "dashboard.ofDayBudget";

  return {
    title: helpers.t(hasOverrun ? "dashboard.todayOverrun" : "dashboard.canStillSpendToday"),
    amount: helpers.moneyBase(amount),
    display: helpers.moneyDisplay(displayAmount, snapshot.display?.currency),
    caption: `${helpers.t(captionKey)} ${helpers.moneyBase(dayPlanLimit)}`,
    state: hasOverrun ? "bad" : "good"
  };
}

export function buildDashboardCards(snapshot, helpers) {
  const dayPlanLimit = Number(snapshot.dayPlanLimit ?? 0);
  const todayTotal = Number(snapshot.today ?? 0);
  const dayRemaining = Number(snapshot.dayRemaining ?? 0);
  const dayOverrun = Number(snapshot.dayOverrun ?? Math.max(todayTotal - dayPlanLimit, 0));
  const computedDayPercent = dayPlanLimit > 0 ? (todayTotal / dayPlanLimit) * 100 : 0;
  const dayProgressPercent = Number(snapshot.dayProgressPercent ?? computedDayPercent);
  const dayProgress = snapshot.progress?.day ?? {
    percent: dayProgressPercent,
    state: dayOverrun > 0 || dayProgressPercent > 100 ? "bad" : "good"
  };
  const weekProgress = snapshot.progress?.week ?? { percent: snapshot.weekProgressPercent ?? 0, state: "good" };
  const monthProgress = snapshot.progress?.month ?? { percent: snapshot.budgetProgressPercent ?? 0, state: "good" };

  const todayLines = dayOverrun > 0
    ? [
        limitLine(helpers.t("dashboard.overrun"), helpers.moneyBase(dayOverrun)),
        budgetLine(helpers.t("dashboard.dayBudget"), helpers.moneyBase(dayPlanLimit))
      ]
    : [
        remainingLine(helpers.t("dashboard.remainingPrefix"), helpers.moneyBase(dayRemaining)),
        budgetLine(helpers.t("dashboard.dayBudget"), helpers.moneyBase(dayPlanLimit))
      ];

  const cards = [
    {
      title: helpers.t("dashboard.today"),
      amount: helpers.moneyBase(snapshot.today),
      percent: helpers.percent(dayProgressPercent),
      state: dayProgress.state,
      lines: todayLines,
      progress: dayProgress
    },
    {
      title: helpers.t("dashboard.week"),
      amount: helpers.moneyBase(snapshot.week),
      percent: helpers.percent(snapshot.weekProgressPercent ?? 0),
      state: weekProgress.state,
      lines: [
        remainingLine(helpers.t("dashboard.remainingPrefix"), helpers.moneyBase(snapshot.weekRemaining)),
        limitLine(helpers.t("dashboard.limitPrefix"), helpers.moneyBase(snapshot.weekPlanLimit ?? 0))
      ],
      progress: weekProgress
    },
    {
      title: helpers.t("dashboard.remaining"),
      amount: helpers.moneyBase(snapshot.freeRemaining),
      display: helpers.moneyDisplay(snapshot.display?.freeRemaining, snapshot.display?.currency),
      caption: helpers.t("dashboard.afterExpensesAndPlanned"),
      reserveLine: snapshot.reserve ? reserveLine(snapshot.reserve, helpers) : undefined
    },
    {
      title: helpers.t("dashboard.month"),
      amount: helpers.moneyBase(snapshot.month),
      percent: helpers.percent(snapshot.budgetProgressPercent ?? 0),
      state: monthProgress.state,
      lines: [
        remainingLine(helpers.t("dashboard.remainingPrefix"), helpers.moneyBase(snapshot.monthRemaining ?? snapshot.remaining)),
        budgetLine(helpers.t("dashboard.budget"), helpers.moneyBase(snapshot.monthlyBudget ?? 0))
      ],
      progress: monthProgress
    }
  ];
  return cards;
}

export function renderDashboardCards(container, cards) {
  if (!container) return;
  container.innerHTML = cards.map(renderCard).join("");
}

function cardLine(label, amount) {
  return { label, amount };
}

function renderCard(card) {
  const progress = card.progress ? renderProgress(card.progress) : renderProgress(null);
  const percent = card.percent
    ? `<b class="dashboard-card__percent" data-state="${escapeHtml(card.state ?? "good")}">${escapeHtml(card.percent)}</b>`
    : `<b class="dashboard-card__percent" aria-hidden="true">&nbsp;</b>`;
  const lines = (card.lines ?? []).map((line) => `
    <div class="dashboard-card__line">
      <span class="dashboard-card__label">${escapeHtml(line.label)}</span>
      <b class="dashboard-card__value">${escapeHtml(line.amount)}</b>
    </div>
  `).join("");
  const display = card.display ? `<div class="dashboard-card__display">${escapeHtml(card.display)}</div>` : "";
  const caption = card.caption ? `<div class="dashboard-card__caption">${escapeHtml(card.caption)}</div>` : "";
  const reserveLine = card.reserveLine ? `<div class="dashboard-card__reserve">${escapeHtml(card.reserveLine)}</div>` : "";

  return `
    <article class="dashboard-card${card.progress ? " dashboard-card--progress" : ""}">
      <div class="dashboard-card__top">
        <span class="dashboard-card__title">${escapeHtml(card.title)}</span>
        ${percent}
      </div>
      <strong class="dashboard-card__amount">${escapeHtml(card.amount)}</strong>
      ${lines}
      ${display}
      ${caption}
      ${reserveLine}
      <div class="dashboard-card__spacer"></div>
      ${progress}
    </article>
  `;
}

function reserveLine(reserve, helpers) {
  const eaten = Number(reserve.eatenAmount ?? 0);
  const amount = Number(reserve.amount ?? 0);
  if (reserve.status === "used_up" || (amount > 0 && eaten >= amount)) {
    return helpers.t("reserve.dashboardUsedUp");
  }
  if (eaten > 0) {
    return helpers.t("reserve.dashboardPartiallyUsed", {
      eaten: helpers.moneyBase(eaten),
      amount: helpers.moneyBase(amount)
    });
  }
  return helpers.t("reserve.dashboardSaved", {
    amount: helpers.moneyBase(reserve.savedAmount ?? amount)
  });
}

function renderProgress(progress) {
  if (!progress) {
    return `
      <div class="dashboard-card__progress dashboard-card__progress--hidden" aria-hidden="true">
        <div class="dashboard-card__progress-fill"></div>
      </div>
    `;
  }
  const percent = Math.max(0, Math.min(Number(progress.percent ?? 0), 100));
  const state = progress.state ?? "good";
  return `
    <div class="dashboard-card__progress" aria-hidden="true">
      <div class="dashboard-card__progress-fill" data-state="${escapeHtml(state)}" style="width: ${percent}%"></div>
    </div>
  `;
}
