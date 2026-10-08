import { test } from "node:test";
import assert from "node:assert/strict";
import { descriptor } from "../public/engine/matching.mjs";
import {
  surfaceFromDetections,
  surfaceFromTubes,
  surfaceAgreement,
} from "../public/engine/surface-features.mjs";
import { HNSW } from "../public/engine/hnsw.mjs";
import {
  loadIndex,
  feature,
  pack,
  searchIndex,
} from "../public/engine/view-index.mjs";
const rectangle = (x, y, w, h, width) =>
  Array.from(
    { length: w * h },
    (_, i) => (y + Math.floor(i / w)) * width + x + (i % w),
  );
test("6 × 10 visible studs conflict with a smooth CAD surface", () => {
  const points = Array.from({ length: 60 }, (_, i) => ({
      x: 20 + (i % 6) * 20,
      y: 20 + Math.floor(i / 6) * 20,
      radius: 6,
      confidence: 0.95,
    })),
    observed = surfaceFromDetections(points);
  assert.equal(observed.count, 60);
  assert.deepEqual(observed.grid, [6, 10]);
  assert.ok(
    surfaceAgreement(observed, { known: true, groups: [] }).penalty > 0.5,
  );
  assert.equal(
    surfaceAgreement(observed, {
      known: true,
      groups: [{ kind: "studs", face: "top", count: 60, grid: [6, 10] }],
    }).penalty,
    0,
  );
});
test("complete rectangular underside with three tubes infers eight hidden studs", () => {
  const pixels = rectangle(40, 40, 80, 40, 200),
    tubes = [60, 80, 100].map((x) => ({
      x,
      y: 60,
      radius: 6,
      confidence: 0.9,
    })),
    observed = surfaceFromTubes(tubes, pixels, 200);
  assert.ok(observed);
  assert.equal(observed.count, 3);
  assert.equal(observed.inferredStudCount, 8);
  assert.deepEqual(observed.inferredStudGrid, [2, 4]);
  assert.equal(
    surfaceFromTubes(tubes, rectangle(40, 40, 130, 40, 200), 200),
    null,
  );
});
test("search never returns a global part outside the requested inventory, and reports progress", async () => {
  const pixels = rectangle(10, 10, 20, 40, 80),
    mask = descriptor(pixels, 80),
    bytes = Buffer.concat([pack(mask), pack(mask)]),
    graph = new HNSW();
  graph.add(feature(mask));
  const manifest = {
      format: "brick-view-index",
      version: 1,
      complete: true,
      sha256: "test",
      views: [
        { id: "set-part", elevation: 90, yaw: 0 },
        { id: "foreign-part", elevation: 90, yaw: 0 },
      ],
      nodes: [[0, 1]],
    },
    index = loadIndex(manifest, graph.serialize(), bytes, "test"),
    progress = [];
  const result = await searchIndex({
    index,
    components: [{ pixels, box: [10, 10, 20, 40], area: pixels.length }],
    width: 80,
    ids: ["set-part"],
    commonPrior: false,
    onProgress: (p) => progress.push(p),
  });
  assert.deepEqual(
    result.candidates[0].scores.map((s) => s.id),
    ["set-part"],
  );
  assert.equal(result.libraryParts, 1);
  assert.equal(result.compared, 1);
  assert.equal(progress[0].completed, 1);
});
