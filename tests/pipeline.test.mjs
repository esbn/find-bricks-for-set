import { test } from "node:test";
import assert from "node:assert/strict";
import { createCanvas } from "@napi-rs/canvas";
import {
  validateDiagnostics,
  stageCount,
  paintMask,
  outlineMask,
} from "../public/pipeline-view.mjs";
const fixture = () => ({
  width: 4,
  height: 3,
  total: 2,
  truncated: false,
  proposals: [
    {
      id: 1,
      raw: { box: [0, 0, 4, 3], area: 10, runs: [0, 5, 7, 5] },
      cleaned: { box: [0, 0, 4, 3], area: 10, runs: [0, 5, 7, 5] },
      decision: "retained",
      quality: 0.95,
    },
    {
      id: 2,
      raw: { box: [1, 1, 2, 1], area: 2, runs: [5, 2] },
      cleaned: { box: [1, 1, 2, 1], area: 2, runs: [5, 2] },
      decision: "rejected",
      reason: "size",
      quality: 0.9,
    },
  ],
});
test("SAM contours are opaque, trace holes, and leave mask interiors untouched", () => {
  const canvas = createCanvas(140, 140), ctx = canvas.getContext("2d");
  const mask = { runs: [8, 5, 15, 5, 22, 2, 25, 2, 29, 5, 36, 5] };
  ctx.globalAlpha = .25;
  const initialAlpha = ctx.globalAlpha;
  outlineMask(ctx, mask, 7, 7, 140, 140, "#4cf5d5", 2);
  const pixel = (x,y) => [...ctx.getImageData(x,y,1,1).data];
  assert.equal(pixel(20,30)[3], 255); // exterior edge
  assert.equal(pixel(60,70)[3], 255); // hole edge
  assert.equal(pixel(70,70)[3], 0); // hole centre
  assert.equal(pixel(40,40)[3], 0); // filled region's interior: no scanline seams
  assert.equal(pixel(10,10)[3], 0); // exterior background
  assert.equal(ctx.globalAlpha, initialAlpha); // caller's drawing state preserved
});
test("pipeline counts distinguish proposals, rejected masks and retained regions", () => {
  const d = validateDiagnostics(fixture()),
    s = {
      method: "YOLO + MobileSAM",
      diagnostics: d,
      brickDetections: [{}, {}],
      components: [{}],
    };
  assert.equal(stageCount("yolo", s, []), 2);
  assert.equal(stageCount("raw", s, []), 2);
  assert.equal(stageCount("cleaned", s, []), 2);
  assert.equal(stageCount("rejected", s, []), 1);
  assert.equal(stageCount("retained", s, []), 1);
  assert.equal(stageCount("yolo", { ...s, method: "MobileSAM" }, []), null);
  assert.equal(stageCount("raw", {}, []), null);
});
test("diagnostic runs, dimensions, area and proposal identifiers are validated", () => {
  assert.equal(validateDiagnostics(null), null);
  for (const mutate of [
    (d) => (d.width = 0),
    (d) => (d.proposals[0].raw.runs = [0, 13]),
    (d) => (d.proposals[0].raw.area = 11),
    (d) => (d.proposals[1].id = 1),
    (d) => (d.proposals[0].cleaned.box = [0, 0, 5, 3]),
  ]) {
    const d = fixture();
    mutate(d);
    assert.throws(() => validateDiagnostics(d), /Invalid/);
  }
});
test("diagnostic mask painting preserves holes and scales to photo coordinates", () => {
  const canvas = createCanvas(8, 6),
    ctx = canvas.getContext("2d");
  paintMask(ctx, fixture().proposals[0].raw, 4, 3, 8, 6, "#ff0000");
  const data = ctx.getImageData(0, 0, 8, 6).data;
  assert.equal(data[(0 * 8 + 0) * 4], 255);
  assert.equal(data[(2 * 8 + 2) * 4 + 3], 0);
  assert.equal(data[(2 * 8 + 6) * 4], 255);
});
