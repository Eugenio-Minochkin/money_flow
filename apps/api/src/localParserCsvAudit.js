import { parseExpenseText } from "../../../packages/shared/src/parser.js";

export function summarizeLocalParserCsvRows(rows, { parseExpenseText: parse = parseExpenseText } = {}) {
  const localCategoryCounts = {};
  let totalRecordCount = 0;
  let localResolvedCount = 0;
  let localOtherCount = 0;
  let categoryMismatchCount = 0;

  for (const row of rows ?? []) {
    const storedCategory = String(row?.category ?? "").trim();
    const note = String(row?.note ?? "").trim();
    if (!note) continue;

    totalRecordCount += 1;
    const parserInput = [note, row?.amount, row?.currency].map((value) => String(value ?? "").trim()).filter(Boolean).join(" ");
    const localCategory = String(parse(parserInput)?.expenses?.[0]?.category_slug ?? "other");
    localCategoryCounts[localCategory] = (localCategoryCounts[localCategory] ?? 0) + 1;
    if (localCategory === "other") localOtherCount += 1;
    else localResolvedCount += 1;
    if (storedCategory && localCategory !== storedCategory) categoryMismatchCount += 1;
  }

  return {
    totalRecordCount,
    localResolvedCount,
    localOtherCount,
    categoryMismatchCount,
    localCategoryCounts: Object.fromEntries(Object.entries(localCategoryCounts).sort(([left], [right]) => left.localeCompare(right)))
  };
}
