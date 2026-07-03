export const CATEGORIES = [
  { slug: "food_cafe", name: "Еда и кафе", keywords: ["кофе", "coffee", "кофейня", "какао", "matcha", "матча", "завтрак", "обед", "ужин", "brunch", "breakfast", "lunch", "dinner", "кафе", "cafe", "restaurant", "ресторан", "ramen", "рамен", "sushi", "суши", "pizza", "пицца", "burger", "бургер", "smoothie", "смузи"] },
  { slug: "groceries", name: "Продукты", keywords: ["продукты", "grocery", "groceries", "supermarket", "супермаркет", "7eleven", "7-eleven", "lotus", "big c", "tops", "makro", "макро", "молоко", "milk", "eggs", "яйца", "fruits", "фрукты", "vegetables", "овощи"] },
  { slug: "home", name: "Дом", keywords: ["аренда", "rent", "квартира", "apartment", "электричество", "electricity", "water bill", "коммунал", "коммуналка", "utilities", "laundry", "стирка", "уборка", "cleaning"] },
  { slug: "transport", name: "Байк / транспорт", keywords: ["бензин", "fuel", "petrol", "байк", "moto", "motorbike", "мотобайк", "такси", "taxi", "grab", "bolt", "парковка", "parking"] },
  { slug: "health", name: "Тело / здоровье / восстановление", keywords: ["врач", "doctor", "clinic", "клиника", "hospital", "больница", "аптека", "аптек", "pharmacy", "лекарство", "medicine", "таблетки", "pills", "витамины", "vitamins", "мазь", "массаж", "massage", "психолог", "psychologist", "therapist"] },
  { slug: "sport_activities", name: "Спорт / активности", keywords: ["скалолазание", "climbing", "climb", "gym", "йога", "yoga", "бассейн", "pool", "контактка", "contact improv"] },
  { slug: "gear", name: "Вещи / экипировка", keywords: ["одежда", "clothes", "clothing", "кроссовки", "sneakers", "shoes", "футболка", "t-shirt", "экипировка", "gear", "headphones", "наушники", "speaker", "колонка"] },
  { slug: "travel", name: "Путешествия", keywords: ["hotel", "отель", "hostel", "flight", "авиабилет", "ticket", "билет", "train", "поезд", "visa", "виза"] },
  { slug: "subscriptions", name: "Подписки / связь", keywords: ["интернет", "internet", "mobile", "sim", "симка", "hosting", "chatgpt", "spotify", "netflix", "youtube premium", "подписка", "subscription"] },
  { slug: "education", name: "Образование", keywords: ["english", "английский", "английского", "lesson", "урок", "course", "курс", "обучение", "study", "class"] },
  { slug: "gifts_help", name: "Подарки / помощь", keywords: ["gift", "подарок", "flowers", "цветы", "help", "помощь", "donation", "донат"] },
  { slug: "entertainment", name: "Развлечения / мероприятия", keywords: ["cinema", "кино", "concert", "концерт", "party", "клуб", "club", "event", "мероприятие"] },
  { slug: "other", name: "Другое", keywords: [] }
];

const CYRILLIC_STEM_CATEGORIES = [
  { slug: "health", stems: ["аптек", "массаж"] },
  { slug: "transport", stems: ["бензин"] },
  { slug: "groceries", stems: ["продукт"] },
  { slug: "food_cafe", stems: ["завтрак", "обед", "ужин"] },
  { slug: "education", stems: ["английск"] }
];

export function categoryName(slug) {
  return CATEGORIES.find((category) => category.slug === slug)?.name ?? "Другое";
}

export function inferCategory(description) {
  const normalized = normalizeText(description);
  const actualCyrillicCategory = inferActualCyrillicCategory(normalized);
  if (actualCyrillicCategory) return actualCyrillicCategory;

  const exactCategory = CATEGORIES.find((category) =>
    category.keywords.some((keyword) => keywordMatches(normalized, keyword))
  );
  if (exactCategory) return exactCategory.slug;

  return CYRILLIC_STEM_CATEGORIES.find((category) =>
    category.stems.some((stem) => safeCyrillicStemMatches(normalized, stem))
  )?.slug ?? "other";
}

function inferActualCyrillicCategory(text) {
  const groups = [
    { slug: "food_cafe", words: ["кофе", "обед", "еда"] },
    { slug: "groceries", words: ["молоко", "продукты"] },
    { slug: "transport", words: ["такси", "билет", "самолет", "стоянка"] },
    { slug: "subscriptions", words: ["интернет", "телефон", "телефона"] }
  ];
  return groups.find((group) =>
    group.words.some((word) => keywordMatches(text, word))
  )?.slug ?? null;
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

function normalizeText(value) {
  return String(value ?? "")
    .toLowerCase()
    .replaceAll("ё", "е")
    .replaceAll(/\s+/g, " ")
    .trim();
}

function keywordMatches(text, keyword) {
  const normalizedKeyword = normalizeText(keyword);
  const escaped = escapeRegExp(normalizedKeyword).replaceAll(/\\ /g, "\\s+");
  return new RegExp(`(?<![\\p{L}\\p{N}])${escaped}(?![\\p{L}\\p{N}])`, "iu").test(text);
}

function safeCyrillicStemMatches(text, stem) {
  const normalizedStem = normalizeText(stem);
  if (!/^[а-я]+$/iu.test(normalizedStem)) return false;
  const escaped = escapeRegExp(normalizedStem);
  return new RegExp(`(?<![\\p{L}\\p{N}])${escaped}[\\p{L}]*(?![\\p{L}\\p{N}])`, "iu").test(text);
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
