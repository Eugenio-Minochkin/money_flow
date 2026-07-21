export const CATEGORIES = [
  {
    slug: "food_cafe",
    name: "Еда и кафе",
    keywords: [
      "кофе", "coffee", "кофейня", "какао", "matcha", "матча", "завтрак", "обед", "ужин",
      "brunch", "breakfast", "lunch", "dinner", "кафе", "cafe", "restaurant", "ресторан",
      "ramen", "рамен", "sushi", "суши", "pizza", "пицца", "burger", "бургер", "smoothie",
      "смузи", "pad thai", "пад тай", "noodles", "лапша", "sandwich", "сэндвич", "dessert", "десерт"
    ]
  },
  {
    slug: "groceries",
    name: "Продукты",
    keywords: [
      "продукты", "grocery", "groceries", "grocery store", "supermarket", "супермаркет",
      "convenience store", "minimart", "мини-маркет", "7eleven", "7-eleven", "7/11", "seven eleven",
      "lotus", "big c", "tops", "makro", "макро", "молоко", "milk", "eggs", "яйца", "fruits",
      "фрукты", "vegetables", "овощи", "bread", "хлеб", "cheese", "сыр", "yogurt", "yoghurt", "йогурт"
    ]
  },
  {
    slug: "home",
    name: "Дом",
    keywords: [
      "аренда", "rent", "apartment rent", "room rent", "condo rent", "rent payment", "аренда квартиры",
      "оплата квартиры", "квартира", "apartment", "электричество", "electricity", "electricity bill",
      "electric bill", "water bill", "utility bill", "коммунал", "коммуналка", "utilities", "laundry",
      "стирка", "уборка", "cleaning", "housekeeping", "maid", "клининг"
    ]
  },
  {
    slug: "transport",
    name: "Байк / транспорт",
    keywords: [
      "бензин", "fuel", "petrol", "gasoline", "gas station", "байк", "moto", "motorbike", "мотобайк",
      "scooter", "motorcycle", "такси", "taxi", "grab", "bolt", "tuk tuk", "tuktuk", "songthaew",
      "парковка", "parking", "bike repair", "motorbike repair", "motorcycle repair", "oil change",
      "bike wash", "замена масла", "ремонт байка", "ремонт мотоцикла", "мойка байка", "мотосервис"
    ]
  },
  {
    slug: "health",
    name: "Тело / здоровье / восстановление",
    keywords: [
      "врач", "doctor", "clinic", "клиника", "hospital", "больница", "аптека", "аптек", "pharmacy",
      "лекарство", "medicine", "таблетки", "pills", "витамины", "vitamins", "мазь", "массаж", "massage",
      "психолог", "psychologist", "therapist", "dentist", "dental", "стоматолог", "стоматология",
      "medical checkup", "check-up", "checkup", "physio", "physiotherapy", "физиотерапия", "rehab",
      "rehabilitation", "реабилитация", "spa", "спа", "sauna", "сауна", "анализы"
    ]
  },
  {
    slug: "sport_activities",
    name: "Спорт / активности",
    keywords: [
      "скалолазание", "climbing", "climb", "climbing gym", "скалодром", "bouldering", "боулдеринг",
      "gym", "workout", "тренировка", "fitness", "фитнес", "йога", "yoga", "бассейн", "pool",
      "swimming", "плавание", "martial arts", "единоборства", "контактка", "contact improv"
    ]
  },
  {
    slug: "gear",
    name: "Вещи / экипировка",
    keywords: [
      "одежда", "clothes", "clothing", "кроссовки", "sneakers", "shoes", "футболка", "t-shirt",
      "экипировка", "gear", "headphones", "наушники", "speaker", "колонка", "backpack", "рюкзак",
      "laptop", "ноутбук", "camera", "камера", "charger", "зарядка", "power bank", "powerbank",
      "пауэрбанк", "helmet", "шлем"
    ]
  },
  {
    slug: "travel",
    name: "Путешествия",
    keywords: [
      "hotel", "отель", "hostel", "guesthouse", "гестхаус", "airbnb", "flight", "flight ticket",
      "plane ticket", "авиабилет", "ticket", "билет", "билет на самолет", "билет на самолёт", "train",
      "поезд", "airport", "аэропорт", "accommodation", "проживание", "baggage", "багаж", "luggage",
      "visa", "виза"
    ]
  },
  {
    slug: "subscriptions",
    name: "Подписки / связь",
    keywords: [
      "интернет", "internet", "mobile", "sim", "симка", "phone bill", "mobile bill", "mobile top-up",
      "mobile topup", "phone top-up", "phone topup", "пополнение телефона", "мобильная связь", "data plan",
      "hosting", "vpn", "icloud", "google one", "cloud storage", "облачное хранилище", "chatgpt",
      "spotify", "netflix", "youtube premium", "подписка", "subscription"
    ]
  },
  {
    slug: "education",
    name: "Образование",
    keywords: [
      "english", "английский", "английского", "lesson", "language lesson", "language class", "урок",
      "course", "online course", "онлайн-курс", "курс", "обучение", "study", "class", "tutor",
      "репетитор", "spanish lesson", "урок испанского", "thai lesson", "урок тайского", "chinese lesson",
      "урок китайского"
    ]
  },
  {
    slug: "gifts_help",
    name: "Подарки / помощь",
    keywords: [
      "gift", "present", "подарок", "подарки", "flowers", "цветы", "help", "помощь", "donation",
      "донат", "charity", "благотворительность", "fundraiser", "сбор средств"
    ]
  },
  {
    slug: "entertainment",
    name: "Развлечения / мероприятия",
    keywords: [
      "cinema", "кино", "movie", "фильм", "concert", "концерт", "party", "клуб", "club", "event",
      "мероприятие", "theater", "theatre", "театр", "museum", "музей", "exhibition", "выставка",
      "festival", "фестиваль", "bowling", "боулинг", "karaoke", "караоке", "stand-up", "стендап"
    ]
  },
  { slug: "other", name: "Другое", keywords: [] }
];

