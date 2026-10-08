// Optional real-browser integration test. Requires installed CAD/index assets.
// TEST_PHOTO adds local model inference; never includes a personal photo in Git.
import { chromium } from "playwright";
import assert from "node:assert/strict";
import { once } from "node:events";
import { createApp } from "../server.mjs";
const server = createApp();
server.listen(0, "127.0.0.1");
await once(server, "listening");
let browser, page;
const errors = [],
  external = [],
  scopes = [];
try {
  browser = await chromium.launch({
    headless: true,
    ...(process.env.CHROME_PATH
      ? { executablePath: process.env.CHROME_PATH }
      : {}),
  });
  page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("request", (r) => {
    if (!r.url().startsWith("http://127.0.0.1:")) external.push(r.url());
    if (r.url().endsWith("/api/templates"))
      scopes.push(JSON.parse(r.postData()).ids);
  });
  await page.addInitScript(() => {
    const originalFetch = window.fetch;
    window.fetch = async (...args) => {
      const response = await originalFetch(...args);
      if (args[0] === "/api/segment" && response.ok)
        response
          .clone()
          .text()
          .then((body) => {
            window.__segmentation = body
              .trim()
              .split("\n")
              .map(JSON.parse)
              .find((m) => m.type === "result");
          });
      return response;
    };
    const W = window.Worker;
    window.Worker = class extends W {
      constructor(...args) {
        super(...args);
        this.addEventListener("message", ({ data }) => {
          if (data.type === "result") window.__search = data.result;
        });
      }
    };
  });
  await page.goto("http://127.0.0.1:" + server.address().port);
  await page.waitForFunction(
    () => !document.querySelector("#setStatus").textContent.includes("Loading"),
  );
  await page.locator("#demo").click();
  await page.waitForFunction(
    () => !document.querySelector("#identify").disabled,
  );
  await page.locator("#identify").click();
  assert.equal(await page.locator("#stop").isVisible(), true);
  await page.waitForFunction(
    () =>
      document
        .querySelector("#status")
        .textContent.startsWith("Search complete"),
    null,
    { timeout: 60000 },
  );
  assert.deepEqual(scopes[0].sort(), ["3020", "3033", "3795"]);
  assert.equal(await page.locator("#regions button").count(), 5);
  assert.equal(await page.locator('[data-stage="yolo"]').isDisabled(), true);
  const matchesBefore = await page
    .locator("#photoCanvas")
    .evaluate((c) => c.toDataURL());
  await page.locator('[data-stage="original"]').click();
  assert.notEqual(
    await page.locator("#photoCanvas").evaluate((c) => c.toDataURL()),
    matchesBefore,
  );
  await page.locator('[data-stage="retained"]').click();
  assert.match(
    await page.locator("#pipelineSummary").textContent(),
    /regardless of set/,
  );
  await page.locator('[data-stage="matches"]').click();
  assert.equal(
    await page.locator("#photoCanvas").evaluate((c) => c.toDataURL()),
    matchesBefore,
  );
  assert.match(
    await page.locator("#coverageSummary").textContent(),
    /3 suggested/,
  );
  const counts = await page.evaluate(() =>
    window.__search.candidates.map((r) => r.surface.count),
  );
  assert.deepEqual(counts, [60, 60, 12, 8, 4]);
  await page.waitForFunction(
    () => !document.querySelector("#resetView").disabled,
  );
  const cad = page.locator("#cadCanvas"),
    crop = page.locator("#cropCanvas"),
    before = await cad.evaluate((c) => c.toDataURL()),
    cropBefore = await crop.evaluate((c) => c.toDataURL());
  await cad.focus();
  await page.keyboard.press("ArrowRight");
  assert.notEqual(await cad.evaluate((c) => c.toDataURL()), before);
  assert.equal(await crop.evaluate((c) => c.toDataURL()), cropBefore);
  await page.keyboard.press("Home");
  assert.equal(await cad.evaluate((c) => c.toDataURL()), before);
  await page.locator("#confirm").click();
  assert.equal(await page.locator("#reviewState").textContent(), "Confirmed");
  await page.locator("#regions button").nth(1).click();
  await page.locator("#corrections summary").click();
  await page.locator("#manualPart").selectOption("3033:0055BF");
  await page.locator("#confirm").click();
  assert.match(await page.locator("#status").textContent(), /exceed/);
  assert.notEqual(
    await page.locator("#reviewState").textContent(),
    "Confirmed",
  );
  await page.locator("#reject").click();
  assert.equal(await page.locator("#reviewState").textContent(), "Excluded");
  await page.locator("#reject").click();
  await page.locator("#regions button").first().click();
  await page.locator("#confirm").click();
  assert.match(
    await page.locator("#coverageSummary").textContent(),
    /0 confirmed/,
  );
  await page.locator("#nextCandidate").click();
  assert.match(
    await page.locator("#reviewNote").textContent(),
    /Manual selection/,
  );
  await page.locator("#face").selectOption("bottom");
  await page.waitForFunction(
    () => !document.querySelector("#resetView").disabled,
  );
  assert.equal(await page.locator("#face").inputValue(), "bottom");
  const downloadPromise = page.waitForEvent("download");
  await page.locator("#export").click();
  const download = await downloadPromise;
  assert.equal(download.suggestedFilename(), "workshop-demo-brick-review.json");
  await page.locator(".requirement").first().click();
  assert.equal(await page.locator("#clearFilter").isVisible(), true);
  await page.locator("#clearFilter").click();
  const bounds = await page.locator("#photoCanvas").boundingBox();
  await page.mouse.click(
    bounds.x + (bounds.width * 527) / 900,
    bounds.y + (bounds.height * 145) / 560,
  );
  assert.match(await page.locator("#reviewTitle").textContent(), /piece 3/);
  const testSet = process.env.TEST_SET || "11013";
  await page.locator("#setQuery").fill(testSet);
  await page.locator("#searchSets").click();
  await page.locator("#setResults button").first().click();
  await page.waitForFunction((number) =>
    document.querySelector("#selectedSet").textContent.startsWith(number + "-1"),
    testSet,
  );
  if (process.env.TEST_PHOTO) {
    await page.locator("#imageFile").setInputFiles(process.env.TEST_PHOTO);
    await page.waitForFunction(
      () => !document.querySelector("#identify").disabled,
    );
    await page.locator(".settings summary").click();
    await page.locator("#method").selectOption("yolo");
    await page.locator("#identify").click();
    await page.waitForFunction(
      () =>
        document
          .querySelector("#status")
          .textContent.startsWith("Search complete"),
      null,
      { timeout: 600000 },
    );
    const official = await (
        await page.request.get(new URL("/api/sets/" + testSet, page.url()).href)
      ).json(),
      allowed = new Set(
        official.requirements.map((r) => r.matchId).filter(Boolean),
      );
    assert.ok(scopes[1].every((id) => allowed.has(id)));
    console.log(await page.locator("#status").textContent());
    await page.waitForFunction(() => window.__segmentation?.diagnostics);
    const d = await page.evaluate(() => window.__segmentation.diagnostics),
      rawCount = d.proposals.filter((p) => p.raw).length,
      rejected = d.proposals.filter((p) => p.decision === "rejected");
    const tiling = await page.evaluate(() => window.__segmentation.tiling);
    assert.ok(tiling?.localSamCrops > 0);
    assert.equal(tiling.mergedProposals, d.total);
    if (process.env.TEST_PHOTO.endsWith("IMG_4691.jpg")) {
      assert.equal(tiling.sourceWidth, 4284);
      assert.equal(tiling.sourceHeight, 5712);
      assert.equal(tiling.tiles, 20);
    }
    console.log(`Source tiling: ${tiling.sourceWidth}×${tiling.sourceHeight}, ${tiling.tiles} tiles, ${tiling.rawProposals} raw / ${tiling.mergedProposals} merged proposals.`);
    const snapshot = await page
        .locator("#photoCanvas")
        .evaluate((c) => c.toDataURL()),
      coverage = await page.locator("#coverageSummary").textContent();
    for (const stage of [
      "original",
      "yolo",
      "raw",
      "cleaned",
      "rejected",
      "retained",
      "features",
      "matches",
    ]) {
      const b = page.locator(`[data-stage="${stage}"]`);
      assert.equal(await b.isDisabled(), false);
      await b.click();
      assert.equal(await b.getAttribute("aria-pressed"), "true");
    }
    assert.equal(
      await page.locator("#photoCanvas").evaluate((c) => c.toDataURL()),
      snapshot,
    );
    assert.equal(
      await page.locator("#coverageSummary").textContent(),
      coverage,
    );
    assert.match(
      await page.locator('[data-stage="raw"]').textContent(),
      new RegExp(`\\(${rawCount}\\)`),
    );
    if (rejected.length) {
      // High-resolution diagnostic proposals may be near the photo's bottom;
      // keep the entire canvas visible for coordinate-based click inspection.
      await page.setViewportSize({ width: 1440, height: 4000 });
      await page.locator('[data-stage="rejected"]').click();
      await page.locator("#photoCanvas").scrollIntoViewIfNeeded();
      const mask = rejected[0].cleaned || rejected[0].raw;
      let start = 0,
        length = 0;
      for (let i = 0; i < mask.runs.length; i += 2)
        if (mask.runs[i + 1] > length) {
          start = mask.runs[i];
          length = mask.runs[i + 1];
        }
      const key = start + Math.floor(length / 2),
        bounds = await page.locator("#photoCanvas").boundingBox();
      await page.mouse.click(
        bounds.x + (((key % d.width) + 0.5) * bounds.width) / d.width,
        bounds.y +
          ((Math.floor(key / d.width) + 0.5) * bounds.height) / d.height,
      );
      assert.match(
        await page.locator("#pipelineSummary").textContent(),
        /Proposal P\d+/,
      );
      await page.locator('[data-stage="matches"]').click();
      await page.setViewportSize({ width: 1440, height: 1000 });
    }
    console.log(
      `Pipeline views passed: ${d.total} proposals, ${rejected.length} rejected; mask inspection and matching-state invariance.`,
    );
    // Simulate an older persistent backend: retained regions cannot recreate
    // discarded/raw masks. Show an explanation and don't cache the old result.
    const complete = await page.evaluate(() => window.__segmentation);
    let requests = 0;
    await page.route("**/api/segment", (route) => {
      const response = structuredClone(complete);
      if (++requests === 1) delete response.diagnostics;
      return route.fulfill({ contentType: "application/x-ndjson", body: JSON.stringify(response) + "\n" });
    });
    await page.locator("#imageFile").setInputFiles(process.env.TEST_PHOTO);
    await page.waitForFunction(() => !document.querySelector("#identify").disabled);
    await page.locator("#identify").click();
    await page.waitForFunction(() => document.querySelector("#status").textContent.startsWith("Search complete"));
    assert.equal(await page.locator('[data-stage="raw"]').isDisabled(), true);
    assert.match(await page.locator("#pipelineSummary").textContent(), /Restart the app server/);
    assert.match(await page.locator('[data-stage="cleaned"]').getAttribute("title"), /Restart/);
    await page.locator("#identify").click();
    await page.waitForFunction(() => document.querySelector("#status").textContent.startsWith("Search complete"));
    assert.equal(requests, 2);
    for (const stage of ["raw", "cleaned", "rejected"])
      assert.equal(await page.locator(`[data-stage="${stage}"]`).isDisabled(), false);
    await page.unroute("**/api/segment");
    console.log("Legacy backend explanation and fresh diagnostic retry passed.");
  }
  await page.setViewportSize({ width: 390, height: 844 });
  assert.equal(
    await page.evaluate(
      () => document.documentElement.scrollWidth > innerWidth,
    ),
    false,
  );
  assert.deepEqual(errors, []);
  assert.deepEqual(external, []);
  console.log(
    "Browser smoke passed: stud counts, closed-set scope, progress, quantity caps, CAD rotation/reset, manual correction, export, mask hit-testing and responsive layout.",
  );
} finally {
  await browser?.close();
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
}
