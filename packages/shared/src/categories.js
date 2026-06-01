export const CATEGORIES = [
  { slug: "food_cafe", name: "Еда и кафе", keywords: ["кофе", "завтрак", "обед", "ужин", "кафе"] },
  { slug: "groceries", name: "Продукты", keywords: ["продукты", "магазин"] },
  { slug: "home", name: "Дом", keywords: ["дом", "аренда"] },
  { slug: "transport", name: "Байк / транспорт", keywords: ["бензин", "байк", "такси"] },
  { slug: "health", name: "Тело / здоровье / восстановление", keywords: ["психолог", "врач", "массаж"] },
  { slug: "sport_activities", name: "Спорт / активности", keywords: ["йога", "скалолазание", "контактка", "контактная"] },
  { slug: "gear", name: "Вещи / экипировка", keywords: ["туфли", "экипировка", "одежда"] },
  { slug: "travel", name: "Путешествия", keywords: ["отель", "билет"] },
  { slug: "subscriptions", name: "Подписки / связь", keywords: ["подписка", "интернет", "телефон"] },
  { slug: "gifts_help", name: "Подарки / помощь", keywords: ["подарок", "помощь"] },
  { slug: "entertainment", name: "Развлечения / мероприятия", keywords: ["кино", "концерт"] },
  { slug: "other", name: "Другое", keywords: [] }
];

export function categoryName(slug) {
  return CATEGORIES.find((category) => category.slug === slug)?.name ?? "Другое";
}

export function inferCategory(description) {
  const normalized = description.toLowerCase();
  return CATEGORIES.find((category) =>
    category.keywords.some((keyword) => normalized.includes(keyword))
  )?.slug ?? "other";
}

export function inferTags(description) {
  const text = description.toLowerCase();
  const tags = [];
  if (text.includes("девуш")) tags.push("девушка", "свидание");
  if (text.includes("скал")) tags.push("скалолазание");
  if (text.includes("контакт")) tags.push("contact_improv");
  if (text.includes("психолог")) tags.push("регулярная трата");
  return [...new Set(tags)];
}
