import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { createHash } from "node:crypto";
const root = new URL("../", import.meta.url);
test("vendored browser kernels retain baseline content (one added final blank line allowed)", async () => {
  const baseline = JSON.parse(
    await readFile(new URL("ENGINE_BASELINE.json", root), "utf8"),
  );
  for (const entry of baseline.files.filter((e) =>
    e.target.startsWith("public/engine/"),
  )) {
    const bytes = await readFile(new URL(entry.target, root)),
      hash = (b) => createHash("sha256").update(b).digest("hex");
    assert.ok(
      hash(bytes) === entry.sha256 ||
        (bytes.at(-1) === 10 && hash(bytes.subarray(0, -1)) === entry.sha256),
      entry.target,
    );
  }
});
test("runtime modules have no sibling paths or developer-machine paths", async () => {
  for (const dir of ["public/", "public/engine/", "scripts/"])
    for (const file of await readdir(new URL(dir, root))) {
      if (!file.endsWith(".mjs") || file === "import-local-assets.mjs")
        continue;
      const text = await readFile(new URL(dir + file, root), "utf8");
      assert.doesNotMatch(
        text,
        /\/Users\/|\.\.\/brick-finder|from ['"][^'"]*brick-finder/,
      );
    }
});
