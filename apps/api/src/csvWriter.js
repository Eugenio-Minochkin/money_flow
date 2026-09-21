const BOM = "\ufeff";

export function writeCsv(rows, headers) {
  const headerLine = headers.join(",");
  const rowLines = rows.map((row) => headers.map((header) => csvCell(row?.[header])).join(","));
  return BOM + [headerLine, ...rowLines].join("\r\n");
}

function csvCell(value) {
  if (value == null) return "";
  const text = String(value);
  const safeText = typeof value === "string" && /^[\s\u0000-\u001f\u007f]*[=+\-@]/u.test(text)
    ? `'${text}`
    : text;
  if (!/[",\r\n]/.test(safeText)) return safeText;
  return `"${safeText.replaceAll('"', '""')}"`;
}
