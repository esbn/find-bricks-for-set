import { segment, parseLDraw } from "./engine/core.mjs";
import { segmentLocal } from "./engine/segmentation-client.mjs";
import { segmentTiled } from "./tiled-segmentation.mjs";
import { createPartLibrary } from "./engine/part-library.mjs";
import { partFamilies } from "./engine/part-families.mjs";
import { mappedCadPart } from "./cad-mapping.mjs";
import {
  stageNames,
  stageCount,
  validateDiagnostics,
  paintMask,
  outlineMask,
} from "./pipeline-view.mjs";
import {
  drawComparison,
  rotateReviewFit,
  drawReviewMesh,
} from "./engine/review.mjs";
import { estimateColour } from "./colour.mjs";
import { allocate, exportReport } from "./assignment.mjs";
const $ = (id) => document.getElementById(id),
  makeCanvas = (w, h) =>
    Object.assign(document.createElement("canvas"), { width: w, height: h });
const state = {
    requirements: [],
    regions: [],
    allocation: { assignments: new Map(), coverage: [] },
    selected: 0,
    busy: false,
    filter: null,
  },
  library = createPartLibrary(),
  models = new Map();
let controller,
  worker,
  hitMap,
  reviewRevision = 0,
  fit,
  item,
  yaw = 0,
  pitch = 0,
  drag;
