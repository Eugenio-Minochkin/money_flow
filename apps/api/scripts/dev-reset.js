import { closeDb, migrate, pool } from "../src/db.js";
import { assertDevDatabase } from "../src/devSafety.js";
import { resetAndSeedDemoData } from "../src/devSeed.js";

try {
  assertDevDatabase();
  await migrate();
  const result = await resetAndSeedDemoData(pool);
  console.log(`Seeded demo user telegramUserId=${result.telegramUserId}`);
  console.log(`Created ${result.expenseCount} expenses, ${result.draftCount} drafts, ${result.plannedExpenseCount} planned expenses.`);
} finally {
  await closeDb();
}
