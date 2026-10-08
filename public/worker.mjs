import { HNSW } from "./engine/hnsw.mjs";
import {
  loadIndex,
  feature,
  unpack,
  searchIndex,
} from "./engine/view-index.mjs";
import { partFamilies } from "./engine/part-families.mjs";
let controller, index, cacheKey;
self.onmessage = async ({ data }) => {
  if (data.type === "cancel") {
    controller?.abort();
    return;
  }
  if (data.type !== "search" || controller) return;
  controller = new AbortController();
  const signal = controller.signal;
  try {
    const ids = [...new Set(data.ids)].sort(),
      key = ids.join(",");
    if (!ids.length)
      throw Error(
        "No set parts have supported CAD mappings; use manual review.",
      );
    if (key !== cacheKey) {
      self.postMessage({
        type: "progress",
        phase: "loading",
        message: `Loading cached views for ${ids.length} set part families…`,
      });
      const r = await fetch("/api/templates", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ids }),
        signal,
      });
      if (!r.ok) throw Error(await r.text());
      const payload = await r.json();
      if (!payload.views.length)
        throw Error("None of these set parts has a usable CAD index entry");
      const bytes = Uint8Array.from(atob(payload.masks), (c) =>
          c.charCodeAt(0),
        ),
        graph = new HNSW();
      for (let i = 0; i < payload.nodes.length; i++) {
        if (signal.aborted) throw Error("Search stopped");
        const view = payload.nodes[i][0];
        graph.add(
          feature(unpack(bytes.subarray(view * 288, (view + 1) * 288))),
        );
        if (i % 256 === 0) {
          self.postMessage({
            type: "progress",
            phase: "loading",
            message: `Preparing the set-only index: ${i} / ${payload.nodes.length} view buckets…`,
          });
          await new Promise((resolve) => setTimeout(resolve, 0));
        }
      }
      index = loadIndex(
        {
          format: "brick-view-index",
          version: 1,
          complete: true,
          sha256: payload.sha256,
          views: payload.views,
          nodes: payload.nodes,
          failures: payload.unavailable.map((id) => ({
            id,
            message: "CAD index entry unavailable",
          })),
        },
        graph.serialize(),
        bytes,
        payload.sha256,
      );
      index.surfaces = payload.surfaces;
      index.families = partFamilies(payload.parts);
      cacheKey = key;
    }
    const result = await searchIndex({
      ...data,
      index,
      ids,
      commonPrior: false,
      signal,
      onProgress: (p) => self.postMessage({ type: "progress", ...p }),
    });
    self.postMessage({ type: "result", result });
  } catch (e) {
    self.postMessage({
      type: "error",
      message: signal.aborted ? "Search stopped." : e.message,
    });
  } finally {
    controller = null;
  }
};
