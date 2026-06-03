export const currencies = [
  ["THB", "[TH] THB - Thai baht"],
  ["USD", "[US] USD - US dollar"],
  ["RUB", "[RU] RUB - Russian ruble"],
  ["IDR", "[ID] IDR - Indonesian rupiah"],
  ["EUR", "[EU] EUR - Euro"],
  ["BYN", "[BY] BYN - Belarusian ruble"],
  ["GEL", "[GE] GEL - Georgian lari"]
];

export function currencyOptions(selected, option) {
  return currencies.map(([code, label]) => option(code, selected, label)).join("");
}

export function currencyLabel(code) {
  return currencies.find(([value]) => value === code)?.[1] ?? code;
}
