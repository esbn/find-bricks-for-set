import { mkdir, readFile, writeFile, rename, stat } from "node:fs/promises";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { rows } from "./prevalence.mjs";
const root = fileURLToPath(new URL("../", import.meta.url)),
  cache = resolve(root, ".cache/rebrickable"),
  refresh = process.argv.includes("--refresh");
const tables = {
  sets: ["set_num", "name", "year", "num_parts"],
  parts: ["part_num", "name"],
  colors: ["id", "name", "rgb", "is_trans"],
  inventories: ["id", "version", "set_num"],
  inventory_parts: [
    "inventory_id",
    "part_num",
    "color_id",
    "quantity",
    "is_spare",
  ],
  inventory_minifigs: ["inventory_id", "fig_num", "quantity"],
  inventory_sets: ["inventory_id", "set_num", "quantity"],
  part_relationships: ["rel_type", "child_part_num", "parent_part_num"],
};
try {
  await mkdir(cache, { recursive: true });
  const sources = [];
  for (const name of Object.keys(tables)) {
    const file = resolve(cache, name + ".csv.gz"),
      url = `https://cdn.rebrickable.com/media/downloads/${name}.csv.gz`;
    let exists = false;
    try {
      exists = (await stat(file)).size > 0;
    } catch {}
    let lastModified = null;
    if (!exists || refresh) {
      console.log("Downloading " + name + "…");
      const r = await fetch(url, { signal: AbortSignal.timeout(120000) });
      if (!r.ok) throw Error(`${name}: HTTP ${r.status}`);
      const bytes = Buffer.from(await r.arrayBuffer());
      if (
        bytes.length > 100 * 1024 * 1024 ||
        bytes[0] !== 31 ||
        bytes[1] !== 139
      )
        throw Error("Invalid gzip table");
      await writeFile(file + ".tmp", bytes);
      await rename(file + ".tmp", file);
      lastModified = r.headers.get("last-modified");
    }
    sources.push({
      name,
      url,
      lastModified,
      sha256: createHash("sha256")
        .update(await readFile(file))
        .digest("hex"),
    });
  }
  const database = {
    format: "set-bricks-data",
    version: 1,
    generated: new Date().toISOString(),
    sources,
    sets: [],
    parts: {},
    colors: {},
    latest: {},
    inventories: {},
    prints: {},
  };
  for await (const r of rows(resolve(cache, "sets.csv.gz"), tables.sets))
    database.sets.push({
      number: r.set_num,
      name: r.name,
      year: Number(r.year),
      numParts: Number(r.num_parts),
    });
  for await (const r of rows(resolve(cache, "parts.csv.gz"), tables.parts))
    database.parts[r.part_num] = r.name;
  for await (const r of rows(resolve(cache, "colors.csv.gz"), tables.colors))
    database.colors[r.id] = {
      id: Number(r.id),
      name: r.name,
      rgb: r.rgb,
      isTrans: r.is_trans.toLowerCase() === "true",
    };
  for await (const r of rows(
    resolve(cache, "inventories.csv.gz"),
    tables.inventories,
  )) {
    const id = Number(r.id),
      version = Number(r.version),
      old = database.latest[r.set_num];
    if (!Number.isInteger(id) || !Number.isInteger(version))
      throw Error("Invalid inventory");
    if (
      !old ||
      version > old.version ||
      (version === old.version && id > old.id)
    )
      database.latest[r.set_num] = { id, version };
  }
  const selected = new Set(Object.values(database.latest).map((v) => v.id));
  for (const id of selected)
    database.inventories[id] = { parts: [], children: [] };
  let n = 0;
  for await (const r of rows(
    resolve(cache, "inventory_parts.csv.gz"),
    tables.inventory_parts,
  )) {
    const inv = database.inventories[r.inventory_id];
    if (inv) {
      const q = Number(r.quantity),
        color = Number(r.color_id);
      if (!Number.isInteger(q) || q < 0 || !Number.isInteger(color))
        throw Error("Invalid inventory part");
      if (q)
        inv.parts.push([
          r.part_num,
          color,
          q,
          r.is_spare.toLowerCase() === "true",
        ]);
    }
    if (++n % 500000 === 0) console.log(n.toLocaleString() + " inventory rows");
  }
  for (const [table, key] of [
    ["inventory_minifigs", "fig_num"],
    ["inventory_sets", "set_num"],
  ])
    for await (const r of rows(
      resolve(cache, table + ".csv.gz"),
      tables[table],
    )) {
      const inv = database.inventories[r.inventory_id],
        quantity = Number(r.quantity);
      if (!Number.isSafeInteger(quantity) || quantity < 0)
        throw Error("Invalid nested inventory quantity");
      if (inv && quantity > 0) inv.children.push([r[key], quantity]);
    }
  for await (const r of rows(
    resolve(cache, "part_relationships.csv.gz"),
    tables.part_relationships,
  ))
    if (r.rel_type === "P")
      database.prints[r.child_part_num] = r.parent_part_num;
  const dir = resolve(root, ".cache/set-data");
  await mkdir(dir, { recursive: true });
  await writeFile(resolve(dir, "database.tmp"), JSON.stringify(database));
  await rename(resolve(dir, "database.tmp"), resolve(dir, "database.json"));
  console.log(
    `Set data ready: ${database.sets.length} sets; ${selected.size} latest set/minifigure inventories. Runtime lookup is offline.`,
  );
} catch (e) {
  console.error(e.message);
  process.exitCode = 1;
}
