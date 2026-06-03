export const currencies = [
  ["THB", "🇹🇭 THB - Thai baht"],
  ["USD", "🇺🇸 USD - US dollar"],
  ["RUB", "🇷🇺 RUB - Russian ruble"],
  ["IDR", "🇮🇩 IDR - Indonesian rupiah"],
  ["EUR", "🇪🇺 EUR - Euro"],
  ["BYN", "🇧🇾 BYN - Belarusian ruble"],
  ["GEL", "🇬🇪 GEL - Georgian lari"]
];

export function currencyOptions(selected, option) {
  return currencies.map(([code, label]) => option(code, selected, label)).join("");
}

export function currencyLabel(code) {
  return currencies.find(([value]) => value === code)?.[1] ?? code;
}
