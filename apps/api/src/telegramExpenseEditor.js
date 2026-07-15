import { CATEGORIES, categoryName } from "../../../packages/shared/src/categories.js";
import { SUPPORTED_CURRENCY_CODES } from "../../../packages/shared/src/currencies.js";

const FIELD_CODES = { a: "amount", d: "description", s: "spent_at", g: "tags" };
const FIELD_TO_CODE = Object.fromEntries(Object.entries(FIELD_CODES).map(([code, field]) => [field, code]));

const EN_CATEGORY_NAMES = {
  food_cafe: "Food and cafes", groceries: "Groceries", home: "Home", transport: "Transport",
  health: "Health", sport_activities: "Sport and activities", gear: "Gear", travel: "Travel",
  subscriptions: "Subscriptions", education: "Education", gifts_help: "Gifts and help",
  entertainment: "Entertainment", other: "Other"
};

export function editorTargetKey(target) {
  if (target?.type === "draft" && Number.isSafeInteger(Number(target.id)) && Number.isInteger(Number(target.itemIndex))) {
    return `d:${Number(target.id)}:${Number(target.itemIndex)}`;
  }
  if (target?.type === "expense" && Number.isSafeInteger(Number(target.id))) return `x:${Number(target.id)}`;
  throw new Error("invalid_editor_target");
}

export function parseExpenseEditorCallback(data) {
  const parts = String(data ?? "").split(":");
  if (parts[0] !== "ee") return null;

  if (parts.length === 4 && parts[1] === "d" && isPositiveId(parts[2]) && parts[3] === "m") {
    return { type: "draft", id: Number(parts[2]), action: "multi_item_selector" };
  }

  let offset;
  let target;
  if (parts[1] === "d" && isPositiveId(parts[2]) && isNonNegativeIndex(parts[3])) {
    target = { type: "draft", id: Number(parts[2]), itemIndex: Number(parts[3]) };
    offset = 4;
  } else if (parts[1] === "x" && isPositiveId(parts[2])) {
    target = { type: "expense", id: Number(parts[2]) };
    offset = 3;
  } else {
    return null;
  }

  const action = parts[offset];
  const value = parts[offset + 1];
  if (parts.length === offset + 1 && action === "o") return { ...target, action: "open" };
  if (parts.length === offset + 2 && action === "f" && FIELD_CODES[value]) return { ...target, action: "field", field: FIELD_CODES[value] };
  if (parts.length === offset + 2 && action === "b" && (value === "r" || value === "l")) {
    return { ...target, action: "budget_impact", value: value === "r" ? "regular" : "large_oneoff" };
  }
  if (parts.length === offset + 2 && action === "dt" && ["t", "y", "c"].includes(value)) {
    return { ...target, action: "date", value: ({ t: "today", y: "yesterday", c: "custom" })[value] };
  }
  if (parts.length === offset + 2 && action === "cat" && /^[a-z_]{1,32}$/u.test(value)) return { ...target, action: "category", value };
  if (parts.length === offset + 2 && action === "p" && /^\d+$/u.test(value) && Number.isSafeInteger(Number(value))) {
    return { ...target, action: "category_page", page: Number(value) };
  }
  if (parts.length === offset + 1 && action === "cm") return { ...target, action: "category_menu" };
  if (parts.length === offset + 1 && action === "bm") return { ...target, action: "budget_menu" };
  if (parts.length === offset + 1 && action === "del") return { ...target, action: "delete" };
  if (parts.length === offset + 1 && action === "delok") return { ...target, action: "delete_confirm" };
  if (parts.length === offset + 1 && action === "back") return { ...target, action: "back" };
  return null;
}

export function treatmentLabels(impact = "regular", language = "ru") {
  const en = language === "en";
  const regular = impact !== "large_oneoff";
  return [
    `${regular ? "◉" : "○"} ${en ? "Count today" : "Учесть сегодня"}`,
    `${regular ? "○" : "◉"} ${en ? "Spread across remaining days" : "Распределить до конца месяца"}`
  ];
}

