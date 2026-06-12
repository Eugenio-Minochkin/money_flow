import { formatMoney } from "./formatters.js";

const DEMO_USER_ID = 100001;
const quickMessages = [
  "coffee 70 baht",
  "groceries 500 baht",
  "planned rent 20000 baht monthly",
  "large purchase monitor 8000 baht",
  "/today",
  "/month",
  "/budget"
];

const els = {
  today: document.querySelector("#today"),
  month: document.querySelector("#month"),
  budget: document.querySelector("#budget"),
  free: document.querySelector("#free"),
  form: document.querySelector("#message-form"),
  input: document.querySelector("#message-input"),
  quick: document.querySelector("#quick-messages"),
  botText: document.querySelector("#bot-text"),
  keyboard: document.querySelector("#keyboard"),
  expenses: document.querySelector("#expenses"),
  drafts: document.querySelector("#drafts"),
  planned: document.querySelector("#planned"),
  refresh: document.querySelector("#refresh")
};

for (const message of quickMessages) {
  const button = document.createElement("button");
  button.type = "button";
  button.textContent = message;
  button.addEventListener("click", () => sendMessage(message));
  els.quick.append(button);
}

els.form.addEventListener("submit", (event) => {
  event.preventDefault();
  const text = els.input.value.trim();
  if (text) sendMessage(text);
});
els.refresh.addEventListener("click", refreshState);

await refreshState();

async function sendMessage(text) {
  els.input.value = text;
  const response = await fetch("/dev/telegram/update", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ type: "message", telegramUserId: DEMO_USER_ID, text })
  });
  renderTelegramResult(await response.json());
}

async function sendCallback(data) {
  const response = await fetch("/dev/telegram/update", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ type: "callback", telegramUserId: DEMO_USER_ID, callbackData: data })
  });
  renderTelegramResult(await response.json());
}

async function refreshState() {
  const response = await fetch(`/dev/state?telegramUserId=${DEMO_USER_ID}`);
  const state = await response.json();
  renderState(state);
}

function renderTelegramResult(result) {
  const message = result.messages?.at(-1);
  const callback = result.callbackAnswers?.at(-1);
  els.botText.textContent = [
    callback ? `Callback: ${callback.text}` : "",
    message?.text ?? "No bot message returned."
  ].filter(Boolean).join("\n\n");
  renderKeyboard(message?.replyMarkup);
  renderState(result.state);
}

function renderState(state) {
  const snapshot = state.dashboard?.snapshot ?? {};
  const currency = snapshot.baseCurrency ?? state.dashboard?.user?.base_currency ?? "THB";
  els.today.textContent = money(snapshot.today, currency);
  els.month.textContent = money(snapshot.month, currency);
  els.budget.textContent = money(snapshot.monthlyBudget, currency);
  els.free.textContent = money(snapshot.freeRemaining, currency);
  els.expenses.replaceChildren(...state.recentExpenses.map((expense) => row(
    expense.description,
    `${money(expense.amount_base, currency)} ${expense.budget_impact ?? "regular"}`
  )));
  els.drafts.replaceChildren(...state.drafts.map((draft) => row(
    `#${draft.id} ${draft.status}`,
    `${draft.items.length} item(s) from "${draft.source_text}"`
  )));
  els.planned.replaceChildren(...state.plannedExpenses.map((planned) => row(
    planned.description,
    `${money(planned.amount_base, currency)} ${planned.recurrence}`
  )));
}

function renderKeyboard(replyMarkup) {
  els.keyboard.replaceChildren();
  const rows = replyMarkup?.inline_keyboard ?? [];
  for (const buttons of rows) {
    const rowEl = document.createElement("div");
    rowEl.className = "keyboard-row";
    for (const button of buttons) {
      const buttonEl = document.createElement(button.callback_data ? "button" : "a");
      buttonEl.textContent = button.text;
      if (button.callback_data) {
        buttonEl.type = "button";
        buttonEl.addEventListener("click", () => sendCallback(button.callback_data));
      } else {
        buttonEl.href = button.web_app?.url ?? button.url ?? "#";
      }
      rowEl.append(buttonEl);
    }
    els.keyboard.append(rowEl);
  }
}

function row(title, meta) {
  const el = document.createElement("div");
  el.className = "list-row";
  const titleEl = document.createElement("strong");
  titleEl.textContent = title;
  const metaEl = document.createElement("span");
  metaEl.textContent = meta;
  el.append(titleEl, metaEl);
  return el;
}

function money(value, currency) {
  return formatMoney(value, currency);
}
