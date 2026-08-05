import { readFile } from "node:fs/promises";

import { summarizeLocalParserCsvRows } from "../src/localParserCsvAudit.js";

const file = process.argv.slice(2).find((arg) => String(arg).startsWith("--file="))?.slice("--file=".length);
if (!file || process.argv.length !== 3) {
  console.error(JSON.stringify({ error: "invalid_csv_audit_options" }));
  process.exitCode = 1;
} else {
  try {
    const content = await readFile(file, "utf8");
    const rows = parseCsv(content);
    console.log(JSON.stringify(summarizeLocalParserCsvRows(rows)));
  } catch {
    console.error(JSON.stringify({ error: "csv_audit_failed" }));
    process.exitCode = 1;
  }
}

function parseCsv(content) {
  const records = [];
  let row = [];
  let value = "";
  let quoted = false;
  for (let index = 0; index < content.length; index += 1) {
    const character = content[index];
    if (character === '"') {
      if (quoted && content[index + 1] === '"') { value += character; index += 1; }
      else quoted = !quoted;
    } else if (character === "," && !quoted) {
      row.push(value); value = "";
    } else if ((character === "\n" || character === "\r") && !quoted) {
      if (character === "\r" && content[index + 1] === "\n") index += 1;
      row.push(value); value = "";
      if (row.some(Boolean)) records.push(row);
      row = [];
    } else value += character;
  }
  if (value || row.length) { row.push(value); records.push(row); }
  const headers = records.shift() ?? [];
  return records.map((values) => Object.fromEntries(headers.map((header, index) => [header, values[index] ?? ""])));
}
