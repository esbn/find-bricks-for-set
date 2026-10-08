import { readFile } from "node:fs/promises";
import { partFamilies } from "./public/engine/part-families.mjs";
import { mappedCadPart } from "./public/cad-mapping.mjs";
export function expandInventory(
  database,
  number,
  { includeSpares = false } = {},
) {
  const counts = new Map(),
    warnings = [];
  function visit(set, multiplier, chain = []) {
    if (chain.includes(set) || chain.length > 20)
      throw Error("Circular/excessive nested inventory");
    const entry = database.latest[set],
      inv = entry && database.inventories[entry.id];
    if (!inv) {
      warnings.push("Missing inventory for " + set);
      return;
    }
    for (const [id, color, quantity, spare] of inv.parts) {
      if (spare && !includeSpares) continue;
      const key = id + ":" + color,
        old = counts.get(key) || { key, id, colorId: color, quantity: 0 };
      old.quantity += quantity * multiplier;
      if (!Number.isSafeInteger(old.quantity) || old.quantity > 100000)
        throw Error("Excessive inventory quantity");
      counts.set(key, old);
    }
    for (const [child, quantity] of inv.children)
      visit(child, multiplier * quantity, [...chain, set]);
  }
  visit(number, 1);
  return { lines: [...counts.values()], warnings };
}
export function mapRequirements(lines, database, catalogue) {
  const byId = new Map(catalogue.parts.map((p) => [p.id, p])),
    families = partFamilies(catalogue.parts);
  return lines.map((line) => {
    let base = line.id,
      printed = false;
    const seen = new Set();
    while (database.prints[base]) {
      if (seen.has(base)) throw Error("Circular print mapping");
      seen.add(base);
      base = database.prints[base];
      printed = true;
    }
    const exact = byId.get(line.id),
      mapped = byId.get(base) || exact,
      matchId = mapped ? mappedCadPart(mapped.id, byId, families) : null,
      color = database.colors[line.colorId];
    return {
      ...line,
      label: database.parts[line.id] || exact?.label || line.id,
      matchId,
      printed: printed || !!exact?.decorated,
      color: color || {
        id: line.colorId,
        name: "Unknown colour",
        rgb: null,
        isTrans: false,
      },
      mapping: matchId
        ? printed
          ? "print-base"
          : mapped.aliasOf
            ? "ldraw-redirect"
            : "shared-id"
        : "unsupported",
    };
  });
}
export function createSetStore(root, databaseOverride, catalogueOverride) {
  let pending;
  async function load() {
    if (databaseOverride)
      return { database: databaseOverride, catalogue: catalogueOverride };
    if (!pending)
      pending = Promise.all([
        readFile(new URL(".cache/set-data/database.json", root), "utf8"),
        readFile(new URL("public/ldraw/catalogue.json", root), "utf8"),
      ])
        .then(([db, cat]) => {
          const database = JSON.parse(db),
            catalogue = JSON.parse(cat);
          if (database.format !== "set-bricks-data" || database.version !== 1)
            throw Error("Set data is out of date");
          return { database, catalogue };
        })
        .catch((e) => {
          pending = undefined;
          throw Error(
            "Set data unavailable. Run npm run setup:sets and setup:ldraw. " +
              e.message,
          );
        });
    return pending;
  }
  return {
    async search(query) {
      const { database } = await load(),
        q = query.trim().toLowerCase(),
        tokens = q.split(/\s+/).filter(Boolean);
      if (!q) return [];
      return database.sets
        .filter((s) =>
          tokens.every((t) =>
            (s.number + " " + s.name).toLowerCase().includes(t),
          ),
        )
        .sort(
          (a, b) =>
            (b.number === q || b.number === q + "-1") -
              (a.number === q || a.number === q + "-1") ||
            b.year - a.year ||
            a.number.localeCompare(b.number),
        )
        .slice(0, 20);
    },
    async get(number) {
      const { database, catalogue } = await load();
      let set =
        database.sets.find((s) => s.number === number) ||
        database.sets.find((s) => s.number === number + "-1");
      if (!set)
        throw Object.assign(Error("Set not found in the installed catalogue"), {
          status: 404,
        });
      const expanded = expandInventory(database, set.number);
      return {
        set,
        requirements: mapRequirements(expanded.lines, database, catalogue),
        warnings: expanded.warnings,
        incomplete: expanded.warnings.length > 0,
        source: "Rebrickable bulk CSV",
        generated: database.generated,
      };
    },
  };
}