function message(text) {
  $("status").textContent = text;
}
function button(text, action) {
  const b = document.createElement("button");
  b.type = "button";
  b.textContent = text;
  b.onclick = action;
  return b;
}
function ready() {
  for (const id of [
    "setQuery",
    "searchSets",
    "inventoryFile",
    "imageFile",
    "demo",
    "method",
    "density",
    "matchColours",
  ])
    $(id).disabled = state.busy;
  $("identify").disabled = state.busy || !state.image || !state.set;
  $("stop").hidden = !state.busy;
  $("progress").hidden = !state.busy;
  $("identify").textContent = state.busy
    ? "Finding your set’s pieces…"
    : "Highlight bricks for this set →";
}
function recompute() {
  state.allocation = allocate(state.regions, state.requirements, {
    matchColours: $("matchColours").checked,
  });
  render();
}
function setInventory(info) {
  state.set = info.set;
  state.requirements = info.requirements;
  state.regions = [];
  state.selected = 0;
  state.filter = null;
  hitMap = null;
  const supported = new Set(
    info.requirements.map((r) => r.matchId).filter(Boolean),
  ).size;
  $("selectedSet").hidden = false;
  $("selectedSet").textContent = `${info.set.number} · ${info.set.name}`;
  $("setResults").replaceChildren();
  $("setStatus").textContent =
    `${supported} mapped CAD families · ${info.source}. ${info.requirements.filter((r) => !r.matchId).length} lines require manual identification.${info.incomplete ? " Inventory is incomplete: " + info.warnings.join("; ") : ""}`;
  recompute();
  ready();
  message(
    state.image
      ? "Ready to search only this set’s parts."
      : "Add a photo to begin.",
  );
}
async function getJSON(url, options) {
  const r = await fetch(url, options);
  if (!r.ok) throw Error(await r.text());
  return r.json();
}
$("setSearch").onsubmit = async (e) => {
  e.preventDefault();
  $("searchSets").disabled = true;
  try {
    const { sets } = await getJSON(
      "/api/sets?q=" + encodeURIComponent($("setQuery").value),
    );
    $("setResults").replaceChildren(
      ...sets.map((s) =>
        button(`${s.number} · ${s.name}`, async () => {
          try {
            setInventory(
              await getJSON("/api/sets/" + encodeURIComponent(s.number)),
            );
          } catch (e) {
            $("setStatus").textContent = e.message;
          }
        }),
      ),
    );
    $("setStatus").textContent = sets.length
      ? "Select a set below."
      : "No results in the local catalogue.";
  } catch (e) {
    $("setStatus").textContent = e.message;
  } finally {
    ready();
  }
};
async function customInventory(value) {
  if (
    !value.set ||
    typeof value.set.number !== "string" ||
    typeof value.set.name !== "string" ||
    !Array.isArray(value.parts) ||
    !value.parts.length ||
    value.parts.length > 1000
  )
    throw Error(
      "Expected {set:{number,name},parts:[{id,quantity,color:{rgb,name}}]}; maximum 1000 lines.",
    );
  const catalogue = await library.catalogue(),
    byId = new Map(catalogue.parts.map((p) => [p.id, p])),
    families = partFamilies(catalogue.parts),
    seen = new Set();
  const requirements = value.parts.map((p) => {
    if (
      typeof p.id !== "string" ||
      !/^[a-z0-9_-]{1,64}$/.test(p.id) ||
      !Number.isSafeInteger(p.quantity) ||
      p.quantity < 1 ||
      p.quantity > 100000 ||
      !p.color ||
      typeof p.color.rgb !== "string" ||
      !/^#?[a-f\d]{6}$/i.test(p.color.rgb) ||
      typeof p.color.name !== "string"
    )
      throw Error(
        "Each part needs a safe ID, positive integer quantity and colour name + six-digit RGB.",
      );
    const rgb = p.color.rgb.replace("#", "").toUpperCase(),
      colorId = p.color.id ?? rgb,
      key = p.id + ":" + colorId;
    if (seen.has(key)) throw Error("Combine duplicate part/colour lines.");
    seen.add(key);
    const cad = byId.get(p.id);
    return {
      id: p.id,
      key,
      quantity: p.quantity,
      label: cad?.label || p.id,
      colorId,
      color: { ...p.color, rgb, isTrans: !!p.color.isTrans },
      matchId: mappedCadPart(p.id, byId, families),
      printed: !!cad?.decorated,
      mapping: cad ? "shared-id" : "unsupported",
    };
  });
  setInventory({
    set: value.set,
    requirements,
    source: "Custom inventory",
    warnings: [],
  });
}
$("inventoryFile").onchange = async (e) => {
  try {
    const file = e.target.files[0];
    if (!file) return;
    if (file.size > 1024 * 1024) throw Error("Inventory must be under 1 MB.");
    await customInventory(JSON.parse(await file.text()));
  } catch (e) {
    $("setStatus").textContent = e.message;
  } finally {
    $("inventoryFile").value = "";
  }
};
function setPhoto(canvas, source = canvas) {
  state.pipeline = null;
  state.pipelineStage = "original";
  state.pipelineProposalId = null;
  state.image = canvas;
  state.sourceImage = source;
  state.imageData = canvas
    .getContext("2d", { willReadFrequently: true })
    .getImageData(0, 0, canvas.width, canvas.height);
  state.regions = [];
  state.selected = 0;
  state.segmentation = null;
  hitMap = null;
  $("photoCanvas").width = canvas.width;
  $("photoCanvas").height = canvas.height;
  $("photoCanvas").hidden = false;
  $("photoEmpty").hidden = true;
  recompute();
  ready();
  message(
    state.set
      ? "Ready. Click Highlight bricks for this set."
      : "Choose a set to constrain the search.",
  );
}
async function photo(file) {
  if (!file || state.busy) return;
  state.busy = true;
  ready();
  $("stop").hidden = true;
  message("Decoding the new photo…");
  try {
    const bitmap = await createImageBitmap(file);
    if (bitmap.width * bitmap.height > 32000000 || Math.max(bitmap.width, bitmap.height) > 10000) {
      bitmap.close();
      throw Error("Photo exceeds the 32-megapixel / 10,000-pixel limit. Upload a smaller photo.");
    }
    const source = makeCanvas(bitmap.width, bitmap.height);
    source.getContext("2d").drawImage(bitmap, 0, 0);
    const scale = Math.min(1, 1800 / Math.max(bitmap.width, bitmap.height)),
      canvas = makeCanvas(
        Math.round(bitmap.width * scale),
        Math.round(bitmap.height * scale),
      );
    canvas
      .getContext("2d")
      .drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    bitmap.close();
    setPhoto(canvas, source);
  } catch (error) {
    message(
      error.message?.startsWith("Photo exceeds") ? error.message : "This browser cannot decode the image. Export HEIC as JPEG or PNG and upload that version.",
    );
  } finally {
    state.busy = false;
    ready();
    $("imageFile").value = "";
  }
}
$("imageFile").onchange = (e) => photo(e.target.files[0]);
$("photoArea").ondragover = (e) => e.preventDefault();
$("photoArea").ondrop = (e) => {
  e.preventDefault();
  photo(e.dataTransfer.files[0]);
};
function progress(p) {
  if (p.phase === "search") {
    message(
      `Compared ${p.compared.toLocaleString()} part–crop pairs across ${p.libraryParts} set parts · ${p.completed}/${p.total} pieces. Best scores: ${p.best.map((b, i) => (b ? `${i + 1}: ${(100 * (b.visualScore ?? b.score)).toFixed(1)}%` : `${i + 1}: —`)).join(" · ")}`,
    );
    $("progress").max = p.total;
    $("progress").value = p.completed;
  } else {
    if (Number.isFinite(p.completed) && p.total > 0) {
      $("progress").max = p.total;
      $("progress").value = p.completed;
    } else $("progress").removeAttribute("value");
    message(p.message || p.phase || "Processing photo…");
  }
}
function search(data, signal) {
  worker ??= new Worker("worker.mjs", { type: "module" });
  return new Promise((resolve, reject) => {
    const abort = () => {
      worker.terminate();
      worker = null;
      reject(Error("Search stopped."));
    };
    signal.addEventListener("abort", abort, { once: true });
    worker.onmessage = ({ data: m }) => {
      if (m.type === "progress") progress(m);
      else {
        signal.removeEventListener("abort", abort);
        m.type === "result" ? resolve(m.result) : reject(Error(m.message));
      }
    };
    worker.onerror = (e) => {
      signal.removeEventListener("abort", abort);
      worker.terminate();
      worker = null;
      reject(Error(e.message));
    };
    worker.postMessage({ type: "search", ...data });
  });
}
$("identify").onclick = async () => {
  state.pipeline = null;
  state.pipelineStage = "matches";
  state.pipelineProposalId = null;
  state.busy = true;
  controller = new AbortController();
  ready();
  message("Starting local detection…");
  $("progress").removeAttribute("value");
  state.regions = [];
  state.selected = 0;
  recompute();
  const signal = controller.signal;
  try {
    // Let the browser paint immediate feedback before any synchronous fallback work.
    await new Promise((resolve) =>
      requestAnimationFrame(() => setTimeout(resolve, 0)),
    );
    const mode = $("method").value,
      density = Number($("density").value),
      cacheKey = mode + ":" + density + ":tiles-v1";
    let detected =
      state.segmentation?.key === cacheKey ? state.segmentation.value : null;
    // Old cached results cannot reconstruct raw/cleaned masks from retained
    // regions. Request fresh diagnostics instead of silently reusing them.
    if (mode !== "threshold" && detected && !detected.diagnostics) detected = null;
    if (!detected) {
      detected =
        mode === "threshold"
          ? segment(state.imageData)
          : await (mode === "yolo"
              ? segmentTiled(state.image, state.sourceImage, {
                  mode, density, signal, onProgress: progress,
                })
              : segmentLocal(state.image, {
                  mode, density, signal, onProgress: progress,
                }));
      state.segmentation = { key: cacheKey, value: detected };
    }
    validateDiagnostics(detected.diagnostics);
    state.pipeline = detected;
    renderPipelineControls();
    drawPhoto();
    if (signal.aborted) throw Error("Search stopped.");
    if (detected.components.length > 100)
      throw Error(
        `Detected ${detected.components.length} regions; photograph at most 100 separated pieces at a time.`,
      );
    if (!detected.components.length)
      throw Error(
        "No separated pieces detected. Try YOLO + SAM, better light, or a simpler background.",
      );
    state.regions = detected.components.map((r, i) => ({
      ...r,
      uid: i + 1,
      rgb: estimateColour(state.imageData, r.pixels),
      scores: [],
    }));
    state.selected = 1;
    buildHitMap();
    recompute();
    const ids = [
      ...new Set(state.requirements.map((r) => r.matchId).filter(Boolean)),
    ];
    if (!ids.length) {
      message(
        "Detected pieces; this inventory has no mapped CAD parts. Use manual review.",
      );
      return;
    }
    const result = await search(
      {
        ids,
        components: state.regions,
        width: state.image.width,
        imageData: state.imageData,
        pitch: null,
      },
      signal,
    );
    state.regions = result.candidates.map((r, i) => ({
      ...r,
      uid: i + 1,
      rgb: estimateColour(state.imageData, r.pixels),
    }));
    buildHitMap();
    recompute();
    message(
      `${result.cancelled ? "Partial search" : "Search complete"}: ${state.regions.length} pieces · ${result.libraryParts} set-only CAD families · ${result.compared.toLocaleString()} part–crop comparisons. Review suggestions before picking.${result.failures.length ? " Some set parts lack indexed CAD views." : ""}`,
    );
  } catch (e) {
    message(
      e.message +
        " Detected regions, if available, can still be reviewed manually.",
    );
  } finally {
    state.busy = false;
    ready();
    render();
  }
};
$("stop").onclick = () => controller?.abort();
$("matchColours").onchange = () => recompute();
$("showAll").onchange = () => drawPhoto();
$("partFilter").oninput = () => renderRequirements();
$("clearFilter").onclick = () => {
  state.filter = null;
  render();
};
function buildHitMap() {
  hitMap = new Uint16Array(state.image.width * state.image.height);
  for (const r of state.regions) for (const k of r.pixels) hitMap[k] = r.uid;
}
function selected() {
  return state.regions.find((r) => r.uid === state.selected);
}
function target(region = selected()) {
  return state.requirements.find(
    (r) =>
      r.key ===
      (region?.manualKey || state.allocation.assignments.get(region?.uid)?.key),
  );
}
function select(uid) {
  state.selected = uid;
  render();
}
function renderPipelineControls() {
  const stage = state.pipelineStage || "matches",
    data = state.pipeline;
  $("pipelineStages").replaceChildren(
    ...Object.entries(stageNames).map(([key, name]) => {
      const count =
          key === "matches"
            ? state.allocation.assignments.size
            : stageCount(key, data, state.regions),
        b = button(name + (count === null ? "" : ` (${count})`), () => {
          state.pipelineStage = key;
          state.pipelineProposalId = null;
          renderPipelineControls();
          drawPhoto();
        });
      b.dataset.stage = key;
      b.setAttribute("aria-pressed", String(key === stage));
      b.disabled =
        !state.image ||
        (count === null && !["original", "matches"].includes(key));
      if (b.disabled) b.title = !state.image
        ? "Upload a photo first."
        : !data ? "Run identification first."
        : ["raw", "cleaned", "rejected"].includes(key)
          ? data.method?.includes("SAM")
            ? "Backend did not return intermediate masks. Restart the app server, refresh, and identify again."
            : "This detection mode does not produce SAM masks. Select YOLO + SAM or Local SAM."
          : "This detection mode does not produce this stage.";
      return b;
    }),
  );
  $("photoLegend").hidden = stage !== "matches";
  const description = {
    original: "Unmodified working photo.",
    yolo: "Raw detector boxes before SAM and filtering. Labels show detection confidence.",
    raw: "Raw SAM masks before connected-component cleanup or rejection. Click a mask for its decision.",
    cleaned:
      "Principal connected component of each SAM proposal, before filtering. Click a mask to inspect it.",
    rejected:
      "Masks discarded by the pipeline, not bricks excluded during match review. Click a mask for the reason.",
    retained:
      "All regions retained for matching, regardless of set membership or colour.",
    features:
      "Observed studs (yellow) and hollow tubes (cyan), on retained regions. Not all surface features are detectable.",
    matches: "Quantity-aware set matches. Click a retained piece to review it.",
  };
  let text = state.image
    ? description[stage]
    : "Upload a photo to inspect pipeline stages.";
  if (data?.tiling) {
    const t = data.tiling;
    if (stage === "yolo") text = "Whole-image and source-tile boxes after duplicate merging, before SAM refinement. Labels show detection confidence.";
    text += ` Source ${t.sourceWidth} × ${t.sourceHeight} · ${t.tiles} overlapping tiles + whole-image pass · ${t.rawProposals} proposals → ${t.mergedProposals} merged boxes · ${t.localSamCrops} local SAM crops.`;
  }
  if (stage === "rejected" && data?.diagnostics) {
    const counts = {};
    for (const p of data.diagnostics.proposals)
      if (p.decision === "rejected")
        counts[p.reason] = (counts[p.reason] || 0) + 1;
    text +=
      " " +
      Object.entries(counts)
        .map(([reason, n]) => `${reason}: ${n}`)
        .join(" · ");
  }
  const p = data?.diagnostics?.proposals.find(
    (p) => p.id === state.pipelineProposalId,
  );
  if (p)
    text += ` Proposal P${p.id}: ${p.decision}${p.reason ? " — " + p.reason : ""}. SAM quality ${Math.round(p.quality * 100)}%${Number.isFinite(p.textureRatio) ? "; texture ratio " + p.textureRatio.toFixed(2) : ""}.`;
  if (p?.warnings?.length) text += " " + p.warnings.join("; ") + ".";
  if (data?.method?.includes("SAM") && !data.diagnostics)
    text += " Intermediate SAM masks were not returned by the backend. Restart the app server, refresh this page, and click Identify again to enable SAM proposals, Cleaned masks and Rejected masks.";
  if (
    data?.diagnostics?.truncated &&
    ["raw", "cleaned", "rejected"].includes(stage)
  )
    text += ` Showing ${data.diagnostics.proposals.length} of ${data.diagnostics.total} proposals (diagnostic display limit).`;
  $("pipelineSummary").textContent = text;
}
function drawPipeline(ctx, canvas) {
  const stage = state.pipelineStage,
    data = state.pipeline;
  if (stage === "original" || !data) return;
  function outline(box, label, color) {
    const [x, y, w, h] = box;
    ctx.strokeStyle = color;
    ctx.lineWidth = 2;
    ctx.strokeRect(x, y, w, h);
    ctx.font = "bold 15px system-ui";
    const tw = ctx.measureText(label).width + 10,
      top = Math.max(0, y - 23);
    ctx.fillStyle = color;
    ctx.fillRect(x, top, tw, 23);
    ctx.fillStyle = "white";
    ctx.fillText(label, x + 5, top + 17);
  }
  if (stage === "yolo") {
    for (const [i, d] of data.brickDetections.entries()) {
      const [x0, y0, x1, y1] = d.box;
      outline(
        [x0, y0, x1 - x0, y1 - y0],
        `Y${i + 1} · ${Math.round(d.confidence * 100)}%`,
        "#245bdb",
      );
    }
    return;
  }
  if (["raw", "cleaned", "rejected"].includes(stage)) {
    const d = data.diagnostics;
    if (!d) return;
    for (const p of d.proposals) {
      if (stage === "rejected" && p.decision !== "rejected") continue;
      const m = stage === "raw" ? p.raw : p.cleaned || p.raw;
      if (!m) continue;
      paintMask(
        ctx,
        m,
        d.width,
        d.height,
        canvas.width,
        canvas.height,
        p.decision === "rejected"
          ? "rgba(235,65,75,.25)"
          : "rgba(24,171,152,.25)",
      );
    }
    for (const p of d.proposals) {
      if (stage === "rejected" && p.decision !== "rejected") continue;
      const m = stage === "raw" ? p.raw : p.cleaned || p.raw;
      if (!m) continue;
      const [x, y, w, h] = m.box,
        sx = canvas.width / d.width,
        sy = canvas.height / d.height;
      outlineMask(
        ctx, m, d.width, d.height, canvas.width, canvas.height,
        p.id === state.pipelineProposalId ? "#ffffff"
          : p.decision === "rejected" ? "#ff6674" : "#4cf5d5",
        2 * canvas.width / (canvas.clientWidth || canvas.width),
      );
      outline(
        [x * sx, y * sy, w * sx, h * sy],
        `P${p.id}${stage === "rejected" ? " · " + p.reason : ""}`,
        p.id === state.pipelineProposalId
          ? "#172940"
          : p.decision === "rejected"
            ? "#bd3540"
            : "#078776",
      );
    }
    return;
  }
  const tint = ctx.getImageData(0, 0, canvas.width, canvas.height);
  for (const r of data.components)
    for (const k of r.pixels)
      for (let ch = 0; ch < 3; ch++)
        tint.data[k * 4 + ch] = Math.round(
          tint.data[k * 4 + ch] * 0.78 + [24, 171, 152][ch] * 0.22,
        );
  ctx.putImageData(tint, 0, 0);
  for (const [i, r] of data.components.entries()) {
    const diagnostic = data.diagnostics,
      proposal = diagnostic?.proposals.find((p) => p.id === r.proposalId);
    if (proposal?.cleaned)
      outlineMask(ctx, proposal.cleaned, diagnostic.width, diagnostic.height,
        canvas.width, canvas.height, "#4cf5d5",
        2 * canvas.width / (canvas.clientWidth || canvas.width));
    outline(
      r.box,
      `${i + 1}${r.proposalId ? " · P" + r.proposalId : ""}`,
      "#078776",
    );
    if (stage === "features")
      for (const [points, color] of [
        [r.studDetections, "#ffe566"],
        [r.tubeDetections, "#4cdef3"],
      ])
        for (const p of points || []) {
          ctx.strokeStyle = color;
          ctx.lineWidth = 2;
          ctx.beginPath();
          ctx.arc(p.x, p.y, p.radius, 0, Math.PI * 2);
          ctx.stroke();
        }
  }
}
function drawPhoto() {
  if (!state.image) return;
  const canvas = $("photoCanvas"),
    ctx = canvas.getContext("2d");
  ctx.drawImage(state.image, 0, 0);
  if ((state.pipelineStage || "matches") !== "matches") {
    drawPipeline(ctx, canvas);
    return;
  }
  const tint = ctx.getImageData(0, 0, canvas.width, canvas.height);
  for (const r of state.regions) {
    const a = state.allocation.assignments.get(r.uid);
    if (!a && !$("showAll").checked) continue;
    if (state.filter && a?.key !== state.filter) continue;
    const rgb = a
        ? a.confirmed
          ? [25, 170, 113]
          : a.ambiguous
            ? [244, 171, 45]
            : [41, 120, 245]
        : [120, 130, 143],
      alpha = a?.confirmed ? 0.38 : a?.ambiguous ? 0.29 : a?.score ? 0.28 : 0.1;
    for (const k of r.pixels)
      for (let ch = 0; ch < 3; ch++)
        tint.data[k * 4 + ch] = Math.round(
          tint.data[k * 4 + ch] * (1 - alpha) + rgb[ch] * alpha,
        );
  }
  ctx.putImageData(tint, 0, 0);
  for (const r of state.regions) {
    const a = state.allocation.assignments.get(r.uid);
    if (
      (!a && !$("showAll").checked) ||
      (state.filter && a?.key !== state.filter)
    )
      continue;
    const [x, y, w, h] = r.box;
    ctx.strokeStyle =
      r.uid === state.selected
        ? "#172940"
        : a?.confirmed
          ? "#159669"
          : a?.ambiguous
            ? "#c58a20"
            : a
              ? "#2878ed"
              : "#7b8998";
    ctx.lineWidth = r.uid === state.selected ? 4 : 2;
    ctx.strokeRect(x - 3, y - 3, w + 6, h + 6);
    ctx.font = "bold 15px system-ui";
    ctx.fillStyle = ctx.strokeStyle;
    ctx.fillRect(x - 3, y - 25, 30, 23);
    ctx.fillStyle = "white";
    ctx.fillText(String(r.uid), x + 3, y - 8);
  }
}
$("photoCanvas").onclick = (e) => {
  if (
    !["matches", "retained", "features"].includes(
      state.pipelineStage || "matches",
    )
  ) {
    const d = state.pipeline?.diagnostics,
      stage = state.pipelineStage;
    if (!d || !["raw", "cleaned", "rejected"].includes(stage)) return;
    const rect = e.currentTarget.getBoundingClientRect(),
      x = Math.floor(((e.clientX - rect.left) * d.width) / rect.width),
      y = Math.floor(((e.clientY - rect.top) * d.height) / rect.height),
      key = y * d.width + x;
    const p = [...d.proposals].reverse().find((p) => {
      if (stage === "rejected" && p.decision !== "rejected") return false;
      const m = stage === "raw" ? p.raw : p.cleaned || p.raw;
      return m?.runs.some(
        (start, i) =>
          i % 2 === 0 && key >= start && key < start + m.runs[i + 1],
      );
    });
    state.pipelineProposalId = p?.id || null;
    renderPipelineControls();
    drawPhoto();
    return;
  }
  if (!hitMap) return;
  const rect = e.currentTarget.getBoundingClientRect(),
    x = Math.floor(
      ((e.clientX - rect.left) * e.currentTarget.width) / rect.width,
    ),
    y = Math.floor(
      ((e.clientY - rect.top) * e.currentTarget.height) / rect.height,
    ),
    uid = hitMap[y * e.currentTarget.width + x];
  if (uid) select(uid);
};
function renderRequirements() {
  const q = $("partFilter").value.toLowerCase();
  $("requirements").replaceChildren(
    ...state.requirements
      .filter((r) =>
        (r.id + " " + r.label + " " + r.color.name).toLowerCase().includes(q),
      )
      .map((r) => {
        const c = state.allocation.coverage.find((c) => c.key === r.key),
          b = button("", () => {
            state.filter = r.key;
            const found = state.regions.find(
              (region) =>
                state.allocation.assignments.get(region.uid)?.key === r.key,
            );
            if (found) state.selected = found.uid;
            render();
          });
        b.className = "requirement" + (state.filter === r.key ? " active" : "");
        const swatch = document.createElement("i");
        swatch.className = "swatch";
        swatch.style.background = r.color.rgb ? "#" + r.color.rgb : "#ddd";
        const text = document.createElement("span");
        text.textContent = `${r.id} · ${r.label}\n${r.color.name} · ${c.confirmed} confirmed / ${r.quantity} needed · ${c.suggested} suggested${!r.matchId ? " · manual only" : ""}`;
        b.append(swatch, text);
        return b;
      }),
  );
  $("clearFilter").hidden = !state.filter;
}
function render() {
  renderPipelineControls();
  drawPhoto();
  renderRequirements();
  const coverage = state.allocation.coverage,
    total = coverage.reduce((s, c) => s + c.required, 0),
    confirmed = coverage.reduce((s, c) => s + c.confirmed, 0),
    suggested = coverage.reduce((s, c) => s + c.suggested, 0);
  $("requiredCount").textContent = state.set ? `${total} pieces` : "—";
  $("coverageSummary").textContent = state.set
    ? `${confirmed} confirmed · ${suggested} suggested · ${total - confirmed - suggested} not located. Suggestions are not verified.`
    : "Select a set to see its parts.";
  $("photoSummary").textContent =
    `${state.regions.length} photo regions · ${state.allocation.assignments.size} allocated within set quantities. Not located means not found in this photo, not necessarily missing from your collection.`;
  $("export").disabled = !state.regions.length;
  $("review").hidden = !state.regions.length;
  $("regions").replaceChildren(
    ...state.regions.map((r) => {
      const a = state.allocation.assignments.get(r.uid),
        line = state.requirements.find((p) => p.key === a?.key),
        b = button(
          `Piece ${r.uid} · ${r.rejected ? "Excluded" : a?.confirmed ? "Confirmed" : a ? line.id : "Unassigned"}`,
          () => select(r.uid),
        );
      b.className = r.uid === state.selected ? "active" : "";
      return b;
    }),
  );
  if (state.regions.length) review();
  else {
    reviewRevision++;
    fit = null;
  }
}
async function review() {
  const revision = ++reviewRevision,
    r = selected();
  if (!r) return;
  const line = target(r),
    a = state.allocation.assignments.get(r.uid),
    hit = r.scores?.find(
      (s) =>
        s.id === line?.matchId ||
        s.family === line?.matchId ||
        s.variants?.includes(line?.matchId),
    );
  $("reviewTitle").textContent =
    `Photo piece ${r.uid}${line ? " · " + line.color.name + " " + line.id : ""}`;
  $("reviewState").textContent = r.rejected
    ? "Excluded"
    : a?.confirmed
      ? "Confirmed"
      : a?.ambiguous
        ? "Needs review"
        : a
          ? "Suggested"
          : "Unassigned";
  $("candidateLabel").textContent = line
    ? `${line.label}${hit ? " · " + ((hit.visualScore ?? hit.score) * 100).toFixed(1) + "% visual score" : ""}`
    : "No confident set match. Choose a part manually if you recognise it.";
  $("manualPart").replaceChildren(
    new Option("Choose a required part…", ""),
    ...state.requirements.map(
      (p) => new Option(`${p.id} · ${p.color.name} · ${p.label}`, p.key),
    ),
  );
  $("manualPart").value = line?.key || "";
  $("face").value = r.face || hit?.face || "top";
  $("confirm").disabled = state.busy || !line;
  $("reject").disabled = state.busy;
  $("manualPart").disabled = state.busy;
  $("face").disabled = state.busy;
  $("confirm").textContent = r.confirmed
    ? "Undo confirmation"
    : "Confirm for this set";
  $("reject").textContent = r.rejected
    ? "Restore piece"
    : "Not needed / exclude";
  const evidence = r.surface || hit?.surface?.observed || {},
    studs = r.studDetections?.length,
    tubes = r.tubeDetections?.length;
  $("surfaceEvidence").textContent =
    `Surface evidence: ${studs ?? evidence.count ?? "unknown"} studs/dots${tubes ? ` · ${tubes} underside tubes` : ""}${evidence.inferredStudCount ? ` · inferred ${evidence.inferredStudCount} studs` : ""}. Unknown does not mean smooth.`;
  $("reviewNote").textContent =
    (line?.printed ? "Printed decoration is not verified. " : "") +
    (r.manualKey
      ? "Manual selection; inspect shape, height and colour. "
      : "Estimated colour and similar silhouettes can be wrong. ") +
    (!a && line
      ? "This line’s quantity is already allocated; confirming may replace an unconfirmed suggestion. "
      : "") +
    "Only confirmed pieces count as verified.";
  const options = reviewOptions(r);
  $("previousCandidate").disabled = state.busy || options.length < 2;
  $("nextCandidate").disabled = state.busy || options.length < 2;
  fit = null;
  $("resetView").disabled = true;
  const crop = $("cropCanvas"),
    cad = $("cadCanvas"),
    [x, y, w, h] = r.box,
    zoom = Math.min((crop.width - 24) / w, (crop.height - 24) / h);
  crop.getContext("2d").fillStyle = "#192331";
  crop.getContext("2d").fillRect(0, 0, crop.width, crop.height);
  crop
    .getContext("2d")
    .drawImage(
      state.image,
      x,
      y,
      w,
      h,
      (crop.width - w * zoom) / 2,
      (crop.height - h * zoom) / 2,
      w * zoom,
      h * zoom,
    );
  const context = cad.getContext("2d");
  context.fillStyle = "#ebf1f9";
  context.fillRect(0, 0, cad.width, cad.height);
  context.fillStyle = "#5f7083";
  context.fillText(
    line?.matchId ? "Loading CAD…" : "No mapped CAD; manual review only.",
    20,
    125,
  );
  if (!line?.matchId) return;
  try {
    if (!models.has(line.matchId))
      models.set(
        line.matchId,
        library
          .resolve(line.matchId + ".dat")
          .then((text) => parseLDraw(text, library.resolve))
          .catch((e) => {
            models.delete(line.matchId);
            throw e;
          }),
      );
    const model = await models.get(line.matchId);
    if (revision !== reviewRevision) return;
    item = {
      ...r,
      view: hit?.view || { yaw: 30, elevation: 60 },
      face: r.face || hit?.face || "top",
      color: "#" + (line.color.rgb || "5484dc"),
    };
    fit = drawComparison(crop, cad, state.image, model, item, makeCanvas);
    yaw = pitch = 0;
    $("resetView").disabled = false;
    const pc = crop.getContext("2d");
    for (const [detections, color] of [
      [r.studDetections, "#ffe566"],
      [r.tubeDetections, "#62dcf0"],
    ])
      for (const d of detections || []) {
        pc.strokeStyle = color;
        pc.lineWidth = 1.5;
        pc.beginPath();
        pc.arc(
          crop.width / 2 + (d.x - fit.target.cx) * fit.displayZoom,
          crop.height / 2 + (d.y - fit.target.cy) * fit.displayZoom,
          d.radius * fit.displayZoom,
          0,
          Math.PI * 2,
        );
        pc.stroke();
      }
  } catch (e) {
    if (revision === reviewRevision)
      $("reviewNote").textContent = "CAD unavailable: " + e.message;
  }
}
function reviewOptions(r) {
  const options = [];
  for (const s of r.scores || [])
    for (const p of state.requirements)
      if (
        p.matchId &&
        (s.id === p.matchId ||
          s.family === p.matchId ||
          s.variants?.includes(p.matchId)) &&
        !options.includes(p.key)
      )
        options.push(p.key);
  return options;
}
function editRegion(action) {
  const r = selected();
  if (!r) return;
  const saved = { ...r };
  try {
    action(r);
    recompute();
  } catch (e) {
    Object.assign(r, saved);
    for (const key of ["manualKey", "confirmed", "rejected", "face"])
      if (!(key in saved)) delete r[key];
    message(e.message);
    recompute();
  }
}
function manual(key) {
  editRegion((r) => {
    r.manualKey = key || null;
    r.confirmed = false;
    r.rejected = false;
  });
}
$("manualPart").onchange = (e) => manual(e.target.value);
$("face").onchange = (e) =>
  editRegion((r) => {
    r.face = e.target.value;
  });
