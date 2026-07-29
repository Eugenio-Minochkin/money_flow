import { escapeHtml } from "./formatters.js";

const budgetTopupExpandedByContainer = new WeakMap();

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
  const todayTotal = Number(snapshot.today ?? 0);
  const dayRemaining = Number(snapshot.dayRemaining ?? 0);
  const dayOverrun = Number(snapshot.dayOverrun ?? 0);
  const dayPlanLimit = Number(snapshot.dayPlanLimit ?? 0);
  const monthRemaining = Number(snapshot.monthRemaining ?? snapshot.remaining ?? 0);
  const freeRemaining = Number(snapshot.freeRemaining ?? 0);
  const dayState = snapshot.progress?.day?.state ?? "good";
  let kind = "remaining";
  if (monthRemaining < 0) kind = "monthOverrun";
  else if (freeRemaining < 0) kind = "freeDeficit";
  else if (dayOverrun > 0) kind = "dayOverrun";
  const amountByKind = {
    monthOverrun: Math.abs(monthRemaining),
    freeDeficit: Math.abs(freeRemaining),
    dayOverrun,
    remaining: dayRemaining
  };
  const displayByKind = {
    monthOverrun: Math.abs(Number(snapshot.display?.monthRemaining ?? 0)),
    freeDeficit: Math.abs(Number(snapshot.display?.freeRemaining ?? 0)),
    dayOverrun: snapshot.display?.dayOverrun,
    remaining: snapshot.display?.dayRemaining
  };
  const state = kind === "remaining" ? dayState : "danger";
  const titleKey = {
    monthOverrun: "dashboard.hero.monthOverrun",
    freeDeficit: "dashboard.hero.freeDeficit",
    dayOverrun: "dashboard.hero.dayOverrun",
    remaining: "dashboard.hero.safeToday"
  }[kind];
  const hintKey = {
    monthOverrun: "dashboard.hero.monthOverrunHint",
    freeDeficit: "dashboard.hero.freeDeficitHint",
    dayOverrun: "dashboard.hero.dayOverrunHint",
    remaining: state === "danger" ? "dashboard.hero.dangerHint" : ""
  }[kind];

  return {
    kind,
    title: helpers.t(titleKey),
    amount: helpers.moneyBase(amountByKind[kind]),
    display: helpers.moneyDisplay(displayByKind[kind], snapshot.display?.currency),
    hint: hintKey ? helpers.t(hintKey) : "",
    spentLabel: helpers.t("dashboard.hero.spentToday"),
    spent: `${helpers.moneyBase(todayTotal)} / ${helpers.moneyBase(dayPlanLimit)}`,
    monthLabel: helpers.t(kind === "monthOverrun" ? "dashboard.hero.budgetOverrun" : "dashboard.hero.freeThroughMonthEnd"),
    monthValue: helpers.moneyBase(kind === "monthOverrun" ? Math.abs(monthRemaining) : freeRemaining),
    progress: { percent: Math.max(0, Math.min(Number(snapshot.progress?.day?.percent ?? 0), 100)), state },
    caption: helpers.t("dashboard.todayCaption", {
      spent: helpers.moneyBase(todayTotal),
      budget: helpers.moneyBase(dayPlanLimit)
    }),
    state,
    tooltip: helpers.t(kind === "dayOverrun" ? "dashboard.tooltip.heroTodayOverspend" : "dashboard.tooltip.heroTodayOnTrack")
  };
}

