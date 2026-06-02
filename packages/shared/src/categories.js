export const CATEGORIES = [
  { slug: "food_cafe", name: "Еда и кафе", keywords: ["кофе", "завтрак", "обед", "ужин", "кафе", "какао", "khao", "dinner", "lunch"] },
  { slug: "groceries", name: "Продукты", keywords: ["продукты", "магазин", "молоко", "вода", "супермаркет"] },
  { slug: "home", name: "Дом", keywords: ["дом", "аренда", "квартира", "электричество", "свет", "коммунал", "стирка", "laundry"] },
  { slug: "transport", name: "Байк / транспорт", keywords: ["бензин", "байк", "такси", "transport", "taxi"] },
  { slug: "health", name: "Тело / здоровье / восстановление", keywords: ["психолог", "врач", "массаж", "аптек", "мазь", "лечение"] },
  { slug: "sport_activities", name: "Спорт / активности", keywords: ["йога", "скалолазание", "контактка", "контактная"] },
  { slug: "gear", name: "Вещи / экипировка", keywords: ["туфли", "экипировка", "одежда", "колонк", "audio"] },
  { slug: "travel", name: "Путешествия", keywords: ["отель", "билет"] },
  { slug: "subscriptions", name: "Подписки / связь", keywords: ["подписка", "интернет", "телефон", "сервер", "chatgpt"] },
  { slug: "education", name: "Образование", keywords: ["english", "английск", "урок", "lesson", "курс", "обучение", "education"] },
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
  if (text.includes("english") || text.includes("английск")) tags.push("english");
  return [...new Set(tags)];
}