export function formatExpenseEditor(target, { language = "ru", timeZone = "Asia/Bangkok" } = {}) {
  const item = itemFromTarget(target);
  const en = language === "en";
  const labels = treatmentLabels(item.budget_impact, language);
  const currency = String(item.currency_original ?? item.currency ?? "THB").toUpperCase();
  const amount = item.amount_original ?? item.amount ?? 0;
  const category = categoryLabel(item.category_slug, language);
  const date = item.spent_at
    ? new Intl.DateTimeFormat(en ? "en-US" : "ru-RU", {
      timeZone, day: "2-digit", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit"
    }).format(new Date(item.spent_at))
    : (en ? "Not set" : "Не указаны");
  const tags = Array.isArray(item.tags) && item.tags.length ? item.tags.map(escapeHtml).join(", ") : "—";
  return [
    `<b>${en ? "Edit expense" : "Изменить расход"}</b>`,
    `${en ? "Amount" : "Сумма"}: <b>${formatMoney(amount, currency, language)}</b>`,
    `${en ? "Description" : "Название"}: ${escapeHtml(item.description ?? "")}`,
    `${en ? "Category" : "Категория"}: ${escapeHtml(category)}`,
    `${en ? "Date and time" : "Дата и время"}: ${escapeHtml(date)}`,
    `${en ? "Tags" : "Теги"}: ${tags}`,
    "",
    `<b>${en ? "Budget impact" : "Как учесть расход?"}</b>`,
    labels.join("\n")
  ].join("\n");
}

export function expenseEditorKeyboard(target, { language = "ru" } = {}) {
  const key = editorTargetKey(target);
  const en = language === "en";
  return keyboard([
    [button(en ? "💰 Amount" : "💰 Сумма", `ee:${key}:f:${FIELD_TO_CODE.amount}`), button(en ? "✏️ Description" : "✏️ Название", `ee:${key}:f:${FIELD_TO_CODE.description}`)],
    [button(en ? "🏷 Category" : "🏷 Категория", `ee:${key}:cm`), button(en ? "🗓 Date and time" : "🗓 Дата и время", `ee:${key}:dt:c`)],
    [button(en ? "🏷 Tags" : "🏷 Теги", `ee:${key}:f:${FIELD_TO_CODE.tags}`), button(en ? "◉ Budget impact" : "◉ Учёт в бюджете", `ee:${key}:bm`)],
    [button(en ? "🗑 Delete" : "🗑 Удалить", `ee:${key}:del`)],
    [button(en ? "← Done" : "← Готово", `ee:${key}:back`)]
  ]);
}

export function expenseInputPrompt(field, { language = "ru" } = {}) {
  const ru = {
    amount: "Отправь новую сумму текстом, например: 120 или 15 USD.",
    description: "Отправь новое название расхода текстом.",
    spent_at: "Отправь дату и время текстом, например: 12 июля 19:30.",
    tags: "Отправь теги через запятую или «-», чтобы очистить их."
  };
  const en = {
    amount: "Send the new amount as text, for example: 120 or 15 USD.",
    description: "Send the new expense description as text.",
    spent_at: "Send the date and time as text, for example: Jul 12 19:30.",
    tags: "Send comma-separated tags or '-' to clear them."
  };
  return (language === "en" ? en : ru)[field] ?? (language === "en" ? "Send a value as text." : "Отправь значение текстом.");
}

export function expenseCategoryKeyboard(target, categories = CATEGORIES, { language = "ru", page = 0, pageSize = 6 } = {}) {
  const key = editorTargetKey(target);
  const current = itemFromTarget(target).category_slug;
  const safePage = Math.max(0, Math.min(Number(page) || 0, Math.max(0, Math.ceil(categories.length / pageSize) - 1)));
  const start = safePage * pageSize;
  const visible = categories.slice(start, start + pageSize);
  const rows = visible.map((category) => [button(
    `${category.slug === current ? "✅" : "⬜"} ${categoryLabel(category.slug, language)}`,
    `ee:${key}:cat:${category.slug}`
  )]);
  const navigation = [];
  if (safePage > 0) navigation.push(button(language === "en" ? "← Previous" : "← Назад", `ee:${key}:p:${safePage - 1}`));
  if (start + pageSize < categories.length) navigation.push(button(language === "en" ? "Next →" : "Далее →", `ee:${key}:p:${safePage + 1}`));
  if (navigation.length) rows.push(navigation);
  rows.push([button(language === "en" ? "← Back" : "← Назад", `ee:${key}:o`)]);
  return keyboard(rows);
}

