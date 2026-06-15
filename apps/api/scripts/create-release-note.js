import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { closeDb, pool } from "../src/db.js";
import { normalizeReleaseNoteInput } from "../src/releaseNotesService.js";
import { createRepository } from "../src/repository.js";

export function parseReleaseNoteArgs(args) {
  const values = {};
  let isPublic = true;

  for (const arg of args) {
    if (arg === "--private") {
      isPublic = false;
      continue;
    }
    if (!arg.startsWith("--")) continue;
    const index = arg.indexOf("=");
    const key = index === -1 ? arg.slice(2) : arg.slice(2, index);
    const value = index === -1 ? "" : arg.slice(index + 1);
    values[key] = value;
  }

  const missing = [];
  if (!values.version) missing.push("--version");
  if (!values["title-ru"]) missing.push("--title-ru");
  if (!values["body-ru"]) missing.push("--body-ru");
  if (missing.length) {
    throw new Error(`Missing required arguments: ${missing.join(", ")}`);
  }

  return normalizeReleaseNoteInput({
    version: values.version,
    titleRu: values["title-ru"],
    titleEn: values["title-en"],
    bodyRu: values["body-ru"],
    bodyEn: values["body-en"],
    audience: values.audience,
    category: values.category,
    isPublic
  });
}

async function main() {
  const input = parseReleaseNoteArgs(process.argv.slice(2));
  const repository = createRepository(pool);
  const note = await repository.createReleaseNote(input);
  console.log(`Created release note ${note.id} ${note.version} (${note.audience})`);
}

if (process.argv[1] && resolve(fileURLToPath(import.meta.url)) === resolve(process.argv[1])) {
  main()
    .catch((error) => {
      console.error(error.message);
      process.exitCode = 1;
    })
    .finally(async () => {
      await closeDb();
    });
}