export function buildDashboardCards(snapshot, helpers) {
  const weekProgress = snapshot.progress?.week ?? { percent: snapshot.weekProgressPercent ?? 0, state: "good" };
  const monthProgress = snapshot.progress?.month ?? { percent: snapshot.budgetProgressPercent ?? 0, state: "good" };
  const explainLabel = helpers.t("dashboard.explain");
  const freeRemaining = Number(snapshot.freeRemaining ?? 0);
  const monthRemaining = Number(snapshot.monthRemaining ?? snapshot.remaining ?? 0);
  const plannedRemaining = Number(snapshot.plannedRemaining ?? 0);
  const reserveAmount = Number(snapshot.reserve?.amount ?? 0);
  const weekAvailable = Number(snapshot.weekAvailable ?? snapshot.weekRemaining ?? 0);
  const monthFreeCard = {
    title: helpers.t("dashboard.untilMonthEnd"),
    amount: helpers.moneyBase(snapshot.freeRemaining),
    display: helpers.moneyDisplay(snapshot.display?.freeRemaining, snapshot.display?.currency),
    caption: helpers.t(reserveAmount > 0 ? "dashboard.freeAfterPlannedAndReserve" : "dashboard.freeAfterPlanned"),
    state: freeRemaining < 0 ? "danger" : "good",
    infoLabel: explainLabel,
    reserveLine: reserveAmount > 0 ? helpers.t("dashboard.reserveIncluded", { amount: helpers.moneyBase(reserveAmount) }) : undefined,
    tooltip: helpers.t("dashboard.tooltip.monthFree")
  };
  const plannedCard = {
    title: helpers.t("dashboard.plannedAhead"),
    amount: helpers.moneyBase(plannedRemaining),
    display: helpers.moneyDisplay(snapshot.display?.plannedRemaining, snapshot.display?.currency),
    caption: helpers.t(plannedRemaining > 0 ? "dashboard.plannedAheadCaption" : "dashboard.noPlannedAhead"),
    infoLabel: explainLabel,
    tooltip: helpers.t("dashboard.tooltip.planned")
  };
  const monthCard = {
    title: helpers.t("dashboard.month"),
    amount: helpers.moneyBase(monthRemaining),
    display: helpers.moneyDisplay(snapshot.display?.monthRemaining, snapshot.display?.currency),
    percent: helpers.percent(snapshot.budgetProgressPercent ?? 0),
    state: monthProgress.state,
    lines: [
      remainingLine(helpers.t("dashboard.spent"), helpers.moneyBase(snapshot.month)),
      budgetLine(helpers.t("dashboard.budget"), helpers.moneyBase(snapshot.monthlyBudget ?? 0))
    ],
    progress: monthProgress,
    infoLabel: explainLabel,
    tooltip: helpers.t("dashboard.tooltip.month")
  };
  const weekCard = {
    title: helpers.t("dashboard.week"),
    amount: helpers.moneyBase(weekAvailable),
    display: helpers.moneyDisplay(snapshot.display?.weekAvailable, snapshot.display?.currency),
    percent: helpers.percent(snapshot.weekProgressPercent ?? 0),
    state: weekAvailable < 0 ? "danger" : weekProgress.state,
    lines: [
      remainingLine(helpers.t("dashboard.spent"), helpers.moneyBase(snapshot.week)),
      budgetLine(helpers.t("dashboard.budget"), helpers.moneyBase(snapshot.weekPlanLimit ?? 0))
    ],
    progress: weekProgress,
    infoLabel: explainLabel,
    tooltip: helpers.t(snapshot.isMonthBinding ? "dashboard.tooltip.weekMonthBinding" : "dashboard.tooltip.weekWeekBinding")
  };

  return [monthFreeCard, plannedCard, monthCard, weekCard];
}

export function renderDashboardCards(container, cards) {
  if (!container) return;
  container.innerHTML = cards.map(renderCard).join("");
}

export function renderBudgetTopupBreakdown(container, currentMonthBudget, helpers) {
  if (!container) return;
  const topups = Array.isArray(currentMonthBudget?.topups) ? currentMonthBudget.topups : [];
  const topupsTotal = Number(currentMonthBudget?.topupsTotal ?? 0);
  if (topups.length === 0 && topupsTotal <= 0) {
    container.innerHTML = "";
    container.classList?.toggle?.("hidden", true);
    return;
  }
  container.classList?.toggle?.("hidden", false);
  const baseBudget = Number(currentMonthBudget.baseBudget ?? currentMonthBudget.amount ?? 0);
  const totalBudget = Number(currentMonthBudget.amount ?? baseBudget + topupsTotal);
  const expanded = budgetTopupExpandedByContainer.get(container) === true;
  const recent = topups.length > 0
    ? `<div class="budget-topup-card__history">
        <span class="budget-topup-card__history-title">${escapeHtml(helpers.t("budgetTopup.recent"))}</span>
        ${topups.map((topup) => {
          const amount = helpers.moneyBase(Number(topup.amount_base ?? topup.amount ?? 0));
          const date = helpers.formatDate?.(topup.occurred_at ?? topup.local_date) ?? "";
          const fullLabel = helpers.t("budgetTopup.historyItem", { amount, date });
          return `<div class="budget-topup-card__item" aria-label="${escapeHtml(fullLabel)}">${escapeHtml(helpers.t("budgetTopup.historyItemCompact", { amount, date }))}</div>`;
        }).join("")}
      </div>`
    : "";
  const summary = `${escapeHtml(helpers.t("budgetTopup.baseShort"))} ${escapeHtml(helpers.moneyBase(baseBudget))} · ${escapeHtml(helpers.t("budgetTopup.topupsShort"))} +${escapeHtml(helpers.moneyBase(topupsTotal))}`;
  const details = expanded
    ? `<div class="budget-topup-card__details">
        <div class="budget-topup-card__line"><span>${escapeHtml(helpers.t("budgetTopup.baseBudget"))}</span><b>${escapeHtml(helpers.moneyBase(baseBudget))}</b></div>
        <div class="budget-topup-card__line"><span>${escapeHtml(helpers.t("budgetTopup.topups"))}</span><b>+${escapeHtml(helpers.moneyBase(topupsTotal))}</b></div>
        <div class="budget-topup-card__line budget-topup-card__line--total"><span>${escapeHtml(helpers.t("budgetTopup.totalBudget"))}</span><b>${escapeHtml(helpers.moneyBase(totalBudget))}</b></div>
        ${recent}
      </div>`
    : "";
  container.innerHTML = `
    <section class="budget-topup-card${expanded ? " budget-topup-card--expanded" : ""}" aria-label="${escapeHtml(helpers.t("budgetTopup.title"))}">
      <div class="budget-topup-card__head">
        <div class="budget-topup-card__title">
          <span>${escapeHtml(helpers.t("budgetTopup.title"))}</span>
          <strong>${escapeHtml(helpers.moneyBase(totalBudget))}</strong>
        </div>
        <button class="ghost-button budget-topup-card__toggle" type="button" aria-expanded="${expanded ? "true" : "false"}" data-budget-topup-toggle>
          ${expanded ? "⌃" : "⌄"} ${escapeHtml(helpers.t(expanded ? "budgetTopup.collapse" : "budgetTopup.details"))}
        </button>
      </div>
      <div class="budget-topup-card__summary">${summary}</div>
      ${details}
    </section>
  `;
  const toggle = container.querySelector?.("[data-budget-topup-toggle]");
  toggle?.addEventListener?.("click", () => {
    budgetTopupExpandedByContainer.set(container, !expanded);
    renderBudgetTopupBreakdown(container, currentMonthBudget, helpers);
  });
}

