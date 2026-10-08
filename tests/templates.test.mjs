import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";
import { gzipSync } from "node:zlib";
import { createTemplateStore } from "../template-store.mjs";
test("template response contains only selected IDs; shared buckets remap correctly", async (t) => {
  const root = await mkdtemp(tmpdir() + "/set-templates-");
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(root + "/public/search-index", { recursive: true });
  await mkdir(root + "/public/ldraw");
  const write = (p, v) => writeFile(root + p, JSON.stringify(v));
  await write("/public/ldraw/catalogue.json", {
    sha256: "test",
    parts: [{ id: "a" }, { id: "b" }, { id: "c" }],
  });
  await write("/public/search-index/manifest.json", {
    sha256: "test",
    complete: true,
    masks: "masks.gz",
    views: [{ id: "a" }, { id: "b" }, { id: "c" }],
    nodes: [[0, 2], [1]],
  });
  await write("/public/search-index/surfaces.json", {
    sha256: "test",
    parts: { a: { count: 4 }, b: { count: 8 } },
  });
  await writeFile(
    root + "/public/search-index/masks.gz",
    gzipSync(Buffer.alloc(288 * 3, 7)),
  );
  const store = createTemplateStore(pathToFileURL(root + "/")),
    result = await store.get(["b", "missing"]);
  assert.deepEqual(result.views, [{ id: "b" }]);
  assert.deepEqual(result.nodes, [[0]]);
  assert.deepEqual(result.parts, [{ id: "b" }]);
  assert.deepEqual(Object.keys(result.surfaces), ["b"]);
  assert.deepEqual(result.unavailable, ["missing"]);
  assert.equal(Buffer.from(result.masks, "base64").length, 288);
  await assert.rejects(store.get(["../a"]), /Invalid/);
});
