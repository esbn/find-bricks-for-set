// Follow explicit LDraw redirects only; never guess mould/suffix equivalence.
export function mappedCadPart(id, byId, families) {
  let part = byId.get(id);
  const seen = new Set();
  while (part?.aliasOf) {
    if (seen.has(part.id)) throw Error("Circular LDraw redirect");
    seen.add(part.id);
    part = byId.get(part.aliasOf.replace(/\.dat$/i, ""));
  }
  if (!part || part.alias) return null;
  return families.get(part.id) || part.id;
}
