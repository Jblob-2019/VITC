// Path-finding algorithms ported from the reference dashboard.
// Cost function is the real PMA* blend from overview.md §11:
//   w = α·rssiCost + β·etxCost + γ·batteryCost + δ·hopCost + ε·riskCost
// In RSSI-only mode β=ε=0 (no ETX, no risk forecast).

export const RANGE = 190;
export const ALPHA_W = 0.35;
export const BETA_W  = 0.30;
export const GAMMA_W = 0.15;
export const DELTA_W = 0.05;
export const EPSILON_W = 0.15;

import type { SimNode, SimEdge } from './types';
export type { SimNode, SimEdge };

function dist(a: SimNode, b: SimNode) { return Math.hypot(a.x - b.x, a.y - b.y); }

function neighborsOf(edges: SimEdge[], u: number): number[] {
  const out: number[] = [];
  for (const e of edges) {
    if (e.a === u) out.push(e.b);
    else if (e.b === u) out.push(e.a);
  }
  return out;
}
function findEdge(edges: SimEdge[], u: number, v: number): SimEdge | undefined {
  return edges.find((e) => (e.a === u && e.b === v) || (e.a === v && e.b === u));
}
function reconstruct(prev: Record<number, number>, source: number, goal: number): number[] | null {
  if (goal !== source && prev[goal] === undefined) return null;
  const path = [goal];
  let cur = goal;
  while (cur !== source) { cur = prev[cur]; if (cur === undefined) return null; path.unshift(cur); }
  return path;
}

/** Plain Dijkstra (unit weights from costFn). Returns path + nodes-explored. */
export function dijkstraPath(
  nodes: SimNode[], edges: SimEdge[], costFn: (e: SimEdge, u: number, v: number, nodes: SimNode[]) => number,
  source: number, goal: number,
): { path: number[] | null; explored: number } {
  const g: Record<number, number> = {};
  const prev: Record<number, number> = {};
  const visited = new Set<number>();
  nodes.forEach((n) => g[n.id] = Infinity);
  g[source] = 0;
  let explored = 0;
  while (true) {
    let u = -1, best = Infinity;
    for (const n of nodes) if (!visited.has(n.id) && g[n.id] < best) { best = g[n.id]; u = n.id; }
    if (u === -1) break;
    visited.add(u); explored++;
    if (u === goal) break;
    for (const v of neighborsOf(edges, u)) {
      const e = findEdge(edges, u, v);
      if (!e) continue;
      const c = costFn(e, u, v, nodes);
      if (g[u] + c < g[v]) { g[v] = g[u] + c; prev[v] = u; }
    }
  }
  return { path: reconstruct(prev, source, goal), explored };
}

/** Modified A* — admissible heuristic: cheapest possible per-hop cost × min-hops.
 *  Heuristic is never > true path cost, so still optimal. */
export function aStarPath(
  nodes: SimNode[], edges: SimEdge[], costFn: (e: SimEdge, u: number, v: number, nodes: SimNode[]) => number,
  source: number, goal: number,
): { path: number[] | null; explored: number } {
  // best-case single-hop cost (quality=1, etx=1, hop=1)
  const cMin = ALPHA_W * (1 / 1.0) + BETA_W * (1 / 1.0) + GAMMA_W * 1;
  const goalNode = nodes.find((n) => n.id === goal);
  function h(id: number) {
    const n = nodes.find((x) => x.id === id);
    if (!n || !goalNode) return 0;
    const minHops = Math.max(1, Math.ceil(dist(n, goalNode) / RANGE));
    return id === goal ? 0 : cMin * minHops;
  }
  const g: Record<number, number> = {};
  const f: Record<number, number> = {};
  const prev: Record<number, number> = {};
  const open = new Set<number>([source]);
  const closed = new Set<number>();
  nodes.forEach((n) => g[n.id] = Infinity);
  g[source] = 0; f[source] = h(source);
  let explored = 0;
  while (open.size) {
    let u = -1, best = Infinity;
    for (const id of open) if (f[id] < best) { best = f[id]; u = id; }
    if (u === goal) break;
    open.delete(u); closed.add(u); explored++;
    for (const v of neighborsOf(edges, u)) {
      if (closed.has(v)) continue;
      const e = findEdge(edges, u, v);
      if (!e) continue;
      const tentative = g[u] + costFn(e, u, v, nodes);
      if (tentative < (g[v] ?? Infinity)) {
        prev[v] = u; g[v] = tentative; f[v] = tentative + h(v);
        open.add(v);
      }
    }
  }
  return { path: reconstruct(prev, source, goal), explored };
}

export function computePath(algo: 'dijkstra' | 'astar',
  nodes: SimNode[], edges: SimEdge[], costFn: (e: SimEdge, u: number, v: number, nodes: SimNode[]) => number,
  source: number, goal: number,
) {
  return algo === 'astar'
    ? aStarPath(nodes, edges, costFn, source, goal)
    : dijkstraPath(nodes, edges, costFn, source, goal);
}

export function pathHasEdge(path: number[] | null, a: number, b: number): boolean {
  if (!path) return false;
  for (let i = 0; i < path.length - 1; i++) {
    if ((path[i] === a && path[i + 1] === b) || (path[i] === b && path[i + 1] === a)) return true;
  }
  return false;
}

export function qualityFromRSSI(rssi: number) {
  return Math.min(1, Math.max(0.05, (rssi + 95) / 65));
}

// Per-edge PMA* cost component (always 0..1, lower = better).
export function pmaEdgeCost(e: SimEdge, mode: 'rssi' | 'etx', v: number, nodes: SimNode[]) {
  const rssi = e.rssiEma ?? e._rssi ?? -70;
  const rssiCost = 1 - qualityFromRSSI(rssi);          // 0..1, lower rssi ⇒ higher cost
  const etx  = 1 / Math.max(0.05, e.pEma ?? e._p ?? 0.9);
  const etxCost = (etx - 1) / 4;                      // normalize 1..5 → 0..1
  const riskCost = e.risk ?? 0;
  
  const destNode = nodes.find(n => n.id === v);
  const batteryCost = destNode?.isGateway ? 0 : (100 - (destNode?.battery ?? 100)) / 100;

  if (mode === 'rssi') {
    return ALPHA_W * rssiCost + GAMMA_W * batteryCost + EPSILON_W * riskCost;
  }
  return ALPHA_W * rssiCost + BETA_W * etxCost + GAMMA_W * batteryCost + EPSILON_W * riskCost;
}
