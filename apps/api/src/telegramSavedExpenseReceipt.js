import { crc32, deflateSync } from "node:zlib";
import { categoryLabel } from "../../../packages/shared/src/categories.js";
import { expenseCategoryKeyboard } from "./telegramExpenseEditor.js";
import { formatMoney } from "./telegramFormat.js";

const WIDTH = 300;
const HEIGHT = 16;
const BAR_HEIGHT = 8;
const TRACK_COLOR = [220, 232, 222];
const DAY_COLOR = [66, 109, 78];
const MONTH_COLOR = [82, 119, 93];
const FORECAST_COLOR = [196, 160, 91];
const OVER_BUDGET_COLOR = [190, 62, 64];

export function buildSavedExpenseReceipt({ expense, snapshot, language, confirmDelete = false }) {
  if (!Number.isSafeInteger(Number(expense?.id)) || Number(expense.id) <= 0 || !snapshot) return null;
  const en = language === "en";
  const currency = snapshot.baseCurrency ?? expense.currency_original ?? "THB";
  const money = (value, code = currency) => formatMoney(value, code, language);
  const category = categoryLabel(expense.category_slug, language);
  const { inline_keyboard: categoryRows } = expenseCategoryKeyboard(
    { type: "expense", id: expense.id, expense },
    undefined,
    { language, quickCategory: true }
  );
  const categoryChoices = categoryRows.slice(0, -1).map(([choice]) => paragraph({
    type: "button",
    button: { ...choice, style: "link" }
  }));
  const key = `ee:x:${expense.id}`;
  const editValue = (label, field) => paragraph({
    type: "button",
    button: { text: `${label} ✎`, callback_data: `${key}:f:${field}`, style: "link" }
  });
  const blocks = [
    paragraph(bold(en ? "✅ Saved" : "✅ Записал")),
    editValue(expense.description || (en ? "Add a description" : "Добавить название"), "d"),
    editValue(money(expense.amount_original ?? expense.amount_base, expense.currency_original ?? currency), "a"),
    { type: "details", summary: [en ? "Category  ·  " : "Категория  ·  ", bold(category)], blocks: categoryChoices }
  ];
  const attachments = [];
  const appendProgress = (name, percent, limit, color, forecastPercent) => {
    if (!(limit > 0) || !Number.isFinite(percent)) return;
    blocks.push({ type: "photo", photo: { type: "photo", media: "attach://" + name } });
    attachments.push({ name, data: progressImage(percent, percent > 100 ? OVER_BUDGET_COLOR : color, forecastPercent) });
  };

  blocks.push(paragraph([bold(en ? "Today · regular" : "Сегодня · обычные"), "  ", money(snapshot.today), " / ", money(snapshot.dayPlanLimit)]));
  appendProgress("today_progress", snapshot.dayProgressPercent, snapshot.dayPlanLimit, DAY_COLOR);
  blocks.push(paragraph(Number(snapshot.dayOverrun) > 0
    ? [en ? "Over the daily limit  " : "Сверх лимита на сегодня  ", bold(money(snapshot.dayOverrun))]
    : [en ? "Left today  " : "Осталось на сегодня  ", bold(money(snapshot.dayRemaining))]));
  const plannedToday = snapshot.plannedToday ?? snapshot.plannedTodayTotal;
  const largeToday = snapshot.largeToday ?? snapshot.largeTodayTotal;
  if (Number(plannedToday) > 0) blocks.push(paragraph([en ? "Planned today  " : "Плановые сегодня  ", money(plannedToday)]));
  if (Number(largeToday) > 0) blocks.push(paragraph([en ? "Large expenses today  " : "Крупные сегодня  ", money(largeToday)]));
  if (Number(plannedToday) > 0 || Number(largeToday) > 0) {
    const totalToday = Number(snapshot.today ?? 0) + Number(plannedToday ?? 0) + Number(largeToday ?? 0);
    blocks.push(paragraph([en ? "Total today  " : "Всего за день  ", bold(money(totalToday))]));
  }

  blocks.push(paragraph([bold(en ? "Month" : "Месяц"), "  ", money(snapshot.month), " / ", money(snapshot.monthlyBudget)]));
  const forecast = snapshot.forecastMonthTotal;
  const hasForecast = Number.isFinite(forecast) && snapshot.monthlyBudget > 0;
  appendProgress("month_progress", snapshot.budgetProgressPercent, snapshot.monthlyBudget, MONTH_COLOR,
    hasForecast ? forecast / snapshot.monthlyBudget * 100 : undefined);
  blocks.push(paragraph([en ? "Free after planned payments  " : "Свободно после плановых  ", bold(money(snapshot.freeRemaining))]));
  if (Number(snapshot.plannedRemaining) > 0) {
    blocks.push(paragraph([en ? "Reserved for planned payments  " : "В резерве на плановые  ", money(snapshot.plannedRemaining)]));
  }
  if (hasForecast) {
    const difference = Math.round((forecast - snapshot.monthlyBudget) * 100) / 100;
    const comparison = difference === 0 ? (en ? "On budget" : "Ровно по бюджету")
      : `${money(Math.abs(difference))} ${difference > 0 ? (en ? "above budget" : "выше бюджета") : (en ? "below budget" : "ниже бюджета")}`;
    blocks.push({
      type: "details",
      summary: [en ? "Month-end forecast  ·  " : "Прогноз на конец месяца  ·  ", bold(money(forecast))],
      is_open: true,
      blocks: [paragraph(comparison), paragraph(en
        ? "At the current pace, including planned payments"
        : "При текущем темпе, с учётом плановых платежей")]
    });
  }
  if (confirmDelete) blocks.push({
    type: "pullquote",
    text: [
      bold(en ? "Delete this expense?" : "Удалить эту трату?"),
      en ? "\nIt will no longer count toward the budget." : "\nТрата перестанет учитываться в бюджете."
    ]
  });
  blocks.push({
    type: "buttons",
    align: "center",
    buttons: confirmDelete ? [
      { text: en ? "Keep" : "Оставить", callback_data: `${key}:r:back` },
      { text: en ? "Delete" : "Удалить", callback_data: `${key}:r:delok`, style: "danger" }
    ] : [{ text: en ? "🗑 Delete expense" : "🗑 Удалить трату", callback_data: `${key}:r:del`, style: "danger" }]
  });
  return { richMessage: { blocks, skip_entity_detection: true }, attachments };
}

