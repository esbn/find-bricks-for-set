"""Persistent local MobileSAM worker. NDJSON on stdin/stdout; no network I/O."""
import base64
import io
import json
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
MODEL = None


def emit(message):
    print(json.dumps(message, separators=(",", ":")), flush=True)


def load_model():
    global MODEL
    if MODEL is None:
        emit({"type": "progress", "phase": "loading", "message": "Loading Local SAM on this computer…"})
        import torch
        from mobile_sam import sam_model_registry
        torch.set_num_threads(4)
        MODEL = sam_model_registry["vit_t"](checkpoint=str(ROOT / ".cache/sam/mobile_sam.pt"))
        MODEL.to(device="cpu").eval()
    return MODEL


def select_objects(records, image, diagnostics=None):
    """Prefer whole objects; use detector support before rejecting texture/size.

    Automatic SAM proposals remain conservative. A confident YOLO prompt and
    a good SAM mask contained within that prompt support small/textured parts.
    SAM quality alone is not a semantic brick score.
    """
    import cv2
    import numpy as np
    h, w = image.shape[:2]
    gray = cv2.cvtColor(image.astype("float32"), cv2.COLOR_RGB2GRAY)
    mean = cv2.GaussianBlur(gray, (5, 5), 0)
    texture = np.abs(gray - mean) / np.maximum(mean, 20)
    selected = []
    rejected = {"background": 0, "texture": 0, "nested": 0}
    for index, record in sorted(enumerate(records), key=lambda pair: -pair[1]["area"]):
        mask = record["segmentation"].astype("uint8")
        trace = None
        if diagnostics is not None and len(diagnostics) < 400:
            trace = {"id": index+1, "raw": mask_record(mask), "cleaned": None,
                     "decision": "rejected", "reason": "empty", "quality": float(record["predicted_iou"])}
            diagnostics.append(trace)
        # Keep the principal connected region, not remote speckles.
        count, labels, stats, _ = cv2.connectedComponentsWithStats(mask, 8)
        if count < 2:
            continue
        main = 1 + int(np.argmax(stats[1:, cv2.CC_STAT_AREA]))
        mask = labels == main
        if trace is not None:
            trace["cleaned"] = mask_record(mask)
        area = int(mask.sum())
        ys, xs = np.where(mask)
        detector_supported = False
        box = record.get("detectorBox")
        if box is not None and record.get("detectorConfidence", 0) >= .2 and record["predicted_iou"] >= .8:
            x0, y0, x1, y1 = box
            # Allow slight outline refinement, but not a mask leaking far into
            # carpet outside its detection. Holes and thin frames are allowed.
            dx, dy = max(2, (x1-x0)*.1), max(2, (y1-y0)*.1)
            detector_supported = float(np.mean((xs >= x0-dx) & (xs <= x1+dx) &
                                                (ys >= y0-dy) & (ys <= y1+dy))) >= .9
        minimum_area = max(20, w*h*.00003) if detector_supported else max(90, w*h*.0005)
        if trace is not None:
            trace["detectorSupported"] = detector_supported
            trace["warnings"] = []
        if area < minimum_area or area > w*h*.6 or xs.min() == 0 or ys.min() == 0 or xs.max() == w-1 or ys.max() == h-1:
            rejected["background"] += 1
            if trace is not None:
                trace["reason"] = "size" if area < minimum_area else "boundary/background"
            continue
        if any(np.count_nonzero(mask & other["mask"]) / area > .85 for other in selected):
            rejected["nested"] += 1
            if trace is not None:
                trace["reason"] = "duplicate/nested"
            continue
        inner = cv2.erode(mask.astype("uint8"), np.ones((5, 5), np.uint8)) > 0
        ring = (cv2.dilate(mask.astype("uint8"), np.ones((21, 21), np.uint8)) > 0) & ~mask
        inside_texture = float(np.median(texture[inner])) if inner.any() else 0
        outside_texture = float(np.median(texture[ring])) if ring.any() else 0
        ratio = inside_texture / max(outside_texture, .001)
        if trace is not None:
            trace["textureRatio"] = ratio
        # In a textured scene, a shadow often has the same relative high-
        # frequency variation as its surroundings. On a smooth background
        # this test is disabled; darkness alone never rejects an object.
        if outside_texture > .02 and ratio > .95:
            if not detector_supported:
                rejected["texture"] += 1
                if trace is not None:
                    trace["reason"] = "texture/shadow"
                continue
            if trace is not None:
                trace["warnings"].append("texture/shadow heuristic overridden by YOLO + SAM support")
        if trace is not None:
            trace.update(decision="retained", reason=None)
        selected.append({"mask": mask, "area": area, "quality": float(record["predicted_iou"]), "textureRatio": ratio, "proposalId": index+1})
    return selected, rejected


def encode_mask(mask):
    """Row-major foreground start,length pairs (not COCO column-major RLE)."""
    import numpy as np
    flat = mask.reshape(-1).astype("int8")
    changes = np.diff(np.pad(flat, (1, 1)))
    starts = np.where(changes == 1)[0]
    ends = np.where(changes == -1)[0]
    return np.column_stack((starts, ends-starts)).reshape(-1).tolist()


def mask_record(mask):
    import numpy as np
    ys, xs = np.where(mask)
    if not len(xs):
        return None
    return {"box": [int(xs.min()), int(ys.min()), int(xs.max()-xs.min()+1), int(ys.max()-ys.min()+1)],
            "area": int(mask.sum()), "runs": encode_mask(mask)}


