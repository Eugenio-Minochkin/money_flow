import { deflateSync } from "node:zlib";
import { CATEGORIES, categoryLabel } from "../../../packages/shared/src/categories.js";
import { categoryIconSvg } from "../../miniapp/src/categoryIcons.js";
import { formatMoney } from "./telegramFormat.js";

const icon = (path) => `<svg viewBox="0 0 16 16" aria-hidden="true"><path d="${path}"/></svg>`;
const chevron = icon("m4 6 4 4 4-4");
const budgetRow = (id, title, path, details = "") => `<div id="${id}" class="row">${icon(path)}<div class="metrics">
<div class="line"><strong>${title}</strong><span><b></b><small></small></span></div>
<div id="${id}-track" class="track"><div id="${id}-fill" class="fill"></div>${id === "month" ? '<div id="marker" hidden></div>' : ""}</div>
<div class="line"><span class="note"><span></span> <strong class="rest"></strong></span><strong class="pill percent"></strong></div>
${details}</div></div>`;

// Palette from the Money Flow Mini App. Telegram resolves light-dark() using the chat theme.
function widgetTemplate(language) {
  const en = language === "en";
  const tr = (ru, english) => en ? english : ru;
  const choices = CATEGORIES.map(({ slug }) => `<button data-slug="${slug}">${categoryIconSvg(slug).replace('focusable="false"', 'aria-hidden="true"')}<span>${categoryLabel(slug, language)}</span></button>`).join("");
  return `<style>
body{
  --bg:light-dark(#f8f6f1,#0a0f0f);
  --ink:light-dark(#1d2530,#f5f2ea);
  --hint:light-dark(#575149,#aebfba);
  --green:light-dark(#426d4e,#92bd9b);
  --soft:light-dark(#eef1e7,#14201a);
  --mint:light-dark(#dcecd3,#233c2e);
  font:13px/1.3 system-ui;color:var(--ink);background:var(--bg);margin:0;padding:0
}
#receipt{padding:9px 11px max(7px,env(safe-area-inset-bottom))}
[hidden],#status:empty{display:none!important}
button{font:inherit;color:inherit;border:0;background:none;padding:0}p{margin:0}
#budget,#actions{margin-top:8px}
.pill{border-radius:9px;padding:2px 7px;color:var(--green);background:var(--mint);font-weight:700}
.badge{display:inline-block;font-size:11px}
.expense-line,.line{display:flex;gap:2px 5px}
.expense-line{align-items:center;font-size:20px;font-weight:700}
#name{flex:1;min-width:0;text-align:left;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
#amount{flex:none;max-width:70%;overflow-wrap:anywhere;color:var(--ink)}.pen{font-size:11px;color:var(--green)}
svg{flex:none;width:16px;height:16px;fill:none;stroke:var(--green);stroke-width:1.7;stroke-linecap:round;stroke-linejoin:round}
#category,#choices button,#forecast-toggle,#selected{display:flex;align-items:center;gap:7px}
#category,#choices button,#forecast-toggle{width:100%;text-align:left}
#category,#choices{border:1px solid var(--mint);border-radius:9px;background:var(--soft)}
#category,#choices button{padding:5px 9px;min-height:32px}
#category-title,.note,#status,small{color:var(--hint)}
#selected,#forecast-value{margin-left:auto}
#selected{min-width:0;overflow-wrap:anywhere}
[aria-expanded="true"]>svg:last-child{transform:rotate(180deg)}
#choices{overflow:hidden}
#choices button+button{border-top:1px solid var(--soft)}
[aria-pressed="true"]::after{content:'✓';margin-left:auto;color:var(--green)}
.row,#forecast{background:var(--soft);border-radius:10px;margin-top:5px}
.row{display:flex;gap:8px;padding:6px 8px}.metrics{flex:1;min-width:0}
.line{flex-wrap:wrap;justify-content:space-between;align-items:baseline;font-variant-numeric:tabular-nums}
small,.note{font-size:12px}.note{flex:1;min-width:0}
.track,[aria-pressed="true"]{background:var(--mint)}
.track,.fill{height:6px;border-radius:9px}.track{margin:4px 0 2px;position:relative}
.fill{background:var(--green)}.over .fill{background:currentColor}
.rest{color:var(--green)}.percent{flex:none;font-size:11px}
.over .fill,.over .rest,.over .percent,#actions .remove{color:light-dark(#b13b46,#ff737f)}
#marker{position:absolute;width:2px;height:9px;top:-2px;border-radius:2px;background:light-dark(#b26b16,#d3b574)}
#forecast-toggle{padding:5px 8px;min-height:32px;font-weight:700}
#forecast-value{white-space:nowrap}#forecast-note{padding:0 8px 6px 29px}
#actions{text-align:center}#status,#category{margin-top:5px}
#actions button{border-radius:16px;padding:6px 10px;background:var(--soft)}
#actions .remove{background:light-dark(#fbe9e5,#321f22)}
@media(max-width:240px){#category-title,#forecast-toggle>svg:first-child{display:none}}
</style>
<main id="receipt" data-source="__SOURCE__">
<div id="active">
<div id="heading">
<span class="badge pill">${tr("✓ Записал", "✓ Saved")}</span>
<div class="expense-line">
<button id="name" aria-label="${tr("Исправить название", "Edit description")}"><span id="description"></span> <span class="pen">✎</span></button>
<button id="amount" class="pill" aria-label="${tr("Исправить сумму", "Edit amount")}"><span class="pen" aria-hidden="true">✎</span> <span id="price"></span></button>
</div>
</div>
<p id="status" role="status"></p>
<button id="category" aria-expanded="false" aria-controls="choices"><span id="category-title">${tr("Категория", "Category")}</span><strong id="selected"></strong>${chevron}</button>
<div id="choices" hidden>${choices}</div>
<section id="budget">
${budgetRow("day", tr("Сегодня · обычные", "Today · regular"), "M3 4h10v10H3zM3 7h10M5 2v3m6-3v3", '<p id="extras" class="note"></p>')}
${budgetRow("month", tr("Месяц", "Month"), "M3 13v-3m3 3V8m3 5V5m3 8V2")}
<div id="forecast"><button id="forecast-toggle" aria-expanded="false" aria-controls="forecast-note">${icon("m2 12 4-4 3 2 5-6m-4 0h4v4")}<span>${tr("Прогноз на месяц", "Month-end forecast")}</span><strong id="forecast-value" class="pill"></strong>${chevron}</button><p id="forecast-note" class="note" hidden></p></div>
<div id="actions"><button id="delete" class="remove">${tr("🗑 Удалить трату", "🗑 Delete expense")}</button><div id="confirm" hidden><p>${tr("Удалить эту трату?", "Delete this expense?")}</p><button id="keep">${tr("Оставить", "Keep")}</button><button id="remove" class="remove">${tr("Удалить", "Delete")}</button></div></div>
</section>
</div>
<p id="deleted" hidden>${tr("🗑 Запись удалена.", "🗑 Entry deleted.")}</p>
</main>
<script>
const bridge=window.TelegramWidget;
const el=id=>document.getElementById(id), set=(id,value)=>el(id).textContent=value;
const choices=Array.from(document.querySelectorAll('#choices button'));
let data, busy=false;
function pick(open){
  el('choices').hidden=!open;el('budget').hidden=el('heading').hidden=open;
  el('category').setAttribute('aria-expanded',String(open));
}
function confirm(open){el('confirm').hidden=!open;el('delete').hidden=open}
function row(id, values){
  const section=el(id);
  const [spent,limit,note,rest,percent]=section.querySelectorAll('b,small,.note>span,.rest,.percent');
  const [actual,max]=values[0].split(' / ');
  spent.textContent=actual;limit.textContent=max?' / '+max:'';
  note.textContent=values[1].slice(0,values[3]).trim()+':';rest.textContent=values[1].slice(values[3]);
  el(id+'-track').hidden=percent.hidden=values[2]===null;
  percent.textContent=values[2]+'%';
  el(id+'-fill').style.width=Math.min(100,Math.max(0,values[2]))+'%';
  section.classList.toggle('over',values[2]>100||!!values[4]);
}
function showDeleted(){el('active').hidden=true;el('deleted').hidden=false}
function draw(){
  try{data=JSON.parse(bridge.chatData)}catch{return}
  if(!data)return;
  if(data.deleted){showDeleted();return}
  set('description',data.name);set('price',data.amount);
  const selected=choices.find(button=>button.dataset.slug===data.category)||choices[choices.length-1];
  el('selected').innerHTML=selected.innerHTML;
  for(const button of choices)button.setAttribute('aria-pressed',String(button===selected));
  row('day',data.day);row('month',data.month);set('extras',data.extras||'');
  el('forecast').hidden=el('marker').hidden=!data.forecast;
  if(data.forecast){
    el('marker').style.left=Math.min(99,Math.max(0,data.marker))+'%';
    set('forecast-value',data.forecast[0]);set('forecast-note',data.forecast[1]);
  }
}
function ask(action,done){
  if(busy)return;busy=true;set('status','…');
  const fail=()=>set('status',"${tr("Попробуй ещё раз", "Try again")}");
  bridge.request('sw:'+data.id+':'+action).then(answer=>{
    if(answer.result==='deleted'){showDeleted();return}
    if(answer.result!=='ok'){fail();return}
    set('status','');if(done)done();
  },fail).finally(()=>{busy=false});
}
el('category').onclick=()=>{confirm(false);pick(el('choices').hidden)};
for(const button of choices)button.onclick=()=>ask('cat:'+button.dataset.slug,()=>pick(false));
el('forecast-toggle').onclick=()=>{
  const open=el('forecast-note').hidden;
  el('forecast-note').hidden=!open;el('forecast-toggle').setAttribute('aria-expanded',String(open));
};
el('name').onclick=()=>ask('name');
el('amount').onclick=()=>ask('amount');
el('delete').onclick=()=>confirm(true);
el('keep').onclick=()=>confirm(false);
el('remove').onclick=()=>ask('del:'+el('receipt').dataset.source);
bridge.onEvent('chatDataChanged',()=>{set('status','');draw()});draw();bridge.ready();
</script>`;
}

