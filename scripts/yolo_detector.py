"""Local LEGO-specific YOLOv8 nano inference; photos stay in memory."""
import contextlib
import os
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
MODELS = {}


def load_detectors():
    if not MODELS:
        os.environ["YOLO_CONFIG_DIR"] = str(ROOT / ".cache/yolo/config")
        os.environ["MPLCONFIGDIR"] = str(ROOT / ".cache/yolo/matplotlib")
        os.environ["YOLO_AUTOINSTALL"] = "false"
        # The upstream library may print setup messages; reserve stdout for
        # the worker's JSON protocol, including during first-time imports.
        with contextlib.redirect_stdout(sys.stderr):
            from ultralytics import YOLO, settings
            settings.update({"sync": False})
            for name in ("bricks", "studs"):
                model = YOLO(str(ROOT / f".cache/yolo/{name}.pt"))
                if len(model.names) != 1:
                    raise ValueError("Expected the pinned single-class LEGO detector")
                MODELS[name] = model
    return MODELS


def detect_bricks(rgb, detailed=False):
    model = load_detectors()["bricks"]
    result = model.predict(rgb[:, :, ::-1], imgsz=1536 if detailed else 1280, conf=.2, iou=.45, device="cpu", verbose=False)[0]
    return [{"box": b.xyxy[0].tolist(), "confidence": float(b.conf)} for b in result.boxes]


def tile_boxes(width, height, size=1536, overlap=.25):
    """Cover the source image with overlapping tiles, including trailing edges."""
    def starts(length):
        if length <= size:
            return [0]
        step = round(size*(1-overlap))
        values = list(range(0, length-size+1, step))
        if values[-1] != length-size:
            values.append(length-size)
        return values
    return [(x, y, min(width, x+size), min(height, y+size))
            for y in starts(height) for x in starts(width)]


def merge_detections(detections, iou=.45):
    """IoU-only NMS: nested boxes are not automatically duplicates."""
    kept = []
    for detection in sorted(detections, key=lambda d: -d["confidence"]):
        a = detection["box"]
        area = max(0, a[2]-a[0])*max(0, a[3]-a[1])
        if not area:
            continue
        duplicate = False
        for other in kept:
            b = other["box"]
            intersection = max(0, min(a[2], b[2])-max(a[0], b[0]))*max(0, min(a[3], b[3])-max(a[1], b[1]))
            union = area + (b[2]-b[0])*(b[3]-b[1]) - intersection
            if intersection/max(union, 1) > iou:
                duplicate = True
                break
        if not duplicate:
            kept.append(detection)
    return kept


def detect_bricks_tiled(rgb, detailed=False, on_progress=lambda message: None, detector=None):
    """Whole-image proposals plus original-resolution tiles; no retraining."""
    detector = detector or detect_bricks
    height, width = rgb.shape[:2]
    tiles = tile_boxes(width, height)
    on_progress({"type": "progress", "phase": "detect", "message": "YOLO: whole-image detection…"})
    proposals = [{**d, "source": "whole-image"} for d in detector(rgb, detailed=detailed)]
    # A source already fitting one tile only needs the whole-image pass.
    if len(tiles) == 1:
        tiles = []
    for index, (x, y, x1, y1) in enumerate(tiles):
        on_progress({"type": "progress", "phase": "detect", "completed": index,
                     "total": len(tiles), "message": f"YOLO source tile {index+1} / {len(tiles)}…"})
        for detection in detector(rgb[y:y1, x:x1], detailed=detailed):
            a, b, c, d = detection["box"]
            # Cut-off tile-edge proposals can duplicate fragments of a larger
            # part. Overlap and the full-image pass supply complete proposals.
            if ((x > 0 and a <= 8) or (y > 0 and b <= 8) or
                (x1 < width and c >= x1-x-8) or (y1 < height and d >= y1-y-8)):
                continue
            proposals.append({**detection, "box": [a+x, b+y, c+x, d+y], "source": "tile", "tile": index+1})
        on_progress({"type": "progress", "phase": "detect", "completed": index+1,
                     "total": len(tiles), "message": f"YOLO source tiles {index+1} / {len(tiles)} compared · {len(proposals)} proposals before merging"})
    merged = merge_detections(proposals)
    if len(merged) > 200:
        raise ValueError("More than 200 detector proposals. Photograph fewer separated pieces.")
    return merged, {"tiles": len(tiles), "tileSize": 1536, "overlap": .25,
                    "rawProposals": len(proposals), "mergedProposals": len(merged)}


def detect_studs(rgb, box, mask):
    """Detect on each original-resolution crop; retain centres inside its mask."""
    h, w = rgb.shape[:2]
    x, y, bw, bh = box
    crop = rgb[y:y+bh, x:x+bw]
    result = load_detectors()["studs"].predict(crop[:, :, ::-1], imgsz=640, conf=.25, iou=.35, device="cpu", verbose=False)[0]
    dots = []
    for b in result.boxes:
        x0, y0, x1, y1 = b.xyxy[0].tolist()
        cx, cy = x+(x0+x1)/2, y+(y0+y1)/2
        ix, iy = int(round(cx)), int(round(cy))
        if 0 <= ix < w and 0 <= iy < h and mask[iy, ix]:
            dots.append({"x": cx, "y": cy, "radius": ((x1-x0)+(y1-y0))/4,
                         "box": [x+x0, y+y0, x1-x0, y1-y0], "confidence": float(b.conf)})
    return dots
