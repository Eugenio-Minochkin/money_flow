import { deflateSync } from "node:zlib";
import { CATEGORIES, categoryLabel } from "../../../packages/shared/src/categories.js";
import { formatMoney } from "./telegramFormat.js";

const categories = CATEGORIES.map(({ slug }) => [slug, categoryLabel(slug, "ru"), categoryLabel(slug, "en")]);
const template = `<style>
/* Palette from the Money Flow Mini App. Telegram resolves light-dark() using the chat theme. */
body{
  --bg:light-dark(#f8f6f1,#0a0f0f);
  --ink:light-dark(#1d2530,#f5f2ea);
  --hint:light-dark(#6f6a63,#95a6a3);
  --panel:light-dark(#fffefa,#111b1a);
  --line:light-dark(#e8e2da,#263938);
  --green:light-dark(#426d4e,#92bd9b);
  --fill:light-dark(#52775d,#92bd9b);
  --track:light-dark(#e8f0e8,#243a2c);
  --red:light-dark(#b13b46,#ff737f);
  --notice:light-dark(#fff0e8,#251c14);
  font:13px/1.3 system-ui;color:var(--ink);background:var(--bg);margin:0;padding:0
}
#receipt{padding:9px 11px max(7px,env(safe-area-inset-bottom))}
[hidden]{display:none!important}button{font:inherit;color:inherit}p{margin:0}
#heading{margin-bottom:7px}
.badge{display:block;margin-bottom:3px;font-size:11px;font-weight:650;color:var(--green)}
.expense-line{display:flex;justify-content:space-between;align-items:baseline;flex-wrap:wrap;gap:1px 9px}
.field{min-width:0;max-width:100%;padding:2px 0;border:0;background:transparent;text-align:left;font-weight:700;overflow-wrap:anywhere}
#name{font-size:16px}#amount{font-size:19px;line-height:1.2;font-variant-numeric:tabular-nums}
.pen{margin-left:4px;font-size:11px;color:var(--green)}
#category,.choice,#forecast-toggle{display:flex;box-sizing:border-box;width:100%;min-width:0;align-items:center;gap:7px;text-align:left}
#category{border:1px solid var(--line);border-radius:9px;background:var(--panel);min-height:34px;padding:5px 9px}
#category-title{color:var(--hint);font-size:12px}#selected{margin-left:auto;min-width:0;text-align:right;overflow-wrap:anywhere}
.chevron{flex:none;width:6px;height:6px;margin:0 2px 3px;border-right:1.5px solid var(--green);border-bottom:1.5px solid var(--green);transform:rotate(45deg)}
[aria-expanded="true"]>.chevron{margin-top:4px;transform:rotate(225deg)}
#category[aria-expanded="true"]{border-radius:9px 9px 0 0}
#choices{border:1px solid var(--line);border-top:0;border-radius:0 0 9px 9px;overflow:hidden;background:var(--panel)}
.choice{justify-content:space-between;border:0;border-bottom:1px solid var(--line);background:var(--panel);padding:5px 9px;min-height:30px;font-size:12px;overflow-wrap:anywhere}
.choice:last-child{border-bottom:0}.choice[aria-pressed="true"]{color:var(--green);background:var(--track);font-weight:650}
.tick{flex:none;color:var(--green);visibility:hidden}.choice[aria-pressed="true"] .tick{visibility:visible}
#budget{margin-top:8px}.row{margin-bottom:6px}.line{display:flex;justify-content:space-between;gap:2px 6px;flex-wrap:wrap}
.figures,.rest{font-variant-numeric:tabular-nums;overflow-wrap:anywhere}.figures{font-size:12px}.track{height:5px;margin:4px 0 3px;border-radius:9px;background:var(--track);position:relative}
.fill{height:100%;border-radius:9px;background:var(--fill)}.over .fill{background:var(--red)}
.note{font-size:12px;color:var(--hint)}.rest{color:var(--green);font-size:12px;font-weight:650}.over .rest{color:var(--red)}
#marker{position:absolute;width:2px;height:9px;top:-2px;border-radius:2px;background:light-dark(#b26b16,#d3b574)}
#forecast{border-top:1px solid var(--line)}
#forecast-toggle{border:0;background:transparent;padding:5px 0;min-height:28px;color:var(--green);font-size:12px}
#forecast-value{margin-left:auto;min-width:0}
#actions{text-align:center;margin-top:4px}#confirm p{margin-bottom:4px}.remove{border:0;border-radius:16px;padding:3px 9px;font-size:12px;font-weight:650;color:var(--red);background:var(--notice);min-height:30px}
#keep{margin-right:5px;padding:6px 10px;border:0;border-radius:8px;background:var(--panel)}
#status{margin:0 0 4px;color:var(--hint);font-size:11px}#status:empty{display:none}
.picking #name{overflow:hidden;white-space:nowrap;text-overflow:ellipsis}
@media(max-width:260px){.picking #heading{display:none}}
</style>
<main id="receipt" data-source="__SOURCE__">
<div id="active">
<div id="heading">
<span id="badge" class="badge"></span>
<div class="expense-line">
<button id="name" class="field"><span id="description"></span><span class="pen">✎</span></button>
<button id="amount" class="field"><span id="price"></span><span class="pen">✎</span></button>
</div>
</div>
<p id="status" role="status"></p>
<button id="category" aria-expanded="false" aria-controls="choices"><span id="category-title"></span><strong id="selected"></strong><span class="chevron" aria-hidden="true"></span></button>
<div id="choices" hidden></div>
<section id="budget">
<div id="day" class="row"><div class="line"><strong id="day-title"></strong><span id="day-figures" class="figures"></span></div><div id="day-track" class="track"><div id="day-fill" class="fill"></div></div><div class="line"><span id="day-note" class="note"></span><strong id="day-rest" class="rest"></strong></div><p id="extras" class="note"></p></div>
<div id="month" class="row"><div class="line"><strong id="month-title"></strong><span id="month-figures" class="figures"></span></div><div id="month-track" class="track"><div id="month-fill" class="fill"></div><div id="marker" hidden></div></div><div class="line"><span id="month-note" class="note"></span><strong id="month-rest" class="rest"></strong></div></div>
<div id="forecast"><button id="forecast-toggle" aria-expanded="false" aria-controls="forecast-note"><span id="forecast-title"></span><strong id="forecast-value" class="figures"></strong><span class="chevron" aria-hidden="true"></span></button><p id="forecast-note" class="note" hidden></p></div>
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
  el('receipt').classList.toggle('picking',choosing);
  el('choices').hidden=!choosing;el('budget').hidden=choosing;
  el('category').setAttribute('aria-expanded',String(choosing));
  el('confirm').hidden=!confirming;el('delete').hidden=confirming;
}
function row(id, values){
  set(id+'-figures',values[0]);
  const cut=values[3]??values[1].length;
  set(id+'-note',values[1].slice(0,cut).trim());set(id+'-rest',values[1].slice(cut));
  el(id+'-track').hidden=values[2]===null;
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
    const name=document.createElement('span'), tick=document.createElement('span');
    name.textContent=item[index];tick.className='tick';tick.textContent='✓';tick.setAttribute('aria-hidden','true');
    button.appendChild(name);button.appendChild(tick);
    button.setAttribute('aria-pressed',String(data.category===item[0]));
    button.addEventListener('click',()=>ask('cat:'+item[0],()=>{choosing=false;panels()}));
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
