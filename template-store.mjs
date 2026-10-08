import { readFile } from "node:fs/promises";
import { gunzipSync } from "node:zlib";
export function createTemplateStore(root) {
  let pending;
  async function load() {
    if (!pending)
      pending = Promise.all([
        readFile(new URL("public/search-index/manifest.json", root), "utf8"),
        readFile(new URL("public/search-index/surfaces.json", root), "utf8"),
      ])
        .then(async ([m, s]) => {
          const manifest = JSON.parse(m),
            surfaces = JSON.parse(s),
            catalogue = JSON.parse(
              await readFile(
                new URL("public/ldraw/catalogue.json", root),
                "utf8",
              ),
            );
          if (
            !manifest.complete ||
            manifest.sha256 !== catalogue.sha256 ||
            surfaces.sha256 !== manifest.sha256
          )
            throw Error("Index is stale or incomplete");
          if (!/^[a-z0-9.-]+\.gz$/i.test(manifest.masks))
            throw Error("Invalid mask asset");
          const masks = gunzipSync(
            await readFile(
              new URL("public/search-index/" + manifest.masks, root),
            ),
          );
          if (masks.length !== manifest.views.length * 288)
            throw Error("Incomplete masks");
          return { manifest, surfaces, masks, catalogue };
        })
        .catch((e) => {
          pending = undefined;
          throw Error(
            "CAD templates unavailable. Run npm run build:index. " + e.message,
          );
        });
    return pending;
  }
  return {
    async get(ids) {
      if (
        !Array.isArray(ids) ||
        !ids.length ||
        ids.length > 1000 ||
        ids.some(
          (id) => typeof id !== "string" || !/^[a-z0-9_-]{1,64}$/.test(id),
        )
      )
        throw Object.assign(Error("Invalid template IDs"), { status: 400 });
      const { manifest, surfaces, masks, catalogue } = await load(),
        allowed = new Set(ids),
        views = [],
        chunks = [],
        oldToNew = new Map();
      manifest.views.forEach((v, i) => {
        if (allowed.has(v.id)) {
          oldToNew.set(i, views.length);
          views.push(v);
          chunks.push(masks.subarray(i * 288, (i + 1) * 288));
        }
      });
      const nodes = (manifest.nodes || manifest.views.map((_, i) => [i]))
          .map((node) =>
            node.filter((i) => oldToNew.has(i)).map((i) => oldToNew.get(i)),
          )
          .filter((node) => node.length),
        found = new Set(views.map((v) => v.id));
      return {
        sha256: manifest.sha256,
        views,
        nodes,
        masks: Buffer.concat(chunks).toString("base64"),
        surfaces: Object.fromEntries(
          ids
            .filter((id) => surfaces.parts[id])
            .map((id) => [id, surfaces.parts[id]]),
        ),
        parts: catalogue.parts.filter((p) => allowed.has(p.id)),
        unavailable: ids.filter((id) => !found.has(id)),
      };
    },
  };
}
