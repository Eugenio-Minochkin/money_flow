import { deflateSync } from "node:zlib";
import { CATEGORIES, categoryLabel } from "../../../packages/shared/src/categories.js";
import { formatMoney } from "./telegramFormat.js";

const categories = CATEGORIES.map(({ slug }) => [slug, categoryLabel(slug, "ru"), categoryLabel(slug, "en")]);
const icon = (path, className = "icon") => `<svg class="${className}" viewBox="0 0 16 16" aria-hidden="true"><path d="${path}"/></svg>`;
const chevron = icon("m4 6 4 4 4-4", "chevron");
const budgetRow = (id, path, details) => `<div id="${id}" class="row">${icon(path)}<div class="metrics">
<div class="line"><strong id="${id}-title"></strong><span class="figures"><strong id="${id}-spent"></strong><span id="${id}-limit" class="limit"></span></span></div>
<div id="${id}-track" class="track"><div id="${id}-fill" class="fill"></div>${id === "month" ? '<div id="marker" hidden></div>' : ""}</div>
<div class="line"><span class="note"><span id="${id}-note"></span> <strong id="${id}-rest" class="rest"></strong></span><strong id="${id}-percent" class="pill percent"></strong></div>
${details}</div></div>`;

// Palette from the Money Flow Mini App. Telegram resolves light-dark() using the chat theme.
const template = `<style>
body{
  --bg:light-dark(#f8f6f1,#0a0f0f);
  --ink:light-dark(#1d2530,#f5f2ea);
  --hint:light-dark(#575149,#aebfba);
  --panel:light-dark(#fffefa,#111b1a);
  --line:light-dark(#e8e2da,#263938);
  --green:light-dark(#426d4e,#92bd9b);
  --soft:light-dark(#eef1e7,#14201a);
  --mint:light-dark(#dcecd3,#233c2e);
  --red:light-dark(#b13b46,#ff737f);
  --notice:light-dark(#fbe9e5,#321f22);
  font:13px/1.3 system-ui;color:var(--ink);background:var(--bg);margin:0;padding:0
}
#receipt{padding:9px 11px max(7px,env(safe-area-inset-bottom))}
[hidden],#status:empty{display:none!important}
button{font:inherit;color:inherit;border:0;background:none;padding:0}p{margin:0}
#heading{margin-bottom:7px}
.pill{border-radius:9px;padding:2px 7px;color:var(--green);background:var(--mint);font-weight:700}
.badge{display:inline-block;margin-bottom:3px;font-size:11px}
.expense-line{display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:4px 8px}
.field{max-width:100%;text-align:left;font-weight:700;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
#name{font-size:19px}#amount{display:flex;align-items:center;gap:6px;margin-left:auto;color:var(--ink);font-size:20px}
.pen{font-size:11px;color:var(--green)}
svg{flex:none;width:14px;height:14px;fill:none;stroke:var(--green);stroke-width:1.5;stroke-linecap:round;stroke-linejoin:round}
#category,.choice,#forecast-toggle{display:flex;box-sizing:border-box;width:100%;min-width:0;align-items:center;gap:7px;text-align:left}
#category{border:1px solid var(--line);border-radius:9px;background:var(--panel);min-height:34px;padding:5px 9px}
#category-title,.note,#status,.limit{color:var(--hint)}
#selected,#forecast-value{margin-left:auto;text-align:right;overflow-wrap:anywhere}
[aria-expanded="true"]>.chevron{transform:rotate(180deg)}
#choices{border:1px solid var(--line);border-radius:9px;overflow:hidden;background:var(--panel)}
.choice{justify-content:space-between;padding:5px 9px;min-height:30px;overflow-wrap:anywhere}
.choice+.choice{border-top:1px solid var(--line)}.choice[aria-pressed="true"]{color:var(--green)}
.choice[aria-pressed="true"]::after{content:'✓'}
#budget{margin-top:8px}.row,#forecast{background:var(--soft);border-radius:10px;margin-bottom:5px}
.row{display:flex;gap:8px;padding:6px 8px}.row>svg{margin-top:2px}.metrics{flex:1;min-width:0}
.line{display:flex;justify-content:space-between;align-items:baseline;gap:1px 5px;flex-wrap:wrap}
.figures{font-variant-numeric:tabular-nums;overflow-wrap:anywhere}.limit,.note{font-size:12px}
.track,.choice[aria-pressed="true"]{background:var(--mint)}
.track{height:6px;margin:4px 0 2px;border-radius:9px;position:relative}
.fill{height:100%;border-radius:9px;background:var(--green)}.over .fill{background:var(--red)}
.note{overflow-wrap:anywhere}.rest{color:var(--green)}.percent{font-size:11px;margin-left:auto}.over .rest,.over .percent{color:var(--red)}
#marker{position:absolute;width:2px;height:9px;top:-2px;border-radius:2px;background:light-dark(#b26b16,#d3b574)}
#forecast-toggle{padding:5px 8px;min-height:32px;font-weight:700}
#forecast-value{white-space:nowrap}#forecast-note{padding:0 8px 6px 29px}
#actions{text-align:center;margin-top:9px}#confirm p,#status{margin-bottom:4px}
.remove,#keep{border-radius:16px;padding:5px 10px;font-size:12px;min-height:28px}
.remove{font-weight:650;color:var(--red);background:var(--notice)}#keep{background:var(--panel)}
@media(max-width:240px){#category-title,#forecast-toggle>.icon{display:none}}
</style>
<main id="receipt" data-source="__SOURCE__">
<div id="active">
<div id="heading">
<span id="badge" class="badge pill"></span>
<div class="expense-line">
<button id="name" class="field"><span id="description"></span> <span class="pen">✎</span></button>
<button id="amount" class="field pill"><span class="pen" aria-hidden="true">✎</span><span id="price"></span></button>
</div>
</div>
<p id="status" role="status"></p>
<button id="category" aria-expanded="false" aria-controls="choices"><span class="pen" aria-hidden="true">▦</span><span id="category-title"></span><strong id="selected"></strong>${chevron}</button>
<div id="choices" hidden></div>
<section id="budget">
${budgetRow("day", "M3 4h10v10H3zM3 7h10M5 2v3m6-3v3", '<p id="extras" class="note"></p>')}
${budgetRow("month", "M3 13v-3m3 3V8m3 5V5m3 8V2", "")}
<div id="forecast"><button id="forecast-toggle" aria-expanded="false" aria-controls="forecast-note">${icon("m2 12 4-4 3 2 5-6m-4 0h4v4")}<span id="forecast-title"></span><strong id="forecast-value" class="figures pill"></strong>${chevron}</button><p id="forecast-note" class="note" hidden></p></div>
<div id="actions"><button id="delete" class="remove"></button><div id="confirm" hidden><p id="question"></p><button id="keep"></button><button id="remove" class="remove"></button></div></div>
</section>
</div>
<p id="deleted" hidden></p>
</main>
<script>
const bridge=window.TelegramWidget, labels=${JSON.stringify(categories)};
const el=id=>document.getElementById(id), set=(id,value)=>el(id).textContent=value;
let data, busy=false, choosing=false, confirming=false;
const tr=(ru,en)=>data.en?en:ru;
function panels(){
  el('choices').hidden=!choosing;el('budget').hidden=el('heading').hidden=choosing;
  el('category').setAttribute('aria-expanded',String(choosing));
  el('confirm').hidden=!confirming;el('delete').hidden=confirming;
}
function row(id, values){
  const [spent,limit]=values[0].split(' / ');
  set(id+'-spent',spent);set(id+'-limit',limit?' / '+limit:'');
  set(id+'-note',values[1].slice(0,values[3]).trim()+':');
  set(id+'-rest',values[1].slice(values[3]));
  el(id+'-track').hidden=el(id+'-percent').hidden=values[2]===null;
  set(id+'-percent',values[2]+'%');
  el(id+'-fill').style.width=Math.min(100,Math.max(0,values[2]))+'%';
  el(id).classList.toggle('over',values[2]>100||!!values[4]);
}
function showDeleted(){
  el('active').hidden=true;el('deleted').hidden=false;
  set('deleted',tr('🗑 Запись удалена.','🗑 Entry deleted.'));
}
function draw(){
  try{data=JSON.parse(bridge.chatData)}catch{return}
  if(!data)return;
  if(data.deleted){showDeleted();return}
  set('badge',tr('✓ Записал','✓ Saved'));set('description',data.name);set('price',data.amount);
  el('name').setAttribute('aria-label',tr('Исправить название','Edit description'));
  el('amount').setAttribute('aria-label',tr('Исправить сумму','Edit amount'));
  set('category-title',tr('Категория','Category'));const index=data.en?2:1;
  set('selected',(labels.find(item=>item[0]===data.category)||labels[labels.length-1])[index]);
  el('choices').innerHTML='';
  for(const item of labels){
    const button=document.createElement('button');button.className='choice';
    button.textContent=item[index];
    button.setAttribute('aria-pressed',String(data.category===item[0]));
    button.onclick=()=>ask('cat:'+item[0],()=>{choosing=false;panels()});
    el('choices').appendChild(button);
  }
  set('day-title',tr('Сегодня · обычные','Today · regular'));set('month-title',tr('Месяц','Month'));
  row('day',data.day);row('month',data.month);set('extras',data.extras||'');
  el('forecast').hidden=!data.forecast;el('marker').hidden=data.marker===null;
  if(data.marker!==null)el('marker').style.left=Math.min(99,Math.max(0,data.marker))+'%';
  if(data.forecast){set('forecast-title',tr('Прогноз на месяц','Month-end forecast'));set('forecast-value',data.forecast[0]);set('forecast-note',data.forecast[1]);}
  set('delete',tr('🗑 Удалить трату','🗑 Delete expense'));set('question',tr('Удалить эту трату?','Delete this expense?'));
  set('keep',tr('Оставить','Keep'));set('remove',tr('Удалить','Delete'));panels();
}
function ask(action,done){
  if(busy)return;busy=true;set('status',tr('Минутку…','One moment…'));
  const fail=()=>set('status',tr('Не получилось. Попробуй ещё раз.','Could not complete the action. Try again.'));
  bridge.request('sw:'+data.id+':'+action).then(answer=>{
    if(answer.result==='deleted'){showDeleted();return}
    if(answer.result!=='ok'){fail();return}
    set('status','');if(done)done();
  },fail).finally(()=>{busy=false});
}
el('category').onclick=()=>{choosing=!choosing;confirming=false;panels()};
el('forecast-toggle').onclick=()=>{
  const open=el('forecast-note').hidden;
  el('forecast-note').hidden=!open;el('forecast-toggle').setAttribute('aria-expanded',String(open));
};
el('name').onclick=()=>ask('name');
el('amount').onclick=()=>ask('amount');
el('delete').onclick=()=>{confirming=true;panels()};
el('keep').onclick=()=>{confirming=false;panels()};
el('remove').onclick=()=>ask('del:'+el('receipt').dataset.source);
bridge.onEvent('chatDataChanged',()=>{set('status','');draw()});draw();bridge.ready();
</script>`;

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
  const html = template.replace("__SOURCE__", String(source));
  if (Buffer.byteLength(html) > 32768 || deflateSync(html, { level: 9 }).length > 4096) return null;
  return { html, chatData, width: 344 };
}
