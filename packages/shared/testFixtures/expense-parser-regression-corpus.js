export const SYNTHETIC_EXPENSE_PARSER_CORPUS = Object.freeze([
  { id: "ru_compact_thousands", route: "local_safe", text: "кофе 14к бат", amount: 14_000, currency: "THB" },
  { id: "en_spaced_thousands", route: "local_safe", text: "lunch 14 000 rupiah", amount: 14_000, currency: "IDR" },
  { id: "ru_number_words", route: "local_safe", text: "такси четырнадцать тысяч рублей", amount: 14_000, currency: "RUB" },
  { id: "ru_asr_currency_punctuation", route: "local_safe", text: "кофе 180, бат", amount: 180, currency: "THB", defaultCurrency: "USD" },
  { id: "en_asr_currency_punctuation", route: "local_safe", text: "coffee 12, dollars", amount: 12, currency: "USD", defaultCurrency: "THB" },
  { id: "en_amount_first", route: "local_safe", text: "$12 lunch", amount: 12, currency: "USD" },
  { id: "unknown_category", route: "local_reviewable", text: "notebook 120 baht", amount: 120, currency: "THB" },
  { id: "ru_multi_semicolon", route: "local_safe", text: "кофе 80 бат; такси 120 бат", count: 2 },
  { id: "en_multi_and", route: "local_safe", text: "coffee 80 baht and taxi 120 baht", count: 2 },
  { id: "no_amount", route: "local_rejected", text: "coffee", rejectReason: "no_amount_token" },
  { id: "ambiguous_amounts", route: "local_rejected", text: "coffee 80 taxi 120", rejectReason: "multiple_amounts_ambiguous" },
  { id: "mixed_word_digit_amounts", route: "local_rejected", text: "кофе сто бат чай 200 бат", rejectReason: "multiple_amounts_ambiguous" },
  { id: "small_quantity", route: "local_rejected", text: "2 coffees", rejectReason: "small_bare_integer" },
  { id: "unsupported_decimal", route: "local_rejected", text: "coffee 12.3456", rejectReason: "unsupported_amount_shape" },
  { id: "over_limit", route: "local_rejected", text: "car 1000001", rejectReason: "amount_over_limit" },
  { id: "unsafe_mapping", route: "local_rejected", text: "taxi 100 + 20 tip", rejectReason: "unsafe_split_or_mapping" },
  { id: "conflicting_currency_after", route: "local_rejected", text: "coffee 100 usd rub", rejectReason: "unsafe_split_or_mapping" },
  { id: "conflicting_currency_around", route: "local_rejected", text: "usd lunch 100 rub", rejectReason: "unsafe_split_or_mapping" },
  { id: "unsupported_words", route: "local_rejected", text: "кофе двадцать одиннадцать бат", rejectReason: "unsupported_number_words" }
]);

export const SYNTHETIC_HIGH_RISK_EXPENSES = Object.freeze([
  "transfer 1000",
  "перевод 1000",
  "пополни бюджет 5000",
  "reserve 500",
  "planned payment 1000",
  "плановая аренда 20000",
  "split taxi 600",
  "вернул долг 700",
  "долг 500",
  "refund 800",
  "возврат 800",
  "installment laptop 12000",
  "spread insurance 24000 over 12 months",
  "outside budget watch 50000",
  "dinner 900 on 2026-07-20"
]);