export function expenseDateKeyboard(target, language = "ru") {
  const key = editorTargetKey(target);
  const en = language === "en";
  return keyboard([
    [button(en ? "Today" : "Сегодня", `ee:${key}:dt:t`), button(en ? "Yesterday" : "Вчера", `ee:${key}:dt:y`)],
    [button(en ? "✏️ Enter date and time" : "✏️ Ввести дату и время", `ee:${key}:dt:c`)],
    [button(en ? "← Back" : "← Назад", `ee:${key}:o`)]
  ]);
}

export function expenseTreatmentKeyboard(target, language = "ru") {
  const key = editorTargetKey(target);
  const labels = treatmentLabels(itemFromTarget(target).budget_impact, language);
  return keyboard([
    [button(labels[0], `ee:${key}:b:r`)],
    [button(labels[1], `ee:${key}:b:l`)],
    [button(language === "en" ? "← Back" : "← Назад", `ee:${key}:o`)]
  ]);
}

export function expenseDeleteKeyboard(target, language = "ru") {
  const key = editorTargetKey(target);
  const en = language === "en";
  return keyboard([
    [button(en ? "🗑 Yes, delete" : "🗑 Да, удалить", `ee:${key}:delok`)],
    [button(en ? "← Back" : "← Назад", `ee:${key}:o`)]
  ]);
}

export function editorMessageForCode(code, language = "ru") {
  const ru = {
    expense_future_date: "Указанное время ещё не наступило. Проверь дату и время.",
    expense_invalid_amount: "Укажи положительную сумму.",
    expense_invalid_currency: "Эта валюта не поддерживается.",
    expense_invalid_description: "Укажи непустое название расхода.",
    expense_invalid_tags: "Проверь теги и попробуй ещё раз.",
    expense_invalid_date: "Не получилось распознать дату и время. Проверь формат.",
    expense_not_found: "Расход больше недоступен. Открой последний расход через /last.",
    expense_source_month_closed: "Этот месяц уже закрыт. Можно исправить только название, категорию и теги.",
    expense_target_month_closed: "Целевой месяц уже закрыт. Выбери другую дату.",
    expense_delete_blocked: "Этот месяц уже закрыт. Удалить расход нельзя.",
    expense_edit_conflict: "Расход уже изменился. Открой его снова и повтори попытку.",
    session_expired: "Время редактирования истекло. Открой расход снова через /last."
  };
  const en = {
    expense_future_date: "The specified time has not happened yet. Check the date and time.",
    expense_invalid_amount: "Enter a positive amount.",
    expense_invalid_currency: "This currency is not supported.",
    expense_invalid_description: "Enter a non-empty expense description.",
    expense_invalid_tags: "Check the tags and try again.",
    expense_invalid_date: "I could not read that date and time. Check the format.",
    expense_not_found: "This expense is no longer available. Open your latest expense with /last.",
    expense_source_month_closed: "This month is already closed. You can only edit the description, category, and tags.",
    expense_target_month_closed: "The target month is already closed. Choose another date.",
    expense_delete_blocked: "This month is already closed. This expense cannot be deleted.",
    expense_edit_conflict: "This expense changed already. Open it again and retry.",
    session_expired: "Editing time expired. Open the expense again with /last."
  };
  return (language === "en" ? en : ru)[code] ?? (language === "en" ? "Could not update this expense." : "Не удалось изменить расход.");
}

export async function applyDraftEditorChange({
  repository,
  telegramUserId,
  target,
  field,
  value,
  expectedVersion,
  client,
  now = new Date()
} = {}) {
  if (!repository?.updateDraftItemForTelegramUser || target?.type !== "draft") {
    throw editorError("expense_not_found");
  }
  const draftId = Number(target.id);
  const itemIndex = Number(target.itemIndex);
  if (!Number.isSafeInteger(draftId) || draftId <= 0 || !Number.isInteger(itemIndex) || itemIndex < 0) {
    throw editorError("expense_not_found");
  }

  const patch = draftPatch(field, value, now);
  const options = {};
  if (expectedVersion != null) options.expectedVersion = expectedVersion;
  if (client) options.client = client;
  const updated = await repository.updateDraftItemForTelegramUser(draftId, itemIndex, telegramUserId, patch, options);
  return { target: updated, item: updated?.items?.[itemIndex] ?? null };
}

