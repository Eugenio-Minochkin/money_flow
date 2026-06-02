export const currencies = [
  ["THB", "🇹🇭 THB"],
  ["USD", "🇺🇸 USD"],
  ["RUB", "🇷🇺 RUB"],
  ["IDR", "🇮🇩 IDR"],
  ["EUR", "🇪🇺 EUR"],
  ["BYN", "🇧🇾 BYN"],
  ["GEL", "🇬🇪 GEL"]
];

export function currencyOptions(selected, option) {
  return currencies.map(([code, label]) => option(code, selected, label)).join("");
}