function cardLine(label, amount) {
  return { label, amount };
}

function renderCard(card) {
  const progress = card.progress ? renderProgress(card.progress) : renderProgress(null);
  const percent = card.percent
    ? `<b class="dashboard-card__percent" data-state="${escapeHtml(card.state ?? "good")}">${escapeHtml(card.percent)}</b>`
    : `<b class="dashboard-card__percent" aria-hidden="true">&nbsp;</b>`;
  const tooltipId = card.tooltip ? `dashboard-tooltip-${slugify(card.title)}` : "";
  const info = card.tooltip ? `
        <button class="dashboard-card__info" type="button" aria-expanded="false" aria-controls="${escapeHtml(tooltipId)}" aria-label="${escapeHtml(`${card.infoLabel ?? "Объяснить"}: ${card.title}`)}" data-flip-toggle>
          i
        </button>` : "";
  const lines = (card.lines ?? []).map((line) => `
    <div class="dashboard-card__line">
      <span class="dashboard-card__label">${escapeHtml(line.label)}</span>
      <b class="dashboard-card__value">${escapeHtml(line.amount)}</b>
    </div>
  `).join("");
  const display = card.display ? `<div class="dashboard-card__display">${escapeHtml(card.display)}</div>` : "";
  const caption = card.caption ? `<div class="dashboard-card__caption">${escapeHtml(card.caption)}</div>` : "";
  const reserveLine = card.reserveLine ? `<div class="dashboard-card__reserve">${escapeHtml(card.reserveLine)}</div>` : "";
  const back = card.tooltip ? `
        <div class="dashboard-card__face dashboard-card__face--back" id="${escapeHtml(tooltipId)}" role="note" tabindex="-1" aria-hidden="true" aria-live="polite" data-flip-back>
          <p class="dashboard-card__back-text">${escapeHtml(card.tooltip)}</p>
        </div>` : "";

  return `
    <article class="dashboard-card${card.tooltip ? " dashboard-card--flip" : ""}${card.progress ? " dashboard-card--progress" : ""}${card.state === "danger" || card.state === "bad" ? " dashboard-card--danger" : ""}"${card.tooltip ? " data-flip-card" : ""}>
      <div class="dashboard-card__flip-inner">
        <div class="dashboard-card__face dashboard-card__face--front" data-flip-front>
          <div class="dashboard-card__top">
            <span class="dashboard-card__title">${escapeHtml(card.title)}</span>
            ${percent}
            ${info}
          </div>
          <strong class="dashboard-card__amount">${escapeHtml(card.amount)}</strong>
          ${lines}
          ${display}
          ${caption}
          ${reserveLine}
          <div class="dashboard-card__spacer"></div>
          ${progress}
        </div>
        ${back}
      </div>
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

function slugify(value) {
  return String(value)
    .toLowerCase()
    .replace(/[^\p{Letter}\p{Number}]+/gu, "-")
    .replace(/^-|-$/g, "") || "card";
}
