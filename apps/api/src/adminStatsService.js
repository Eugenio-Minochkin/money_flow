import { createTechnicalStatsService, formatTechnicalStats } from "./technicalStatsService.js";
import { createProductStatsService } from "./productStatsService.js";

export function createAdminStatsService({
  pool,
  now = () => new Date(),
  productStatsService,
  technicalStatsService
}) {
  const technical = technicalStatsService ?? createTechnicalStatsService({ pool, now });
  const product = productStatsService ?? createProductStatsService({ pool, now });
  return {
    getAdminStats() {
      return product.getProductStats();
    },
    getTechnicalStats() {
      return technical.getTechnicalStats();
    }
  };
}

// Kept as a compatibility export while Telegram command formatting is split.
export const formatAdminStats = formatTechnicalStats;

export function formatAdminMessageParts(sections, { maxLength = 3900 } = {}) {
  const rendered = sections.flatMap((section) => splitRenderedSection(section, maxLength));
  const parts = [];
  for (const section of rendered) {
    const current = parts.at(-1);
    if (current && current.html.length + 2 + section.html.length <= maxLength) {
      current.html += `\n\n${section.html}`;
      current.plainText += `\n\n${section.plainText}`;
    } else {
      parts.push({ ...section });
    }
  }
  return parts;
}

export function escapeTelegramHtml(value) {
  return String(value ?? "").replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

export function stripAllowedTelegramHtml(value) {
  return String(value ?? "")
    .replace(/<\/?(?:b|code)>/gi, "")
    .replaceAll("&lt;", "<").replaceAll("&gt;", ">").replaceAll("&amp;", "&");
}

function splitRenderedSection(section, maxLength) {
  const heading = String(section.heading ?? "");
  const rows = (section.rows ?? []).map(String);
  const chunks = [];
  let currentRows = [];
  for (const originalRow of rows.length > 0 ? rows : [""]) {
    const row = truncateRow(originalRow, Math.max(1, maxLength - heading.length - 16));
    const candidate = renderSection(heading, [...currentRows, row]);
    if (currentRows.length > 0 && candidate.html.length > maxLength) {
      chunks.push(renderSection(heading, currentRows));
      currentRows = [row];
    } else {
      currentRows.push(row);
    }
  }
  chunks.push(renderSection(heading, currentRows));
  return chunks;
}

function renderSection(heading, rows) {
  const safeHeading = escapeTelegramHtml(heading);
  const safeRows = rows.filter(Boolean).map(escapeTelegramHtml);
  return {
    html: [`<b>${safeHeading}</b>`, ...safeRows].join("\n"),
    plainText: [heading, ...rows.filter(Boolean)].join("\n")
  };
}

function truncateRow(row, maxLength) {
  return row.length <= maxLength ? row : `${row.slice(0, Math.max(0, maxLength - 1))}…`;
}
