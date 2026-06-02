export const categories = [
  ["food_cafe", "Еда и кафе", "#d85d35"],
  ["groceries", "Продукты", "#c28f2c"],
  ["home", "Дом", "#9a6a30"],
  ["transport", "Байк / транспорт", "#2f80c0"],
  ["health", "Тело / здоровье", "#b84d7a"],
  ["sport_activities", "Спорт / активности", "#4e9b55"],
  ["gear", "Вещи / экипировка", "#7a6a55"],
  ["travel", "Путешествия", "#1d7f75"],
  ["subscriptions", "Подписки / связь", "#6a62c8"],
  ["gifts_help", "Подарки / помощь", "#c46a8a"],
  ["entertainment", "Развлечения", "#d87135"],
  ["other", "Другое", "#756b61"]
];

export function categoryLabel(slug) {
  return categories.find(([value]) => value === slug)?.[1] ?? slug;
}

export function categoryColor(slug) {
  return categories.find(([value]) => value === slug)?.[2] ?? "#756b61";
}