const CYRILLIC_STEM_CATEGORIES = [
  { slug: "health", stems: ["аптек", "массаж", "стоматолог", "физиотерап", "реабилитац"] },
  { slug: "transport", stems: ["бензин", "парковк", "мотоцикл", "мотосервис"] },
  { slug: "groceries", stems: ["продукт", "супермаркет"] },
  { slug: "food_cafe", stems: ["завтрак", "обед", "ужин", "ресторан"] },
  { slug: "home", stems: ["аренд", "квартир", "коммунал", "уборк", "стирк"] },
  { slug: "sport_activities", stems: ["скалолазан", "боулдеринг", "тренировк", "бассейн", "плаван", "единоборств"] },
  { slug: "gear", stems: ["кроссовк", "футболк", "экипировк", "рюкзак", "наушник", "зарядк", "пауэрбанк", "ноутбук"] },
  { slug: "travel", stems: ["отел", "хостел", "гестхаус", "авиабилет", "аэропорт", "багаж"] },
  { slug: "subscriptions", stems: ["подписк", "симк"] },
  { slug: "education", stems: ["английск", "репетитор"] },
  { slug: "gifts_help", stems: ["подар", "благотворител"] },
  { slug: "entertainment", stems: ["концерт", "вечеринк", "мероприят", "музе", "театр", "выставк", "фестивал", "боулинг", "караок", "стендап"] }
];

export function categoryName(slug) {
  return CATEGORIES.find((category) => category.slug === slug)?.name ?? "Другое";
}

export function inferCategory(description) {
  const normalized = normalizeText(description);
  const exactCategory = CATEGORIES.find((category) =>
    category.keywords.some((keyword) => keywordMatches(normalized, keyword))
  );
  if (exactCategory) return exactCategory.slug;

  return CYRILLIC_STEM_CATEGORIES.find((category) =>
    category.stems.some((stem) => safeCyrillicStemMatches(normalized, stem))
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