function cycle(delta) {
  const options = reviewOptions(selected()),
    key = target()?.key,
    index = options.indexOf(key);
  if (options.length)
    manual(
      options[(Math.max(0, index) + delta + options.length) % options.length],
    );
}
$("previousCandidate").onclick = () => cycle(-1);
$("nextCandidate").onclick = () => cycle(1);
$("confirm").onclick = () =>
  editRegion((r) => {
    if (r.confirmed) {
      r.confirmed = false;
      return;
    }
    const line = target(r);
    if (!line) return;
    r.manualKey = line.key;
    r.confirmed = true;
    r.rejected = false;
  });
$("reject").onclick = () =>
  editRegion((r) => {
    r.rejected = !r.rejected;
    r.confirmed = false;
    r.manualKey = null;
  });
function rotate() {
  if (fit)
    drawReviewMesh(
      $("cadCanvas"),
      rotateReviewFit(fit, yaw, pitch),
      item,
      fit.displayZoom,
    );
}
$("cadCanvas").onpointerdown = (e) => {
  if (!fit) return;
  drag = { x: e.clientX, y: e.clientY };
  e.currentTarget.setPointerCapture(e.pointerId);
};
$("cadCanvas").onpointermove = (e) => {
  if (!drag) return;
  yaw += (e.clientX - drag.x) * 0.012;
  pitch += (e.clientY - drag.y) * 0.012;
  drag = { x: e.clientX, y: e.clientY };
  rotate();
};
$("cadCanvas").onpointerup = $("cadCanvas").onpointercancel = () => {
  drag = null;
};
$("cadCanvas").onkeydown = (e) => {
  if (!fit) return;
  if (e.key === "Home") yaw = pitch = 0;
  else if (e.key === "ArrowLeft") yaw -= 0.15;
  else if (e.key === "ArrowRight") yaw += 0.15;
  else if (e.key === "ArrowUp") pitch -= 0.15;
  else if (e.key === "ArrowDown") pitch += 0.15;
  else return;
  e.preventDefault();
  rotate();
};
$("resetView").onclick = () => {
  yaw = pitch = 0;
  rotate();
};
$("export").onclick = () => {
  const blob = new Blob(
      [
        JSON.stringify(
          exportReport(
            state.set,
            state.regions,
            state.requirements,
            state.allocation,
          ),
          null,
          2,
        ),
      ],
      { type: "application/json" },
    ),
    url = URL.createObjectURL(blob),
    a = document.createElement("a");
  a.href = url;
  a.download = `${state.set.number}-brick-review.json`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
};
$("demo").onclick = async () => {
  try {
    await customInventory({
      set: {
        number: "workshop-demo",
        name: "Synthetic practice inventory (not an official set)",
      },
      parts: [
        { id: "3033", quantity: 1, color: { name: "Blue", rgb: "0055BF" } },
        { id: "3795", quantity: 1, color: { name: "Red", rgb: "C91A09" } },
        { id: "3020", quantity: 1, color: { name: "Yellow", rgb: "F2CD37" } },
      ],
    });
    const canvas = makeCanvas(900, 560),
      ctx = canvas.getContext("2d");
    ctx.fillStyle = "#f5f3ed";
    ctx.fillRect(0, 0, 900, 560);
    function plate(x, y, rows, columns, color) {
      ctx.fillStyle = color;
      ctx.fillRect(x, y, rows * 23, columns * 23);
      for (let a = 0; a < rows; a++)
        for (let b = 0; b < columns; b++) {
          ctx.beginPath();
          ctx.arc(x + (a + 0.5) * 23, y + (b + 0.5) * 23, 7, 0, Math.PI * 2);
          ctx.fillStyle = color;
          ctx.fill();
          ctx.strokeStyle = "rgba(255,255,255,.6)";
          ctx.lineWidth = 2;
          ctx.stroke();
        }
    }
    plate(65, 75, 6, 10, "#0055BF");
    plate(270, 190, 6, 10, "#0055BF");
    plate(505, 80, 2, 6, "#C91A09");
    plate(650, 270, 2, 4, "#F2CD37");
    plate(750, 75, 2, 2, "#237841");
    setPhoto(canvas);
    $("method").value = "threshold";
    message(
      "Synthetic demo: 5 pieces, only 3 needed. Click Highlight to run real set-constrained matching. This is not a photo-accuracy benchmark.",
    );
  } catch (e) {
    message(e.message);
  }
};
renderPipelineControls();
getJSON("/api/status")
  .then((status) => {
    $("setStatus").textContent = status.setsReady
      ? "Local set catalogue ready. Search for a set."
      : "Run npm run setup:sets to install the catalogue.";
    $("modelStatus").textContent = status.yoloAvailable
      ? "Local YOLO + SAM ready. Studs and underside tubes support shape matching."
      : "Models not installed. Run npm run setup:yolo; background threshold remains available.";
    for (const option of $("method").options)
      if (option.value !== "threshold")
        option.disabled =
          option.value === "yolo" ? !status.yoloAvailable : !status.available;
    $("method").value = status.yoloAvailable
      ? "yolo"
      : status.available
        ? "sam"
        : "threshold";
    if (!status.indexReady)
      message(
        "CAD index missing: run npm run setup:ldraw and npm run build:index.",
      );
  })
  .catch((e) => message(e.message));
