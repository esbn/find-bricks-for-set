import { test } from "node:test";
import assert from "node:assert/strict";
import {
  allocate,
  candidateOptions,
  exportReport,
} from "../public/assignment.mjs";
import { colourDistance, estimateColour } from "../public/colour.mjs";
const requirement = (id, quantity = 1) => ({
  id,
  matchId: id,
  key: id + ":red",
  quantity,
  colorId: 4,
  color: { rgb: "C91A09", name: "Red" },
});
const region = (uid, scores) => ({
  uid,
  rgb: [201, 26, 9],
  scores: scores.map(([id, score]) => ({ id, score, visualScore: score })),
});
test("residual allocation finds the global optimum, not detection-order greedy", () => {
  const result = allocate(
    [
      region(1, [
        ["a", 0.95],
        ["b", 0.94],
      ]),
      region(2, [["a", 0.94]]),
    ],
    [requirement("a"), requirement("b")],
  );
  assert.equal(result.assignments.get(1).key, "b:red");
  assert.equal(result.assignments.get(2).key, "a:red");
});
test("surplus stays unassigned and confirmation reserves inventory quantity", () => {
  const pieces = [
    region(1, [["a", 0.95]]),
    region(2, [["a", 0.94]]),
    region(3, [["a", 0.93]]),
  ];
  pieces[2].confirmed = true;
  pieces[2].manualKey = "a:red";
  const result = allocate(pieces, [requirement("a")]);
  assert.equal(result.assignments.size, 1);
  assert.equal(result.assignments.get(3).confirmed, true);
  assert.deepEqual(result.coverage[0], {
    key: "a:red",
    required: 1,
    confirmed: 1,
    suggested: 0,
    notLocated: 0,
  });
  pieces[1].confirmed = true;
  pieces[1].manualKey = "a:red";
  assert.throws(() => allocate(pieces, [requirement("a")]), /exceed/);
});
test("manual unsupported selections remain uncertain until confirmed; rejected pieces never allocated", () => {
  const p = region(1, []),
    r = { ...requirement("a"), matchId: null };
  p.manualKey = r.key;
  assert.equal(allocate([p], [r]).assignments.get(1).ambiguous, true);
  p.rejected = true;
  assert.equal(allocate([p], [r]).assignments.size, 0);
});
test("weak shape, wrong colour, transparent colours and strong stud disagreements abstain", () => {
  const r = requirement("a");
  assert.equal(candidateOptions(region(1, [["a", 0.81]]), [r]).length, 0);
  const p = region(1, [["a", 0.97]]);
  p.rgb = [0, 85, 191];
  assert.equal(candidateOptions(p, [r]).length, 0);
  assert.equal(
    candidateOptions(p, [r], { matchColours: false })[0].ambiguous,
    true,
  );
  p.rgb = [201, 26, 9];
  r.color.isTrans = true;
  assert.equal(candidateOptions(p, [r]).length, 0);
  r.color.isTrans = false;
  p.scores[0].surface = { penalty: 0.2 };
  assert.equal(candidateOptions(p, [r]).length, 0);
});
test("printed parts and competing near-ties are uncertain", () => {
  const r = requirement("a");
  r.printed = true;
  assert.equal(
    candidateOptions(region(1, [["a", 0.99]]), [r])[0].ambiguous,
    true,
  );
  assert.equal(
    allocate(
      [
        region(1, [
          ["a", 0.95],
          ["b", 0.95],
        ]),
      ],
      [requirement("a"), requirement("b")],
    ).assignments.get(1).ambiguous,
    true,
  );
});
test("reports exclude images and distinguish suggestions from confirmation", () => {
  const p = region(1, [["a", 0.95]]);
  p.pixels = [1, 2, 3];
  const report = exportReport(
    { number: "test", name: "test" },
    [p],
    [requirement("a")],
    allocate([p], [requirement("a")]),
  );
  assert.equal(report.regions[0].state, "suggested");
  assert.equal(report.requirements[0].confirmed, 0);
  assert.deepEqual(Object.keys(report.regions[0]).sort(), [
    "requirementKey",
    "state",
    "uid",
  ]);
});
test("Lab colour estimation rejects unknown and tolerates dark holes/highlights", () => {
  assert.equal(colourDistance([201, 26, 9], "C91A09"), 0);
  assert.equal(colourDistance(null, "C91A09"), null);
  const values = Array.from({ length: 100 }, (_, i) =>
    i < 20 ? [0, 0, 0, 255] : i > 89 ? [255, 255, 255, 255] : [201, 26, 9, 255],
  ).flat();
  assert.deepEqual(
    estimateColour(
      { data: Uint8Array.from(values) },
      Array.from({ length: 100 }, (_, i) => i),
    ),
    [201, 26, 9],
  );
});