def segment(payload):
    started = time.monotonic()
    model = load_model()
    import cv2
    import numpy as np
    from PIL import Image, ImageOps
    from mobile_sam import SamAutomaticMaskGenerator, SamPredictor
    image = ImageOps.exif_transpose(Image.open(io.BytesIO(base64.b64decode(payload["image"], validate=True))))
    width, height = image.size
    if width < 16 or height < 16 or max(width, height) > 1800:
        raise ValueError("Local SAM expects an image with its longest edge at most 1800 pixels.")
    image = image.convert("RGB")
    original_rgb = np.array(image)
    image.thumbnail((1024, 1024), Image.Resampling.LANCZOS)
    rgb = np.array(image)
    density = payload.get("density", 16)
    if density not in (16, 32):
        raise ValueError("Invalid search density")
    if payload.get("tiled"):
        if payload.get("mode") != "yolo":
            raise ValueError("Source tiling requires YOLO mode.")
        source = ImageOps.exif_transpose(Image.open(io.BytesIO(base64.b64decode(payload.get("sourceImage", payload["image"]), validate=True))))
        if source.width * source.height > 32000000 or max(source.size) > 10000 or min(source.size) < 16:
            raise ValueError("Source photo exceeds the 32-megapixel / 10,000-pixel limit.")
        if abs(source.width/source.height-width/height) > .01:
            raise ValueError("Source and working photo aspect ratios do not match.")
        from tiled_pipeline import segment_tiled
        return segment_tiled(np.array(source.convert("RGB")), original_rgb, model, emit, select_objects, mask_record, detailed=density == 32)

    class ProgressGenerator(SamAutomaticMaskGenerator):
        done = 0

        def _process_batch(self, *args, **kwargs):
            out = super()._process_batch(*args, **kwargs)
            self.done += len(args[0])
            emit({"type": "progress", "phase": "segment", "completed": self.done, "total": density*density,
                  "message": f"Local SAM: {self.done} / {density*density} image points examined · {round(time.monotonic()-started)} s"})
            return out

    mode = payload.get("mode", "sam")
    if mode not in ("sam", "yolo"):
        raise ValueError("Invalid detection mode")
    brick_detections = []
    if mode == "yolo":
        from yolo_detector import detect_bricks
        emit({"type": "progress", "phase": "detect", "message": "YOLO is detecting LEGO bricks…"})
        brick_detections = detect_bricks(original_rgb, detailed=density == 32)
        if not brick_detections:
            raise ValueError("YOLO found no bricks. Try Local SAM in Photo settings.")
        emit({"type": "progress", "phase": "encoding", "message": f"YOLO found {len(brick_detections)} bricks. SAM is refining their outlines…"})
        predictor = SamPredictor(model)
        predictor.set_image(rgb)
        records = []
        scale = np.array([rgb.shape[1]/width, rgb.shape[0]/height]*2)
        for i, detection in enumerate(brick_detections):
            masks, scores, _ = predictor.predict(box=np.array(detection["box"])*scale, multimask_output=False)
            records.append({"segmentation": masks[0], "area": int(masks[0].sum()), "predicted_iou": float(scores[0]),
                            "detectorConfidence": detection["confidence"], "detectorBox": (np.array(detection["box"])*scale).tolist()})
            emit({"type": "progress", "phase": "segment", "completed": i+1, "total": len(brick_detections),
                  "message": f"SAM refined {i+1} / {len(brick_detections)} brick outlines"})
    else:
        generator = ProgressGenerator(model, points_per_side=density, points_per_batch=8,
                                      pred_iou_thresh=.85, stability_score_thresh=.9, min_mask_region_area=100)
        emit({"type": "progress", "phase": "encoding", "message": "Local SAM is analysing the image on the CPU…"})
        records = generator.generate(rgb)
    diagnostics = []
    selected, rejected = select_objects(records, rgb, diagnostics)
    components = []
    for obj in selected:
        mask = cv2.resize(obj["mask"].astype("uint8"), (width, height), interpolation=cv2.INTER_NEAREST).astype(bool)
        ys, xs = np.where(mask)
        # Crop margin is display context only; descriptor pixels stay exact.
        margin = max(4, round(max(xs.max()-xs.min(), ys.max()-ys.min())*.04))
        x0, y0 = max(0, int(xs.min())-margin), max(0, int(ys.min())-margin)
        x1, y1 = min(width, int(xs.max())+margin+1), min(height, int(ys.max())+margin+1)
        component = {"box": [x0, y0, x1-x0, y1-y0], "area": int(mask.sum()), "runs": encode_mask(mask),
                     "maskQuality": obj["quality"], "textureRatio": obj["textureRatio"], "proposalId": obj["proposalId"]}
        if mode == "yolo":
            from yolo_detector import detect_studs
            emit({"type": "progress", "phase": "studs", "message": f"YOLO is detecting studs on brick {len(components)+1} / {len(selected)}…"})
            component["studDetections"] = detect_studs(original_rgb, component["box"], mask)
        from tube_detector import detect_tubes
        component["tubeDetections"] = detect_tubes(original_rgb, component["box"], mask)
        components.append(component)
    components.sort(key=lambda c: -c["area"])
    return {"type": "result", "method": "YOLO + MobileSAM" if mode == "yolo" else "MobileSAM", "width": width, "height": height,
            "components": components, "proposals": len(records), "rejected": rejected,
            "brickDetections": brick_detections,
            "diagnostics": {"width": rgb.shape[1], "height": rgb.shape[0], "proposals": diagnostics,
                            "total": len(records), "truncated": len(records) > len(diagnostics)},
            "elapsedMs": round((time.monotonic()-started)*1000)}


if __name__ == "__main__":
    for line in sys.stdin:
        try:
            emit(segment(json.loads(line)))
        except Exception as error:
            emit({"type": "error", "message": str(error)})
