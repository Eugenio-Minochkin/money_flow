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
#heading{display:grid;grid-template-columns:minmax(0,1fr) auto;align-items:start;gap:0 7px;margin-bottom:5px}
.badge{border-radius:20px;padding:3px 7px;font-size:11px;font-weight:700;color:var(--green);background:var(--track);white-space:nowrap}
.field{display:block;justify-self:start;max-width:100%;min-width:0;padding:2px 0;border:0;background:transparent;text-align:left;font-weight:700;overflow-wrap:anywhere}
#name{font-size:16px}#amount{grid-column:1/-1;font-size:21px;line-height:1.15}
.pen{margin-left:4px;font-size:12px;color:var(--green)}
#category,.choice{display:block;box-sizing:border-box;width:100%;border:1px solid var(--line);border-radius:8px;background:var(--panel);padding:6px 7px;text-align:left}
#category{display:flex;justify-content:space-between;align-items:center;gap:8px;min-height:32px;padding:5px 7px}
#category strong{text-align:right;color:var(--green)}#choices{display:grid;grid-template-columns:1fr 1fr;gap:4px;margin-top:6px}
.choice{font-size:12px;min-height:35px}.choice[aria-pressed="true"]{color:var(--green);background:var(--track);font-weight:700}
#budget{margin-top:8px}.row{margin-bottom:6px}.line{display:flex;justify-content:space-between;gap:2px 6px;flex-wrap:wrap}
.figures{white-space:nowrap;font-variant-numeric:tabular-nums}.track{height:5px;margin:3px 0;border-radius:9px;background:var(--track);position:relative}
.fill{height:100%;border-radius:9px;background:var(--fill)}.over .fill{background:var(--red)}
.note{font-size:11px;color:var(--hint)}
#marker{position:absolute;width:2px;height:9px;top:-2px;border-radius:2px;background:light-dark(#b26b16,#d3b574)}
#forecast{border-top:1px solid var(--line)}
summary{padding:3px 0;color:var(--green);font-size:12px;font-weight:650}details p{margin-top:2px}
#actions{text-align:center;margin-top:4px}#confirm p{margin-bottom:4px}.remove{border:0;border-radius:16px;padding:3px 9px;font-size:12px;font-weight:650;color:var(--red);background:var(--notice);min-height:30px}
#keep{margin-right:5px;padding:6px 10px;border:0;border-radius:8px;background:var(--panel)}
#status{margin:0 0 4px;color:var(--hint);font-size:11px}#status:empty{display:none}
</style>
<main id="receipt" data-source="__SOURCE__">
<div id="active">
<div id="heading">
<button id="name" class="field"><span id="description"></span><span class="pen">✎</span></button>
<span id="badge" class="badge"></span>
<button id="amount" class="field"><span id="price"></span><span class="pen">✎</span></button>
</div>
<p id="status" role="status"></p>
<button id="category" aria-expanded="false"><span id="category-title"></span><strong id="selected"></strong></button>
<div id="choices" hidden></div>
<section id="budget">
<div id="day" class="row"><div class="line"><strong id="day-title"></strong><span id="day-figures" class="figures"></span></div><div id="day-track" class="track"><div id="day-fill" class="fill"></div></div><p id="day-note" class="note"></p><p id="extras" class="note"></p></div>
<div id="month" class="row"><div class="line"><strong id="month-title"></strong><span id="month-figures" class="figures"></span></div><div id="month-track" class="track"><div id="month-fill" class="fill"></div><div id="marker" hidden></div></div><p id="month-note" class="note"></p></div>
<details id="forecast"><summary id="forecast-title"></summary><p id="forecast-note" class="note"></p></details>
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
  el('choices').hidden=!choosing;el('budget').hidden=choosing;
  el('category').setAttribute('aria-expanded',String(choosing));
  el('confirm').hidden=!confirming;el('delete').hidden=confirming;
}
function row(id, values){
  set(id+'-figures',values[0]);set(id+'-note',values[1]);
  el(id+'-track').hidden=values[2]===null;
  el(id+'-fill').style.width=Math.min(100,Math.max(0,values[2]))+'%';
  el(id).classList.toggle('over',values[2]>100);
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
  set('selected',(labels.find(item=>item[0]===data.category)||labels[labels.length-1])[index]+' ⌄');
  el('choices').innerHTML='';
  for(const item of labels){
    const button=document.createElement('button');button.className='choice';button.textContent=item[index];
    button.setAttribute('aria-pressed',String(data.category===item[0]));
    button.addEventListener('click',()=>ask('cat:'+item[0],()=>{choosing=false;panels()}));
    el('choices').appendChild(button);
  }
  set('day-title',tr('Сегодня · обычные','Today · regular'));set('month-title',tr('Месяц','Month'));
  row('day',data.day);row('month',data.month);set('extras',data.extras||'');
  el('forecast').hidden=!data.forecast;el('marker').hidden=data.marker===null;
  if(data.marker!==null)el('marker').style.left=Math.min(99,Math.max(0,data.marker))+'%';
  if(data.forecast){set('forecast-title',tr('Прогноз · ','Forecast · ')+data.forecast[0]);set('forecast-note',data.forecast[1]);}
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
    day: [figures(snapshot.today, snapshot.dayPlanLimit), Number(snapshot.dayOverrun) > 0
      ? tr("Сверх лимита ", "Over by ") + money(snapshot.dayOverrun)
      : tr("Осталось ", "Left ") + money(snapshot.dayRemaining), progress(snapshot.dayProgressPercent, snapshot.dayPlanLimit)],
    month: [figures(snapshot.month, snapshot.monthlyBudget),
      tr("Свободно после плановых ", "Free after planned ") + money(snapshot.freeRemaining),
      progress(snapshot.budgetProgressPercent, snapshot.monthlyBudget)],
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
