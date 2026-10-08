"""Original-resolution YOLO tiles and local SAM crops; working-photo outputs."""
import math


def context_box(box, width, height):
    x0, y0, x1, y1 = box
    pad = max(64, max(x1-x0, y1-y0)*.35)
    return (max(0, math.floor(x0-pad)), max(0, math.floor(y0-pad)),
            min(width, math.ceil(x1+pad)), min(height, math.ceil(y1+pad)))


def project_mask(mask, crop_box, source_size, working_size):
    """Place a local source mask into the existing bounded photo coordinate grid."""
    import numpy as np
    sw, sh = source_size
    ww, wh = working_size
    x0, y0, x1, y1 = crop_box
    a, b = int(x0*ww/sw), int(y0*wh/sh)
    c, d = min(ww, math.ceil(x1*ww/sw)), min(wh, math.ceil(y1*wh/sh))
    result = np.zeros((wh, ww), dtype=bool)
    # Inverse-map output pixel centres to source coordinates: avoid shifting
    # outlines by independently stretching each rounded crop rectangle.
    xs = np.clip(((np.arange(a, c)+.5)*sw/ww-x0).astype(int), 0, mask.shape[1]-1)
    ys = np.clip(((np.arange(b, d)+.5)*sh/wh-y0).astype(int), 0, mask.shape[0]-1)
    result[b:d, a:c] = mask[np.ix_(ys, xs)]
    return result


def run_overlap(a, b):
    """Intersection pixel count of two sorted row-major run lists."""
    i = j = count = 0
    while i < len(a) and j < len(b):
        start_a, end_a = a[i], a[i]+a[i+1]
        start_b, end_b = b[j], b[j]+b[j+1]
        count += max(0, min(end_a, end_b)-max(start_a, start_b))
        if end_a <= end_b:
            i += 2
        else:
            j += 2
    return count


def project_feature(feature, origin, scale):
    x, y = origin
    sx, sy = scale
    out = {**feature, "x": (feature["x"]+x)*sx, "y": (feature["y"]+y)*sy,
           "radius": feature["radius"]*(sx+sy)/2}
    if "box" in feature:
        a, b, w, h = feature["box"]
        out["box"] = [(a+x)*sx, (b+y)*sy, w*sx, h*sy]
    if "ellipse" in feature:
        a, b, angle = feature["ellipse"]
        out["ellipse"] = [a*sx, b*sy, angle]
    return out


def segment_tiled(source_rgb, working_rgb, model, emit, select_objects, mask_record, detailed=False):
    import time
    import numpy as np
    from mobile_sam import SamPredictor
    from yolo_detector import detect_bricks_tiled, detect_studs
    from tube_detector import detect_tubes
    started = time.monotonic()
    sh, sw = source_rgb.shape[:2]
    wh, ww = working_rgb.shape[:2]
    detections, stats = detect_bricks_tiled(source_rgb, detailed=detailed, on_progress=emit)
    if not detections:
        raise ValueError("YOLO found no bricks. Try Local SAM in Photo settings.")
    predictor = SamPredictor(model)
    diagnostics, components = [], []
    rejected = {"background": 0, "texture": 0, "nested": 0}
    sx, sy = ww/sw, wh/sh
    for index, detection in enumerate(detections):
        emit({"type": "progress", "phase": "segment", "completed": index, "total": len(detections),
              "message": f"Local SAM source crop {index+1} / {len(detections)} · {stats['tiles']} YOLO tiles merged"})
        crop_box = context_box(detection["box"], sw, sh)
        x, y, x1, y1 = crop_box
        crop = source_rgb[y:y1, x:x1]
        box = np.array(detection["box"])-np.array([x, y, x, y])
        predictor.set_image(crop)
        masks, scores, _ = predictor.predict(box=box, multimask_output=False)
        record = {"segmentation": masks[0], "area": int(masks[0].sum()), "predicted_iou": float(scores[0]),
                  "detectorBox": box.tolist(), "detectorConfidence": detection["confidence"]}
        trace = []
        selected, counts = select_objects([record], crop, trace)
        for key in rejected:
            rejected[key] += counts[key]
        p = trace[0]
        p["id"] = index+1
        p["sourceBox"] = list(crop_box)
        p["detectorSource"] = detection["source"]
        p["raw"] = mask_record(project_mask(masks[0], crop_box, (sw, sh), (ww, wh)))
        p["cleaned"] = None
        if selected:
            obj = selected[0]
            projected = project_mask(obj["mask"], crop_box, (sw, sh), (ww, wh))
            cleaned = mask_record(projected)
            p["cleaned"] = cleaned
            if not cleaned:
                p.update(decision="rejected", reason="below display resolution")
                rejected["background"] += 1
            elif any(run_overlap(cleaned["runs"], c["runs"])/cleaned["area"] > .85 for c in components):
                p.update(decision="rejected", reason="duplicate/nested")
                rejected["nested"] += 1
            else:
                cx, cy, cw, ch = cleaned["box"]
                margin = max(4, round(max(cw, ch)*.04))
                left, top = max(0, cx-margin), max(0, cy-margin)
                right, bottom = min(ww, cx+cw+margin), min(wh, cy+ch+margin)
                emit({"type": "progress", "phase": "studs",
                      "message": f"Surface features on source crop {index+1} / {len(detections)}…"})
                ys, xs = np.where(obj["mask"])
                pad = max(4, round(max(xs.max()-xs.min(), ys.max()-ys.min())*.04))
                fx, fy = max(0, int(xs.min())-pad), max(0, int(ys.min())-pad)
                fr, fb = min(crop.shape[1], int(xs.max())+pad+1), min(crop.shape[0], int(ys.max())+pad+1)
                feature_box = [fx, fy, fr-fx, fb-fy]
                studs = detect_studs(crop, feature_box, obj["mask"])
                tubes = detect_tubes(crop, feature_box, obj["mask"])
                components.append({**cleaned, "box": [left, top, right-left, bottom-top],
                                   "proposalId": index+1, "maskQuality": obj["quality"], "textureRatio": obj["textureRatio"],
                                   "studDetections": [project_feature(f, (x, y), (sx, sy)) for f in studs],
                                   "tubeDetections": [project_feature(f, (x, y), (sx, sy)) for f in tubes]})
        elif p["cleaned"] is None:
            # Keep the real principal component even for rejected proposals.
            import cv2
            count, labels, regions, _ = cv2.connectedComponentsWithStats(masks[0].astype("uint8"), 8)
            if count > 1:
                main = 1+int(np.argmax(regions[1:, cv2.CC_STAT_AREA]))
                p["cleaned"] = mask_record(project_mask(labels == main, crop_box, (sw, sh), (ww, wh)))
        diagnostics.append(p)
    components.sort(key=lambda c: -c["area"])
    emit({"type": "progress", "phase": "segment", "completed": len(detections), "total": len(detections),
          "message": f"Tiled detection complete: {len(components)} retained regions from {len(detections)} merged proposals"})
    return {"type": "result", "method": "YOLO + MobileSAM · source tiles", "width": ww, "height": wh,
            "components": components, "proposals": len(detections), "rejected": rejected,
            "brickDetections": [{**d, "box": [d["box"][0]*sx, d["box"][1]*sy, d["box"][2]*sx, d["box"][3]*sy]} for d in detections],
            "diagnostics": {"width": ww, "height": wh, "proposals": diagnostics, "total": len(detections), "truncated": False},
            "tiling": {**stats, "sourceWidth": sw, "sourceHeight": sh, "localSamCrops": len(detections)},
            "elapsedMs": round((time.monotonic()-started)*1000)}
