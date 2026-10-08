"""Conservative local hollow-tube proposals; no model or network required."""
def detect_tubes(rgb, box, mask):
    import cv2
    import numpy as np
    x, y, width, height = box
    crop = rgb[y:y+height, x:x+width]
    gray = cv2.GaussianBlur(cv2.cvtColor(crop, cv2.COLOR_RGB2GRAY), (3, 3), .8)
    contours, _ = cv2.findContours(cv2.Canny(gray, 20, 60), cv2.RETR_LIST, cv2.CHAIN_APPROX_NONE)
    candidates = []
    for contour in contours:
        if len(contour) < 16:
            continue
        (cx, cy), (a, b), angle = cv2.fitEllipse(contour)
        if min(a, b) < 10 or max(a, b) > min(width, height)*.65 or min(a, b)/max(a, b) < .45:
            continue
        fit = cv2.contourArea(contour)/(np.pi*a*b/4)
        if not .8 <= fit <= 1.2:
            continue
        # A hollow opening must be darker than its surrounding material in
        # most directions; bright solid stud heads must not become tubes.
        theta = np.arange(24)*np.pi/12
        rotation = angle*np.pi/180
        dx = a/2*np.cos(theta)*np.cos(rotation)-b/2*np.sin(theta)*np.sin(rotation)
        dy = a/2*np.cos(theta)*np.sin(rotation)+b/2*np.sin(theta)*np.cos(rotation)
        samples = []
        valid = True
        for scale in (.55, 1.3):
            xs, ys = np.rint(cx+dx*scale).astype(int), np.rint(cy+dy*scale).astype(int)
            if np.any(xs < 0) or np.any(xs >= width) or np.any(ys < 0) or np.any(ys >= height) or not np.all(mask[y+ys, x+xs]):
                valid = False
                break
            samples.append(gray[ys, xs].astype(float))
        if not valid:
            continue
        contrast = samples[1]-samples[0]
        support = float(np.mean(contrast > 8))
        if support < .7 or np.median(contrast) < 12:
            continue
        candidates.append({"x": x+cx, "y": y+cy, "radius": (a+b)/4,
                           "ellipse": [a/2, b/2, angle], "confidence": min(.95, support),
                           "source": "hollow-ellipse"})
    candidates.sort(key=lambda p: -p["confidence"])
    dots = []
    for dot in candidates:
        if all(np.hypot(dot["x"]-p["x"], dot["y"]-p["y"]) > max(dot["radius"], p["radius"])*.8 for p in dots):
            dots.append(dot)
    return dots[:200]

