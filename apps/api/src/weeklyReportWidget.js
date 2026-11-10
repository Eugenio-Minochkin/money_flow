export const weeklyReportWidgetHtml = `<style>
  body { font-size: 14px; line-height: 1.4; padding-bottom: 18px; }
  .tabs { display: flex; gap: 6px; margin-bottom: 10px; }
  .tabs button { border: 0; border-radius: 8px; padding: 6px 10px; color: var(--tg-theme-text-color); background: var(--tg-theme-secondary-bg-color); }
  .tabs .active { color: var(--tg-theme-button-text-color); background: var(--tg-theme-button-color); }
  .category { margin: 8px 0; }
  .row { display: flex; justify-content: space-between; gap: 8px; }
  .amount { white-space: nowrap; }
  .track { height: 4px; margin-top: 4px; border-radius: 4px; background: var(--tg-theme-secondary-bg-color); }
  .fill { height: 4px; border-radius: 4px; background: var(--tg-theme-button-color); }
  .note { margin: 8px 0 0; color: var(--tg-theme-hint-color); font-size: 12px; }
  .expenses { margin-top: 14px; border-top: 1px solid var(--tg-theme-secondary-bg-color); padding-top: 10px; }
  .expenses h4 { font-size: 14px; margin: 0 0 6px; }
  .expenses .row { padding: 3px 0; }
  .hidden { display: none; }
</style>
<div class="tabs hidden" id="tabs">
  <button id="categories-button" class="active"></button>
  <button id="changes-button"></button>
</div>
<div id="details">
  <div id="categories"></div>
  <div id="expenses" class="expenses hidden">
    <h4 id="expenses-title"></h4>
  </div>
</div>
<div id="changes" class="hidden"></div>
<script>
  const data = JSON.parse(window.TelegramWidget.chatData);
  const english = data.language === 'en';
  const categories = document.getElementById('categories');
  const details = document.getElementById('details');
  const changes = document.getElementById('changes');
  const categoriesButton = document.getElementById('categories-button');
  const changesButton = document.getElementById('changes-button');

  for (const item of data.categories) {
    const card = document.createElement('div');
    card.className = 'category';
    card.innerHTML = '<div class="row"><span></span><strong class="amount"></strong></div><div class="track"><div class="fill"></div></div>';
    card.querySelector('span').textContent = item.name;
    card.querySelector('strong').textContent = item.amount + ' · ' + item.percent + '%';
    card.querySelector('.fill').style.width = Math.max(0, Math.min(100, item.percent)) + '%';
    categories.appendChild(card);
  }
  if (data.topTwoShare != null) {
    const note = document.createElement('p');
    note.className = 'note';
    note.textContent = english ? 'Top two categories · ' + data.topTwoShare + '%' : 'Две главные категории · ' + data.topTwoShare + '%';
    categories.appendChild(note);
  }

  if (data.largestExpenses.length) {
    const expenses = document.getElementById('expenses');
    document.getElementById('expenses-title').textContent = english ? 'Largest expenses' : 'Самые большие расходы';
    for (const item of data.largestExpenses) {
      const row = document.createElement('div');
      row.className = 'row';
      row.innerHTML = '<span></span><strong class="amount"></strong>';
      row.querySelector('span').textContent = item.name;
      row.querySelector('strong').textContent = item.amount;
      expenses.appendChild(row);
    }
    expenses.classList.remove('hidden');
  }

  if (data.changes.length) {
    categoriesButton.textContent = english ? 'Categories' : 'Категории';
    changesButton.textContent = english ? 'What changed' : 'Что изменилось';
    for (const line of data.changes) {
      const item = document.createElement('p');
      item.textContent = line;
      changes.appendChild(item);
    }
    function showChanges(visible) {
      details.classList.toggle('hidden', visible);
      changes.classList.toggle('hidden', !visible);
      categoriesButton.classList.toggle('active', !visible);
      changesButton.classList.toggle('active', visible);
    }
    categoriesButton.addEventListener('click', () => showChanges(false));
    changesButton.addEventListener('click', () => showChanges(true));
    document.getElementById('tabs').classList.remove('hidden');
  }
</script>`;
