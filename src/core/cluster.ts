// Spec §7.5 — MST balloon clustering + reading order. Pure logic, no DOM.

// assumption taken — the s5 dispatch allows only cluster.ts + its test, so the
// Polygon type cannot be imported from src/core/det.ts (§7.3 owner); it is
// declared here, structurally identical to §7.3, making the two mutually
// assignable under TypeScript structural typing (noted in docs/ASSUMPTIONS.md).
export type Polygon = { pts: [number, number][]; score: number };

export interface Line {
  poly: Polygon;
  text: string;
  score: number;
  cx: number;
  cy: number;
  h: number;
}

export interface Balloon {
  lines: Line[];
  order: number;
  bbox: [number, number, number, number];
}

interface Edge {
  a: number;
  b: number;
  w: number;
}

/** Median of a non-empty list (mean of the two middle values for even counts). */
function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/** Union-find root lookup with path compression. */
function find(parent: Int32Array, x: number): number {
  let root = x;
  while (parent[root] !== root) root = parent[root];
  while (parent[x] !== root) {
    const next = parent[x];
    parent[x] = root;
    x = next;
  }
  return root;
}

export function clusterBalloons(lines: Line[], direction: 'rtl' | 'ltr'): Balloon[] {
  const n = lines.length;
  if (n === 0) return [];

  // --- Kruskal MST over line centers (cx, cy), Euclidean weights ---
  const edges: Edge[] = [];
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      edges.push({
        a: i,
        b: j,
        w: Math.hypot(lines[i].cx - lines[j].cx, lines[i].cy - lines[j].cy),
      });
    }
  }
  // Deterministic tie-break: lower (a, b) pair first among equal weights.
  edges.sort((p, q) => p.w - q.w || p.a - q.a || p.b - q.b);

  const parent = new Int32Array(n);
  for (let i = 0; i < n; i++) parent[i] = i;
  const mst: Edge[] = [];
  for (const e of edges) {
    const ra = find(parent, e.a);
    const rb = find(parent, e.b);
    if (ra !== rb) {
      parent[ra] = rb;
      mst.push(e);
      if (mst.length === n - 1) break;
    }
  }

  // Drop MST edges longer than T = 2.5 × median(line.h) (strictly-longer drop).
  const T = 2.5 * median(lines.map((l) => l.h));
  const kept = mst.filter((e) => e.w <= T);

  // Remaining connected components are balloons; singletons stay balloons.
  for (let i = 0; i < n; i++) parent[i] = i;
  for (const e of kept) {
    const ra = find(parent, e.a);
    const rb = find(parent, e.b);
    if (ra !== rb) parent[ra] = rb;
  }

  const membersByRoot = new Map<number, number[]>();
  for (let i = 0; i < n; i++) {
    const root = find(parent, i);
    const members = membersByRoot.get(root);
    if (members) members.push(i);
    else membersByRoot.set(root, [i]);
  }

  const balloons: Balloon[] = [];
  for (const members of membersByRoot.values()) {
    let x0 = Infinity;
    let y0 = Infinity;
    let x1 = -Infinity;
    let y1 = -Infinity;
    for (const i of members) {
      for (const [px, py] of lines[i].poly.pts) {
        if (px < x0) x0 = px;
        if (py < y0) y0 = py;
        if (px > x1) x1 = px;
        if (py > y1) y1 = py;
      }
    }
    balloons.push({
      lines: members.map((i) => lines[i]),
      order: 0,
      bbox: [x0, y0, x1, y1],
    });
  }

  // --- Reading order: page columns → balloons in a column → lines in a balloon ---
  // assumption taken — "balloon centers"/"balloon width" mean the balloon bbox
  // center and bbox width; balloons within one column read top-to-bottom (SPEC
  // §7.5 fixes only column direction and in-balloon line order; column-major
  // reading per A8 implies top-to-bottom inside a column).
  const centers = balloons.map((b) => ({
    cx: (b.bbox[0] + b.bbox[2]) / 2,
    cy: (b.bbox[1] + b.bbox[3]) / 2,
  }));
  const colGap = 0.5 * median(balloons.map((b) => b.bbox[2] - b.bbox[0]));

  // Sweep centers left-to-right; a center-to-center x-gap beyond colGap starts
  // a new column.
  const byX = balloons.map((_, i) => i).sort(
    (a, b) => centers[a].cx - centers[b].cx || centers[a].cy - centers[b].cy,
  );
  const columns: number[][] = [];
  let current: number[] = [];
  for (let k = 0; k < byX.length; k++) {
    if (k > 0 && centers[byX[k]].cx - centers[byX[k - 1]].cx > colGap) {
      columns.push(current);
      current = [];
    }
    current.push(byX[k]);
  }
  columns.push(current);

  // Columns were built left-to-right; rtl reads them right-to-left.
  if (direction === 'rtl') columns.reverse();

  const ordered: Balloon[] = [];
  let order = 0;
  for (const column of columns) {
    column.sort((a, b) => centers[a].cy - centers[b].cy);
    for (const bi of column) {
      const balloon = balloons[bi];
      // assumption taken — in-balloon sort is the literal two-key reading of
      // §7.5: rtl = (cx desc, cy asc); ltr = (cy asc) per spec with (cx asc)
      // added as tie-break for determinism (no in-balloon threshold is given,
      // so no nested sub-column grouping is introduced).
      balloon.lines.sort(
        direction === 'rtl'
          ? (a, b) => b.cx - a.cx || a.cy - b.cy
          : (a, b) => a.cy - b.cy || a.cx - b.cx,
      );
      balloon.order = order++;
      ordered.push(balloon);
    }
  }
  // assumption taken — the returned array is in reading order, so the array
  // index always equals the balloon's `order` field.
  return ordered;
}
