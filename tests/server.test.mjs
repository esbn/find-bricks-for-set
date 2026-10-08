import { test } from "node:test";
import assert from "node:assert/strict";
import { createApp } from "../server.mjs";
test("local endpoints enforce request boundaries and do not expose source or private assets", async (t) => {
  let received;
  const server = createApp({
    sam: {
      status: () => ({ available: true, yoloAvailable: true, busy: false }),
      close() {},
      async segment(payload, { onProgress }) {
        received = payload;
        onProgress({ type: "progress", message: "Detecting studs" });
        return { type: "result", width: 1, height: 1, components: [] };
      },
    },
    sets: {
      search: async () => [{ number: "x-1" }],
      get: async (n) => ({ set: { number: n }, requirements: [] }),
    },
    templates: {
      get: async (ids) => {
        if (!Array.isArray(ids))
          throw Object.assign(Error("Invalid IDs"), { status: 400 });
        return { views: ids.map((id) => ({ id })) };
      },
    },
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const base = "http://127.0.0.1:" + server.address().port,
    post = (route, body, headers = {}) =>
      fetch(base + route, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...headers },
        body: JSON.stringify(body),
      });
  assert.equal(
    (await (await fetch(base + "/api/sets?q=x")).json()).sets[0].number,
    "x-1",
  );
  assert.equal((await fetch(base + "/")).status, 200);
  for (const route of [
    "/server.mjs",
    "/.cache/set-data/database.json",
    "/.venv-sam/bin/python",
    "/../package.json",
  ])
    assert.equal((await fetch(base + route)).status, 404);
  assert.equal((await post("/api/templates", null)).status, 400);
  assert.equal(
    (
      await post(
        "/api/templates",
        { ids: ["3001"] },
        { Origin: "https://untrusted.example" },
      )
    ).status,
    403,
  );
  assert.equal(
    (await post("/api/segment", { image: "!", density: 16, mode: "yolo" }))
      .status,
    400,
  );
  const response = await post("/api/segment", {
    image: "AAAA",
    density: 16,
    mode: "yolo",
  });
  const stream = await response.text();
  assert.match(stream, /Detecting studs/);
  assert.match(stream, /"type":"result"/);
  for (const body of [
    { image: "AAAA", sourceImage: "!", tiled: true, density: 16, mode: "yolo" },
    { image: "AAAA", sourceImage: "AAAA", density: 16, mode: "yolo" },
    { image: "AAAA", tiled: true, density: 16, mode: "sam" },
  ]) assert.equal((await post("/api/segment", body)).status, 400);
  const tiled = await post("/api/segment", { image: "AAAA", sourceImage: "BBBB", tiled: true, density: 32, mode: "yolo" });
  assert.equal(tiled.status, 200);
  await tiled.text();
  assert.equal(received.sourceImage, "BBBB");
  assert.equal(received.tiled, true);
  assert.deepEqual(
    (await (await post("/api/templates", { ids: ["3001"] })).json()).views,
    [{ id: "3001" }],
  );
});
test("disconnect cancels owned local inference; missing models return a clear error", async (t) => {
  let cancelled, resolveCancel;
  const cancellation = new Promise((resolve) => (resolveCancel = resolve)),
    sam = {
      status: () => ({ available: true, yoloAvailable: true, busy: false }),
      close() {},
      segment(_, { signal, onProgress }) {
        onProgress({ type: "progress", message: "Processing" });
        return new Promise((_, reject) =>
          signal.addEventListener(
            "abort",
            () => {
              cancelled = true;
              resolveCancel();
              reject(Error("Stopped"));
            },
            { once: true },
          ),
        );
      },
    },
    server = createApp({ sam });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => {
    server.closeAllConnections();
    return new Promise((resolve) => server.close(resolve));
  });
  const base = "http://127.0.0.1:" + server.address().port,
    controller = new AbortController(),
    options = {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ image: "AAAA", density: 16, mode: "yolo" }),
      signal: controller.signal,
    };
  const response = await fetch(base + "/api/segment", options);
  assert.equal(response.status, 200);
  controller.abort();
  await Promise.race([
    cancellation,
    new Promise((_, reject) => {
      const timer = setTimeout(
        () => reject(Error("Cancellation timeout")),
        2000,
      );
      timer.unref();
    }),
  ]);
  assert.equal(cancelled, true);
  sam.status = () => ({ available: false });
  assert.equal(
    (await fetch(base + "/api/segment", { ...options, signal: undefined }))
      .status,
    503,
  );
});
