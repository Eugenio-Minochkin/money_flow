const BOM = "\ufeff";

export function writeCsv(rows, headers) {
  const headerLine = headers.join(",");
  const rowLines = rows.map((row) => headers.map((header) => csvCell(row?.[header])).join(","));
  return BOM + [headerLine, ...rowLines].join("\r\n");
}

function csvCell(value) {
  if (value == null) return "";
  const text = String(value);
  if (!/[",\r\n]/.test(text)) return text;
  return `"${text.replaceAll('"', '""')}"`;
}