const templates = { ru: widgetTemplate("ru"), en: widgetTemplate("en") };

export function savedExpenseWidgetData({ expense, snapshot, language }) {
  if (!Number.isSafeInteger(Number(expense?.id)) || Number(expense.id) <= 0 || !snapshot) return null;
  const en = language === "en";
  const tr = (ru, english) => en ? english : ru;
  const currency = snapshot.baseCurrency ?? expense.currency_original ?? "THB";
  const money = (value, code = currency) => formatMoney(value, code, language);
  const figures = (spent, limit) => `${money(spent)} / ${money(limit)}`;
  const progress = (percent, limit) => Number.isFinite(percent) && limit > 0 ? Math.round(percent) : null;
  // Keep the combined note in slot 1 for widgets sent before the split layout.
  const row = (spent, limit, percent, label, amount, over = false) => [
    figures(spent, limit), label + " " + money(amount), progress(percent, limit), label.length + 1, over
  ];
  const forecast = snapshot.forecastMonthTotal;
  const hasForecast = Number.isFinite(forecast) && snapshot.monthlyBudget > 0;
  const difference = hasForecast ? Math.round((forecast - snapshot.monthlyBudget) * 100) / 100 : 0;
  const extras = [];
  const planned = snapshot.plannedToday ?? snapshot.plannedTodayTotal;
  const large = snapshot.largeToday ?? snapshot.largeTodayTotal;
  if (Number(planned) > 0) extras.push(tr("Плановые ", "Planned ") + money(planned));
  if (Number(large) > 0) extras.push(tr("Крупные ", "Large ") + money(large));
  const chatData = JSON.stringify({
    id: Number(expense.id),
    en,
    name: Array.from(expense.description || tr("Трата", "Expense")).slice(0, 90).join(""),
    amount: money(expense.amount_original ?? expense.amount_base, expense.currency_original ?? currency),
    category: expense.category_slug,
    day: Number(snapshot.dayOverrun) > 0
      ? row(snapshot.today, snapshot.dayPlanLimit, snapshot.dayProgressPercent, tr("Сверх лимита", "Over by"), snapshot.dayOverrun, true)
      : row(snapshot.today, snapshot.dayPlanLimit, snapshot.dayProgressPercent, tr("Осталось", "Left"), snapshot.dayRemaining),
    month: row(snapshot.month, snapshot.monthlyBudget, snapshot.budgetProgressPercent,
      tr("Свободно после плановых", "Free after planned"), snapshot.freeRemaining),
    extras: extras.join(" · "),
    marker: hasForecast ? forecast / snapshot.monthlyBudget * 100 : null,
    forecast: hasForecast ? [money(forecast), difference === 0 ? tr("Ровно по бюджету", "On budget")
      : money(Math.abs(difference)) + (difference > 0 ? tr(" выше бюджета", " above budget") : tr(" ниже бюджета", " below budget"))] : null
  });
  return Buffer.byteLength(chatData) <= 1024 ? chatData : null;
}

export function buildSavedExpenseWidget(receipt, sourceMessageId) {
  const chatData = savedExpenseWidgetData(receipt);
  if (!chatData) return null;
  const source = Number.isSafeInteger(Number(sourceMessageId)) && Number(sourceMessageId) > 0 ? Number(sourceMessageId) : 0;
  const html = templates[receipt.language === "en" ? "en" : "ru"].replace("__SOURCE__", String(source));
  if (Buffer.byteLength(html) > 32768 || deflateSync(html, { level: 9 }).length > 4096) return null;
  return { html, chatData, width: 344 };
}
