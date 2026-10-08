export const stageNames = {
  original: "Original",
  yolo: "YOLO boxes",
  raw: "SAM proposals",
  cleaned: "Cleaned masks",
  rejected: "Rejected masks",
  retained: "Retained regions",
  features: "Studs & tubes",
  matches: "Set matches",
};
// Validate diagnostics independently of the vendored production mask decoder.
export function validateDiagnostics(value) {
  if (!value) return null;
  const { width, height, proposals } = value;
  if (
    !Number.isInteger(width) ||
    !Number.isInteger(height) ||
    width < 1 ||
    height < 1 ||
    width > 1800 ||
    height > 1800 ||
    !Array.isArray(proposals) ||
    proposals.length > 400
  )
    throw Error("Invalid pipeline diagnostics");
  const ids = new Set();
  for (const p of proposals) {
    if (
      !Number.isInteger(p.id) ||
      p.id < 1 ||
      ids.has(p.id) ||
      !["retained", "rejected"].includes(p.decision)
    )
      throw Error("Invalid pipeline proposal");
    ids.add(p.id);
    for (const m of [p.raw, p.cleaned]) {
      if (!m) continue;
      if (
        !Array.isArray(m.box) ||
        m.box.length !== 4 ||
        !m.box.every(Number.isInteger) ||
        m.box[0] < 0 ||
        m.box[1] < 0 ||
        m.box[2] < 1 ||
        m.box[3] < 1 ||
        m.box[0] + m.box[2] > width ||
        m.box[1] + m.box[3] > height ||
        !Array.isArray(m.runs) ||
        m.runs.length % 2
      )
        throw Error("Invalid diagnostic mask");
      let end = 0,
        area = 0;
      for (let i = 0; i < m.runs.length; i += 2) {
        const start = m.runs[i],
          length = m.runs[i + 1];
        if (
          !Number.isInteger(start) ||
          !Number.isInteger(length) ||
          start < end ||
          length < 1 ||
          start + length > width * height
        )
          throw Error("Invalid diagnostic mask run");
        end = start + length;
        area += length;
      }
      if (area !== m.area || !area) throw Error("Invalid diagnostic mask area");
    }
  }
  return value;
}
export function stageCount(stage, segmentation, regions) {
  const d = segmentation?.diagnostics;
  if (stage === "original") return null;
  if (stage === "matches") return regions.length;
  if (stage === "yolo")
    return segmentation?.method?.includes("YOLO")
      ? segmentation.brickDetections.length
      : null;
  if (stage === "raw")
    return d ? d.proposals.filter((p) => p.raw).length : null;
  if (stage === "cleaned")
    return d ? d.proposals.filter((p) => p.cleaned).length : null;
  if (stage === "rejected")
    return d
      ? d.proposals.filter((p) => p.decision === "rejected").length
      : null;
  if (stage === "features")
    return segmentation
      ? segmentation.components.reduce(
          (n, r) =>
            n +
            (r.studDetections?.length || 0) +
            (r.tubeDetections?.length || 0),
          0,
        )
      : null;
  if (stage === "retained")
    return segmentation ? segmentation.components.length : null;
  return null;
}
export function paintMask(
  ctx,
  mask,
  width,
  height,
  targetWidth,
  targetHeight,
  color,
) {
  // Row-wise spans retain the exact foreground, including holes, with no
  // expansion into a second full-resolution pixel array per proposal.
  const sx = targetWidth / width,
    sy = targetHeight / height;
  ctx.fillStyle = color;
  for (let i = 0; i < mask.runs.length; i += 2) {
    let start = mask.runs[i],
      length = mask.runs[i + 1];
    while (length) {
      const x = start % width,
        y = Math.floor(start / width),
        n = Math.min(length, width - x);
      ctx.fillRect(x * sx, y * sy, n * sx, sy);
      start += n;
      length -= n;
    }
  }
}

export function outlineMask(ctx, mask, width, height, targetWidth, targetHeight, color, lineWidth = 2) {
  // Trace exposed span edges, including holes, without stroking every pixel
  // or introducing internal scanline seams. No full-photo mask allocation.
  const rows = new Map(), sx = targetWidth / width, sy = targetHeight / height;
  for (let i = 0; i < mask.runs.length; i += 2) {
    let start = mask.runs[i], remaining = mask.runs[i + 1];
    while (remaining) {
      const x = start % width, y = Math.floor(start / width), n = Math.min(remaining, width - x);
      if (!rows.has(y)) rows.set(y, []);
      const spans = rows.get(y), last = spans.at(-1);
      if (last && last[1] === x) last[1] = x + n;
      else spans.push([x, x + n]);
      start += n; remaining -= n;
    }
  }
  ctx.save();
  ctx.globalAlpha = 1;
  ctx.beginPath();
  const edge = (x0, y0, x1, y1) => {
    ctx.moveTo(x0 * sx, y0 * sy); ctx.lineTo(x1 * sx, y1 * sy);
  };
  const exposed = (start, end, neighbours, y) => {
    let cursor = start;
    for (const [a, b] of neighbours) {
      if (b <= cursor) continue;
      if (a >= end) break;
      if (a > cursor) edge(cursor, y, Math.min(a, end), y);
      cursor = Math.max(cursor, b);
      if (cursor >= end) return;
    }
    if (cursor < end) edge(cursor, y, end, y);
  };
  for (const [y, spans] of rows) for (const [a, b] of spans) {
    edge(a, y, a, y + 1); edge(b, y, b, y + 1);
    exposed(a, b, rows.get(y - 1) || [], y);
    exposed(a, b, rows.get(y + 1) || [], y + 1);
  }
  // Dark halo makes the opaque coloured contour visible on light and dark bricks.
  ctx.lineCap = "round";
  ctx.strokeStyle = "#172940";
  ctx.lineWidth = lineWidth + 2;
  ctx.stroke();
  ctx.strokeStyle = color;
  ctx.lineWidth = lineWidth;
  ctx.stroke();
  ctx.restore();
}
