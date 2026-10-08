import { colourDistance } from "./colour.mjs";
export function candidateOptions(
  region,
  requirements,
  { matchColours = true } = {},
) {
  if (region.manualKey) {
    const r = requirements.find((r) => r.key === region.manualKey);
    return r
      ? [
          {
            key: r.key,
            score: 1,
            visual: 0,
            face: region.face || "top",
            ambiguous: true,
            manual: true,
          },
        ]
      : [];
  }
  const best =
      region.scores?.[0]?.visualScore ?? region.scores?.[0]?.score ?? 0,
    options = [];
  for (const requirement of requirements) {
    if (!requirement.matchId) continue;
    const hit = (region.scores || []).find(
      (s) =>
        s.id === requirement.matchId ||
        s.family === requirement.matchId ||
        s.variants?.includes(requirement.matchId),
    );
    if (!hit) continue;
    const visual = hit.visualScore ?? hit.score,
      distance = colourDistance(region.rgb, requirement.color.rgb);
    if (
      visual < 0.82 ||
      best - visual > 0.055 ||
      (hit.surface?.penalty || 0) > 0.17
    )
      continue;
    if (
      matchColours &&
      (distance === null || distance > 32 || requirement.color.isTrans)
    )
      continue;
    const colourScore = distance === null ? 0 : Math.exp(-distance / 30),
      score = matchColours ? 0.82 * visual + 0.18 * colourScore : visual;
    options.push({
      key: requirement.key,
      score,
      visual,
      colourDistance: distance,
      view: hit.view,
      face: hit.face || "top",
      ambiguous:
        requirement.printed ||
        !matchColours ||
        visual < 0.9 ||
        (distance ?? 100) > 18 ||
        best - visual > 0.025,
    });
  }
  return options.sort(
    (a, b) => b.score - a.score || a.key.localeCompare(b.key),
  );
}
// Maximum-weight bipartite b-matching. Residual edges allow reassignment, so
// detection order cannot steal the only usable brick for another requirement.
export function allocate(regions, requirements, { matchColours = true } = {}) {
  const remaining = new Map(requirements.map((r) => [r.key, r.quantity])),
    assignments = new Map(),
    eligible = [];
  for (const region of regions) {
    if (region.rejected) continue;
    if (region.confirmed) {
      const key = region.manualKey;
      if (!remaining.has(key) || remaining.get(key) < 1)
        throw Error("Confirmed assignments exceed the set quantity");
      remaining.set(key, remaining.get(key) - 1);
      assignments.set(region.uid, {
        key,
        confirmed: true,
        ambiguous: false,
        score: 1,
      });
    } else eligible.push(region);
  }
  const keys = requirements
      .filter((r) => remaining.get(r.key) > 0)
      .map((r) => r.key),
    partIndex = new Map(keys.map((k, i) => [k, i])),
    n = 2 + eligible.length + keys.length,
    source = n - 2,
    sink = n - 1,
    graph = Array.from({ length: n }, () => []);
  function edge(a, b, cap, cost, option) {
    const forward = { to: b, rev: graph[b].length, cap, cost, option },
      back = { to: a, rev: graph[a].length, cap: 0, cost: -cost };
    graph[a].push(forward);
    graph[b].push(back);
  }
  for (let i = 0; i < eligible.length; i++) {
    edge(source, i, 1, 0);
    for (const option of candidateOptions(eligible[i], requirements, {
      matchColours,
    }))
      if (partIndex.has(option.key))
        edge(
          i,
          eligible.length + partIndex.get(option.key),
          1,
          -Math.round(option.score * 100000),
          option,
        );
  }
  keys.forEach((key, i) =>
    edge(eligible.length + i, sink, remaining.get(key), 0),
  );
  while (true) {
    const distance = new Float64Array(n).fill(Infinity),
      prev = Array(n),
      inQueue = new Uint8Array(n),
      queue = [source];
    distance[source] = 0;
    inQueue[source] = 1;
    for (let head = 0; head < queue.length; head++) {
      const a = queue[head];
      inQueue[a] = 0;
      for (let i = 0; i < graph[a].length; i++) {
        const e = graph[a][i];
        if (e.cap > 0 && distance[e.to] > distance[a] + e.cost) {
          distance[e.to] = distance[a] + e.cost;
          prev[e.to] = [a, i];
          if (!inQueue[e.to]) {
            inQueue[e.to] = 1;
            queue.push(e.to);
          }
        }
      }
    }
    if (!prev[sink] || distance[sink] >= 0) break;
    for (let node = sink; node !== source; ) {
      const [a, i] = prev[node],
        e = graph[a][i];
      e.cap--;
      graph[node][e.rev].cap++;
      node = a;
    }
  }
  eligible.forEach((region, i) => {
    const match = graph[i].find((e) => e.option && e.cap === 0);
    if (match) {
      const options = candidateOptions(region, requirements, { matchColours }),
        margin = options.length > 1 ? options[0].score - options[1].score : 1;
      assignments.set(region.uid, {
        ...match.option,
        confirmed: false,
        ambiguous: match.option.ambiguous || margin < 0.025,
      });
    }
  });
  const coverage = requirements.map((r) => {
    let confirmed = 0,
      suggested = 0;
    for (const a of assignments.values())
      if (a.key === r.key) a.confirmed ? confirmed++ : suggested++;
    return {
      key: r.key,
      required: r.quantity,
      confirmed,
      suggested,
      notLocated: Math.max(0, r.quantity - confirmed - suggested),
    };
  });
  return { assignments, coverage };
}
export function exportReport(set, regions, requirements, allocation) {
  return {
    format: "set-brick-review",
    version: 1,
    set: { number: set.number, name: set.name },
    requirements: allocation.coverage.map((c) => ({
      ...c,
      ...Object.fromEntries(
        ["id", "colorId"].map((k) => [
          k,
          requirements.find((r) => r.key === c.key)[k],
        ]),
      ),
    })),
    regions: regions.map((r) => ({
      uid: r.uid,
      requirementKey: allocation.assignments.get(r.uid)?.key || null,
      state: r.rejected
        ? "rejected"
        : r.confirmed
          ? "confirmed"
          : allocation.assignments.has(r.uid)
            ? "suggested"
            : "unassigned",
    })),
    note: "Suggestions are not verified identities. No photo pixels included.",
  };
}
