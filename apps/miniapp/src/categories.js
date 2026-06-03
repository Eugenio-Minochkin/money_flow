export const categories = [
  ["food_cafe", "Еда и кафе", "#d85d35", "Food & cafe"],
  ["groceries", "Продукты", "#c28f2c", "Groceries"],
  ["home", "Дом", "#9a6a30", "Home"],
  ["transport", "Байк / транспорт", "#2f80c0", "Bike / transport"],
  ["health", "Тело / здоровье", "#b84d7a", "Body / health"],
  ["sport_activities", "Спорт / активности", "#4e9b55", "Sport / activities"],
  ["gear", "Вещи / экипировка", "#7a6a55", "Gear"],
  ["travel", "Путешествия", "#1d7f75", "Travel"],
  ["subscriptions", "Подписки / связь", "#6a62c8", "Subscriptions / phone"],
  ["education", "Образование", "#3f7f9f", "Education"],
  ["gifts_help", "Подарки / помощь", "#c46a8a", "Gifts / help"],
  ["entertainment", "Развлечения", "#d87135", "Entertainment"],
  ["other", "Другое", "#756b61", "Other"]
];

export function categoryLabel(slug, language = "ru") {
  const category = categories.find(([value]) => value === slug);
  if (!category) return slug;
  return language === "en" ? category[3] : category[1];
}

export function categoryColor(slug) {
  return categories.find(([value]) => value === slug)?.[2] ?? "#756b61";
}