export async function applySavedExpenseEditorChange({
  repository,
  telegramUserId,
  target,
  field,
  value,
  client,
  now = new Date()
} = {}) {
  if (!repository?.updateExpenseForTelegramUser || target?.type !== "expense") throw editorError("expense_not_found");
  const expenseId = Number(target.id);
  if (!Number.isSafeInteger(expenseId) || expenseId <= 0) throw editorError("expense_not_found");
  const patch = draftPatch(field, value, now);
  const options = client ? { client } : undefined;
  const updated = await repository.updateExpenseForTelegramUser(expenseId, telegramUserId, patch, now, options);
  return { target: updated, item: updated };
}

function itemFromTarget(target) {
  return target?.item ?? target?.expense ?? target ?? {};
}

function categoryLabel(slug, language) {
  return language === "en" ? (EN_CATEGORY_NAMES[slug] ?? EN_CATEGORY_NAMES.other) : categoryName(slug);
}

function formatMoney(value, currency, language) {
  return `${new Intl.NumberFormat(language === "en" ? "en-US" : "ru-RU", {
    maximumFractionDigits: ["THB", "RUB", "IDR", "BYN"].includes(currency) ? 0 : 2,
    minimumFractionDigits: ["USD", "EUR", "GEL"].includes(currency) ? 2 : 0
  }).format(Number(value) || 0)} ${currency}`;
}

function escapeHtml(value) {
  return String(value ?? "").replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

function button(text, callback_data) {
  if (Buffer.byteLength(callback_data, "utf8") > 64) throw new Error("editor_callback_too_long");
  return { text, callback_data };
}

function keyboard(inline_keyboard) {
  return { inline_keyboard };
}

function isPositiveId(value) {
  return /^\d+$/u.test(String(value)) && Number(value) > 0 && Number.isSafeInteger(Number(value));
}

function isNonNegativeIndex(value) {
  return /^\d+$/u.test(String(value)) && Number.isSafeInteger(Number(value));
}

function draftPatch(field, value, now) {
  if (field === "amount") {
    const amount = Number(value?.amount);
    const currency = String(value?.currency ?? "").toUpperCase();
    if (!Number.isFinite(amount) || amount <= 0 || amount > 1_000_000) throw editorError("expense_invalid_amount");
    if (!SUPPORTED_CURRENCY_CODES.includes(currency)) throw editorError("expense_invalid_currency");
    return { amount, currency };
  }
  if (field === "description") {
    const description = String(value ?? "").trim();
    if (!description || description.length > 500) throw editorError("expense_invalid_description");
    return { description };
  }
  if (field === "tags") {
    if (!Array.isArray(value) || value.length > 20 || value.some((tag) => !String(tag).trim() || String(tag).length > 64)) {
      throw editorError("expense_invalid_tags");
    }
    return { tags: value.map((tag) => String(tag).trim()) };
  }
  if (field === "spent_at") {
    const spentAt = value instanceof Date ? value : new Date(value);
    if (Number.isNaN(spentAt.getTime())) throw editorError("expense_invalid_date");
    if (spentAt > new Date(now)) throw editorError("expense_future_date");
    return { spent_at: spentAt.toISOString() };
  }
  if (field === "category") {
    const category = String(value ?? "");
    if (!CATEGORIES.some((candidate) => candidate.slug === category)) throw editorError("expense_not_found");
    return { category_slug: category, category_source: "user", needs_review: false, confidence: 0.9 };
  }
  if (field === "budget_impact") {
    if (!["regular", "large_oneoff"].includes(value)) throw editorError("expense_not_found");
    return { budget_impact: value };
  }
  throw editorError("expense_not_found");
}

function editorError(code) {
  return Object.assign(new Error(code), { code });
}