function paragraph(text) {
  return { type: "paragraph", text };
}

function bold(text) {
  return { type: "bold", text };
}

function progressImage(percent, color, forecastPercent) {
  const fillWidth = Math.round(WIDTH * Math.min(100, Math.max(0, percent)) / 100);
  const marker = Number.isFinite(forecastPercent)
    ? Math.max(0, Math.min(WIDTH - 3, Math.round(WIDTH * forecastPercent / 100) - 1))
    : -1;
  const rowSize = 1 + WIDTH * 4;
  const pixels = Buffer.alloc(rowSize * HEIGHT);
  for (let y = 0; y < HEIGHT; y += 1) {
    for (let x = 0; x < WIDTH; x += 1) {
      const onMarker = marker >= 0 && x >= marker && x < marker + 3 && y >= 2 && y < HEIGHT - 2;
      if (!onMarker && !insideBar(x, y, WIDTH)) continue;
      const pixel = y * rowSize + 1 + x * 4;
      pixels.set(onMarker ? FORECAST_COLOR : insideBar(x, y, fillWidth) ? color : TRACK_COLOR, pixel);
      pixels[pixel + 3] = 255;
    }
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(WIDTH, 0);
  header.writeUInt32BE(HEIGHT, 4);
  header.set([8, 6], 8);
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    pngChunk("IHDR", header),
    pngChunk("IDAT", deflateSync(pixels)),
    pngChunk("IEND", Buffer.alloc(0))
  ]);
}

function insideBar(x, y, width) {
  if (x >= width || width === 0) return false;
  const radius = Math.min(BAR_HEIGHT / 2, width / 2);
  const dx = Math.max(radius - (x + 0.5), x + 0.5 - (width - radius), 0);
  const dy = Math.abs(y + 0.5 - HEIGHT / 2);
  return dy < BAR_HEIGHT / 2 && dx * dx + Math.max(dy - (BAR_HEIGHT / 2 - radius), 0) ** 2 <= radius * radius;
}

function pngChunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const contents = Buffer.concat([Buffer.from(type), data]);
  const checksum = Buffer.alloc(4);
  checksum.writeUInt32BE(crc32(contents));
  return Buffer.concat([length, contents, checksum]);
}
