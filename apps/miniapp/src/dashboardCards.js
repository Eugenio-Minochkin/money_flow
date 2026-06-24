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

export function buildDashboardCards(snapshot, helpers) {
  const safeToSpendPerDay = Number(snapshot.safeToSpendPerDay ?? 0);
  const weekProgress = snapshot.progress?.week ?? { percent: snapshot.weekProgressPercent ?? 0, state: "good" };
  const monthProgress = snapshot.progress?.month ?? { percent: snapshot.budgetProgressPercent ?? 0, state: "good" };

  const cards = [
    {
      title: helpers.t("dashboard.today"),
      amount: helpers.moneyBase(snapshot.today),
      percent: null,
      state: null,
      lines: [
        limitLine(helpers.t("dashboard.safeToSpendPerDay"), helpers.moneyBase(safeToSpendPerDay))
      ],
      progress: null
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
      caption: helpers.t("dashboard.afterExpensesAndPlanned")
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
  if (snapshot.reserve) {
    const statusKey = snapshot.reserve.status === "saved"
      ? "reserve.saved"
      : snapshot.reserve.status === "partially_used"
        ? "reserve.atRisk"
        : "reserve.usedUp";
    cards.splice(3, 0, {
      title: helpers.t(statusKey),
      amount: helpers.moneyBase(snapshot.reserve.savedAmount),
      lines: snapshot.reserve.eatenAmount > 0
        ? [remainingLine(helpers.t("reserve.used"), helpers.moneyBase(snapshot.reserve.eatenAmount))]
        : [remainingLine(helpers.t("reserve.total"), helpers.moneyBase(snapshot.reserve.amount))]
    });
  }
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
      <div class="dashboard-card__spacer"></div>
      ${progress}
    </article>
  `;
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
