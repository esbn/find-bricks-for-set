// Optional one-time DATA import. This app never reads a sibling at runtime.
import { cp, readFile, mkdir, access } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
const root = fileURLToPath(new URL("../", import.meta.url)),
  i = process.argv.indexOf("--from");
try {
  if (i < 0 || !process.argv[i + 1])
    throw Error("Usage: npm run setup:local -- --from /path/to/brick-finder");
  const source = resolve(process.argv[i + 1]),
    pkg = JSON.parse(await readFile(resolve(source, "package.json")));
  if (pkg.name !== "brick-finder") throw Error("Source is not brick-finder");
  const expected = JSON.parse(await readFile(resolve(root, "ldraw.lock.json"))),
    lock = JSON.parse(await readFile(resolve(source, "ldraw.lock.json")));
  if (lock.sha256 !== expected.sha256)
    throw Error(
      "LDraw versions differ; install this app independently instead",
    );
  for (const [from, to] of [
    ["dist/ldraw", "public/ldraw"],
    ["dist/search-index", "public/search-index"],
    [".cache/sam", ".cache/sam"],
    [".cache/yolo", ".cache/yolo"],
    [".cache/rebrickable", ".cache/rebrickable"],
  ]) {
    const target = resolve(root, to);
    try {
      await access(target);
      console.log("Keeping existing " + to);
      continue;
    } catch {}
    await mkdir(resolve(target, ".."), { recursive: true });
    await cp(resolve(source, from), target, {
      recursive: true,
      errorOnExist: true,
      force: false,
    });
    console.log("Copied installed data: " + to);
  }
  console.log(
    "Data imported into this repo. Run npm run setup:yolo to create its own Python environment, then npm run setup:sets.",
  );
} catch (e) {
  console.error(e.message);
  process.exitCode = 1;
}
