export function lab(rgb) {
  const linear = rgb.map((n) => {
      const c = n / 255;
      return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
    }),
    [r, g, b] = linear,
    f = (t) => (t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116),
    x = f((0.4124564 * r + 0.3575761 * g + 0.1804375 * b) / 0.95047),
    y = f(0.2126729 * r + 0.7151522 * g + 0.072175 * b),
    z = f((0.0193339 * r + 0.119192 * g + 0.9503041 * b) / 1.08883);
  return [116 * y - 16, 500 * (x - y), 200 * (y - z)];
}
export function colourDistance(rgb, hex) {
  if (!rgb || !hex || !/^#?[a-f\d]{6}$/i.test(hex)) return null;
  const expected = hex
      .replace("#", "")
      .match(/../g)
      .map((n) => parseInt(n, 16)),
    a = lab(rgb),
    b = lab(expected);
  return Math.hypot(...a.map((n, i) => n - b[i]));
}
export function estimateColour(image, pixels) {
  const samples = [];
  for (
    let i = 0;
    i < pixels.length;
    i += Math.max(1, Math.floor(pixels.length / 400))
  ) {
    const k = pixels[i] * 4,
      rgb = [...image.data.slice(k, k + 3)];
    samples.push({
      rgb,
      light: rgb[0] * 0.299 + rgb[1] * 0.587 + rgb[2] * 0.114,
    });
  }
  samples.sort((a, b) => a.light - b.light);
  const kept = samples.slice(
    Math.floor(samples.length * 0.25),
    Math.ceil(samples.length * 0.85),
  );
  if (!kept.length) return null;
  return [0, 1, 2].map(
    (c) =>
      kept.map((p) => p.rgb[c]).sort((a, b) => a - b)[
        Math.floor(kept.length / 2)
      ],
  );
}
