const PRODUCT_OPEN_SECTIONS = new Set(["👥 User base", "📅 Today", "📅 Last 7 days"]);
const TECHNICAL_OPEN_GROUPS = new Set(["Traffic", "Errors", "Processing"]);

export function renderAdminRichMessage(sections, { reportType }) {
  const nonEmptySections = (sections ?? []).filter((section) => (section.rows ?? []).length > 0);
  if (nonEmptySections.length === 0) return "";

  const [title, ...content] = nonEmptySections;
  const parts = [`<h1>${escapeRichHtml(title.heading)}</h1>`];
  const generated = title.rows?.[0];
  if (generated) parts.push(`<footer>${renderInline(generated)}</footer>`);

  if (reportType === "technical") {
    parts.push(...renderTechnicalSections(content));
  } else {
    parts.push(...content.map(renderProductSection));
  }
  return parts.join("\n");
}

function renderProductSection(section) {
  const table = renderTable(section.rows);
  const heading = escapeRichHtml(section.heading);
  return PRODUCT_OPEN_SECTIONS.has(section.heading)
    ? `<h2>${heading}</h2>\n${table}`
    : `<details><summary>${heading}</summary>\n${table}\n</details>`;
}

function renderTechnicalSections(sections) {
  const parts = [];
  let currentPeriod = null;
  for (const section of sections) {
    const parsed = parseTechnicalHeading(section.heading);
    if (!parsed) continue;
    if (parsed.period !== currentPeriod) {
      if (currentPeriod !== null) parts.push("<hr/>");
      currentPeriod = parsed.period;
      parts.push(`<h2>${escapeRichHtml(currentPeriod)}</h2>`);
    }
    const table = renderTable(section.rows);
    const heading = `${escapeRichHtml(parsed.icon)} ${escapeRichHtml(parsed.name)}`;
    if (TECHNICAL_OPEN_GROUPS.has(parsed.name)) {
      parts.push(`<h3>${heading}</h3>\n${table}`);
    } else {
      parts.push(`<details><summary>${heading}</summary>\n${table}\n</details>`);
    }
  }
  return parts;
}

function parseTechnicalHeading(heading) {
  const match = String(heading ?? "").match(/^(\S+) (Today|Last 7 days) — (.+)$/);
  if (!match) return null;
  return { icon: match[1], period: match[2], name: match[3] };
}

function renderTable(rows) {
  return `<table bordered striped>\n${rows.map(renderTableRow).join("\n")}\n</table>`;
}

function renderTableRow(row) {
  if (typeof row === "string") return `<tr><td colspan="2">${escapeRichHtml(row)}</td></tr>`;
  const segments = row?.segments ?? [];
  const primaryIndex = segments.findIndex((segment) => segment.style === "bold" || segment.style === "code");
  if (primaryIndex <= 0) return `<tr><td colspan="2">${renderInline(row)}</td></tr>`;
  const label = segments.slice(0, primaryIndex).map((segment) => escapeRichHtml(segment.text)).join("");
  const value = segments.slice(primaryIndex).map(renderSegment).join("");
  return `<tr><td>${label}</td><td>${value}</td></tr>`;
}

function renderInline(row) {
  if (typeof row === "string") return escapeRichHtml(row);
  return (row?.segments ?? []).map(renderSegment).join("");
}

function renderSegment(segment) {
  const text = escapeRichHtml(segment?.text);
  if (segment?.style === "bold") return `<b>${text}</b>`;
  if (segment?.style === "code") return `<code>${text}</code>`;
  return text;
}

export function escapeRichHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}
