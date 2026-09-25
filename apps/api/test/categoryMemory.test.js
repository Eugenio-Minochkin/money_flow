import test from "node:test";
import assert from "node:assert/strict";
import { createCategoryMemoryLookup } from "../src/categoryMemory.js";

const evidence = (id, category = "sport_activities", eligible = true) => ({ draft_id: String(id), category_slug: category, eligible });
function harness(rows) {
  const queries = [];
  const releases = [];
  const client = { query: async (query) => { queries.push(query); return { rows }; }, release: (error) => releases.push(error) };
  return { lookup: createCategoryMemoryLookup({ connect: async () => client }), queries, releases };
}

test("category memory requires three distinct human confirmations and unanimous current categories", async () => {
  for (const [rows, expected] of [
    [[evidence(1), evidence(2), evidence(3)], "sport_activities"],
    [[evidence(1), evidence(2)], null],
    [[evidence(1), evidence(1), evidence(2)], null],
    [[evidence(1), evidence(2), evidence(3, "gear")], null],
    [[evidence(1), evidence(2), evidence(3), evidence(4, "gear", false)], null],
    [[evidence(1), evidence(2), evidence(3, "sport_activities", false)], null],
    [[evidence(1, "other"), evidence(2, "other"), evidence(3, "other")], null],
    [Array.from({ length: 101 }, (_, i) => evidence(i)), null]
  ]) {
    const { lookup, releases } = harness(rows);
    assert.equal(await lookup({ userId: 7, description: "J3" }), expected);
    assert.equal(releases.length, 1);
  }
});

test("category memory parameters use internal user scope and never cache a previous hint", async () => {
  const rows = [evidence(1), evidence(2), evidence(3)];
  const { lookup, queries } = harness(rows);
  assert.equal(await lookup({ userId: 7, description: "J3" }), "sport_activities");
  rows.pop();
  assert.equal(await lookup({ userId: 7, description: "J3" }), null);
  await lookup({ userId: 8, description: "J3" });
  assert.deepEqual(queries.map((q) => q.values), [["7", "J3"], ["7", "J3"], ["8", "J3"]]);
  assert.match(queries[0].text, /LIMIT 101/);
});

test("category memory abstains on invalid inputs, connection errors and query errors", async () => {
  const { lookup, queries } = harness([]);
  for (const input of [{ userId: null, description: "J3" }, { userId: "bad", description: "J3" }, { userId: 7, description: "x".repeat(161) }]) {
    assert.equal(await lookup(input), null);
  }
  assert.equal(queries.length, 0);
  assert.equal(await createCategoryMemoryLookup({ connect: async () => { throw new Error("private detail"); } })({ userId: 7, description: "J3" }), null);
  let destroyed;
  const failed = createCategoryMemoryLookup({ connect: async () => ({
    query: async () => { throw new Error("private detail"); }, release: (value) => { destroyed = value; }
  }) });
  assert.equal(await failed({ userId: 7, description: "J3" }), null);
  assert.equal(destroyed, true);
});

test("category memory releases a late connection and bounds a stalled query", async () => {
  let lateRelease = false;
  const late = createCategoryMemoryLookup({ connect: async () => {
    await new Promise((resolve) => setTimeout(resolve, 130));
    return { release: () => { lateRelease = true; } };
  } });
  assert.equal(await late({ userId: 7, description: "J3" }), null);
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(lateRelease, true);
  let destroyed = false;
  const stuck = createCategoryMemoryLookup({ connect: async () => ({
    query: () => new Promise(() => {}), release: (value) => { destroyed = value; }
  }) });
  assert.equal(await stuck({ userId: 7, description: "J3" }), null);
  assert.equal(destroyed, true);
});
