import { test } from "node:test";
import assert from "node:assert/strict";
import {
  expandInventory,
  mapRequirements,
  createSetStore,
} from "../set-data.mjs";
const db = () => ({
  sets: [{ number: "set-1", name: "Practice", year: 2024 }],
  latest: { "set-1": { id: 1 }, fig: { id: 2 } },
  inventories: {
    1: {
      parts: [
        ["3001", 4, 2, false],
        ["3001", 4, 1, true],
      ],
      children: [["fig", 2]],
    },
    2: {
      parts: [
        ["3001", 4, 1, false],
        ["unknown", 1, 1, false],
      ],
      children: [],
    },
  },
  prints: { "3001p01": "3001" },
  parts: { 3001: "Brick" },
  colors: { 4: { id: 4, name: "Red", rgb: "C91A09" } },
});
const cat = { parts: [{ id: "3001", kind: "Part", label: "Brick" }] };
test("documented LDraw redirects are mapped, but undocumented aliases are not guessed", () => {
  const catalogue = {
    parts: [
      ...cat.parts,
      { id: "old", alias: true, aliasOf: "3001" },
      { id: "unknown-alias", alias: true },
    ],
  };
  const lines = ["old", "unknown-alias"].map((id) => ({
    id,
    key: id,
    colorId: 4,
    quantity: 1,
  }));
  const result = mapRequirements(lines, db(), catalogue);
  assert.equal(result[0].matchId, "3001");
  assert.equal(result[0].mapping, "ldraw-redirect");
  assert.equal(result[1].matchId, null);
});
test("nested minifig quantities expand and aggregate; spare parts excluded", () => {
  const { lines } = expandInventory(db(), "set-1");
  assert.equal(lines.find((l) => l.id === "3001").quantity, 4);
  assert.equal(lines.find((l) => l.id === "unknown").quantity, 2);
  assert.equal(
    expandInventory(db(), "set-1", { includeSpares: true }).lines[0].quantity,
    5,
  );
});
test("missing children reported; cycles and excessive counts rejected", () => {
  const d = db();
  d.inventories[1].children.push(["missing", 1]);
  assert.match(expandInventory(d, "set-1").warnings[0], /missing/);
  d.inventories[2].children = [["set-1", 1]];
  assert.throws(() => expandInventory(d, "set-1"), /Circular/);
  d.inventories[2].children = [];
  d.inventories[1].parts[0][2] = 100001;
  assert.throws(() => expandInventory(d, "set-1"), /Excessive/);
});
test("mapping keeps unsupported lines and uses documented print parents", () => {
  const mapped = mapRequirements(
    [
      { id: "3001p01", colorId: 4, key: "print", quantity: 1 },
      { id: "unknown", colorId: 99, key: "missing", quantity: 1 },
    ],
    db(),
    cat,
  );
  assert.equal(mapped[0].matchId, "3001");
  assert.equal(mapped[0].printed, true);
  assert.equal(mapped[1].matchId, null);
  assert.equal(mapped[1].color.rgb, null);
});
test("set lookup accepts bare number and never silently selects unknown inventory", async () => {
  const store = createSetStore(null, db(), cat);
  assert.equal((await store.get("set")).set.number, "set-1");
  assert.equal((await store.search("practice")).length, 1);
  await assert.rejects(store.get("missing"), /not found/);
});
