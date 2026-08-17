import { useEffect, useMemo, useRef, useState } from 'react';
import type { SimNode, SimEdge } from './types';
import { computePath, pathHasEdge, pmaEdgeCost, qualityFromRSSI } from './algorithms';
import { reportTick, send } from './api';
import styles from './app.module.css';

interface Props {
  nodes: SimNode[];
  edges: SimEdge[];
  algo: 'dijkstra' | 'astar';
  src: number;
  target: number;
  stats: { sent: number; delivered: number; ratio: string };
  onLog: (msg: string, cls?: 'ok' | 'no' | 'rs' | '') => void;
}

const COLORS = {
  rssi: '#38BDF8', etx: '#34D399', bad: '#F87171',
  warn: '#F5A623', gw: '#F5A623', origin: '#A78BFA',
};

function dist(a: SimNode, b: SimNode) { return Math.hypot(a.x - b.x, a.y - b.y); }
function pointToSegDist(px: number, py: number, x1: number, y1: number, x2: number, y2: number) {
  const dx = x2 - x1, dy = y2 - y1, len2 = dx * dx + dy * dy;
  let t = len2 ? ((px - x1) * dx + (py - y1) * dy) / len2 : 0;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(px - (x1 + t * dx), py - (y1 + t * dy));
}

export default function SimView({ nodes, edges, algo, src, target, stats, onLog }: Props) {
  const etxRef  = useRef<HTMLCanvasElement | null>(null);
  const [pickerOpen, setPickerOpen] = useState(false);
  const animRef = useRef(0);

  const etxCostFn = useMemo(
    () => (e: SimEdge, u: number, v: number, nodes: SimNode[]) => pmaEdgeCost(e, 'etx', v, nodes),
    [],
  );

  const etxRoute = useMemo(() => {
    if (nodes.length < 2) return { path: null, explored: 0 };
    return computePath(algo, nodes, edges, etxCostFn, src, target);
  }, [nodes, edges, algo, etxCostFn, src, target]);

  // Per-tick delivery simulation + back-report
  const lastReportRef = useRef({ tick: -1, rOk: false, eOk: false });
  useEffect(() => {
    const tr = (path: number[] | null) => {
      if (!path) return false;
      for (let i = 0; i < path.length - 1; i++) {
        const e = edges.find(
          (ee) => (ee.a === path[i] && ee.b === path[i + 1]) || (ee.a === path[i + 1] && ee.b === path[i]),
        );
        if (!e) return false;
        const p = e.interfered
          ? Math.max(0.03, (e.pEma ?? 0.9) * 0.35)
          : (e.pEma ?? 0.9);
        if (Math.random() >= p) return false;
      }
      return true;
    };
    const eOk = tr(etxRoute.path);
    if (lastReportRef.current.tick !== (etxRoute as any).tick) {
      lastReportRef.current = { tick: (etxRoute as any).tick ?? Date.now(), rOk: false, eOk };
      reportTick('etx',  etxRoute.explored,  eOk);
      if (nodes[src]) {
        const srcName = nodes[src].isGateway ? 'GW' : `n${src}`;
        const tgName  = nodes[target]?.isGateway ? 'GW' : `n${target}`;
        onLog(
          `${srcName}→${tgName} &nbsp; <span class="ok">ETX ${eOk ? '✓' : '✗'}</span> &nbsp; (${algo}, explored ${etxRoute.explored})`,
          '',
        );
      }
    }
  }, [etxRoute, edges, algo, onLog, src, target, nodes]);

  function render(canvas: HTMLCanvasElement, accent: string, path: number[] | null, t: number) {
    if (!canvas) return;
    const ctx = canvas.getContext('2d')!;
    const dpr = window.devicePixelRatio || 1;
    const cw = canvas.clientWidth, ch = canvas.clientHeight;
    if (canvas.width !== cw * dpr || canvas.height !== ch * dpr) {
      canvas.width = cw * dpr; canvas.height = ch * dpr;
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, cw, ch);

    // edges
    for (const e of edges) {
      const n = nodes.find((x) => x.id === e.a);
      const m = nodes.find((x) => x.id === e.b);
      if (!n || !m) continue;
      const onPath = pathHasEdge(path, e.a, e.b);
      
      const rssi = e.rssi ?? -120;
      // Hide very weak edges that are not on the active path and not actively interfered
      if (!onPath && !e.interfered && rssi <= -85) continue;

      ctx.beginPath(); ctx.moveTo(n.x, n.y); ctx.lineTo(m.x, m.y);
      if (e.interfered) {
        ctx.strokeStyle = onPath ? COLORS.bad : 'rgba(248,113,113,0.2)';
        ctx.setLineDash([5, 4]);
      } else {
        ctx.strokeStyle = onPath ? accent : 'rgba(255,255,255,0.05)';
        ctx.setLineDash([]);
      }
      ctx.lineWidth = onPath ? 2.6 : 1.0;
      ctx.stroke(); ctx.setLineDash([]);

      const mx = (n.x + m.x) / 2, my = (n.y + m.y) / 2;
      // Only show text labels for the active path to reduce clutter
      if (e.label && onPath) {
        ctx.font = '9.5px "IBM Plex Mono", monospace';
        ctx.fillStyle = (e.risk ?? 0) ? COLORS.warn : 'rgba(255,255,255,0.75)';
        ctx.fillText(e.label, mx + 4, my - 4);
      }
      if (e.interfered) {
        ctx.fillStyle = COLORS.bad;
        ctx.font = '11px sans-serif';
        ctx.fillText('⚡', mx - 14, my + 4);
      }
    }

    // nodes
    for (const nd of nodes) {
      const isGW = nd.isGateway;
      const isSrc = nd.id === src;
      const isTg  = nd.id === target;
      ctx.beginPath();
      ctx.arc(nd.x, nd.y, isGW ? 12 : 8, 0, Math.PI * 2);
      ctx.fillStyle = isGW ? COLORS.gw : (path && path.includes(nd.id) ? accent : '#2A3040');
      ctx.fill();
      ctx.lineWidth = 1.5;
      ctx.strokeStyle = isGW ? COLORS.gw : 'rgba(255,255,255,0.25)';
      ctx.stroke();
      ctx.font = '10px "IBM Plex Mono", monospace';
      ctx.fillStyle = '#8B93A1';
      ctx.fillText(isGW ? 'GW' : `n${nd.id}`, nd.x - 10, nd.y - 14);
      if (nd.battery !== undefined && !isGW) {
        ctx.fillStyle = (nd.battery < 20) ? COLORS.bad : '#5b6573';
        ctx.fillText(`${Math.round(nd.battery)}%`, nd.x - 8, nd.y + 18);
      }
      if (nd.anomaly) {
        ctx.beginPath(); ctx.arc(nd.x + 10, nd.y - 10, 3.5, 0, Math.PI * 2);
        ctx.fillStyle = COLORS.bad; ctx.fill();
      }

      // origin pulsing halo
      if (isSrc) {
        const pulse = 0.5 + Math.sin(t / 350) * 0.5;
        const r = 18 + pulse * 10;
        ctx.beginPath(); ctx.arc(nd.x, nd.y, r, 0, Math.PI * 2);
        ctx.strokeStyle = COLORS.origin; ctx.lineWidth = 2;
        ctx.globalAlpha = 0.4 + pulse * 0.4;
        ctx.stroke();
        ctx.globalAlpha = 1;
        ctx.fillStyle = COLORS.origin;
        ctx.font = '600 9.5px "Inter", sans-serif';
        ctx.fillText('ORIGIN', nd.x - 14, nd.y - 20);
      }
      // target pillar
      if (isTg) {
        ctx.beginPath();
        ctx.arc(nd.x, nd.y, 18, 0, Math.PI * 2);
        ctx.strokeStyle = '#06231A'; ctx.lineWidth = 2;
        ctx.stroke();
        ctx.beginPath();
        ctx.arc(nd.x, nd.y, 16, 0, Math.PI * 2);
        ctx.strokeStyle = COLORS.gw; ctx.lineWidth = 1.5;
        ctx.stroke();
        ctx.fillStyle = COLORS.gw;
        ctx.font = '600 9.5px "Inter", sans-serif';
        ctx.fillText('TARGET', nd.x - 14, nd.y - 20);
      }
    }
  }

  // smooth repaint clock
  useEffect(() => {
    function loop(t: number) {
      render(etxRef.current!,  COLORS.etx,  etxRoute.path,  t);
      animRef.current = requestAnimationFrame(loop);
    }
    animRef.current = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(animRef.current);
  }, [etxRoute.path, nodes, edges]);

  // Pointer interaction
  useEffect(() => {
    const canvas = etxRef.current;
    if (!canvas) return;
    let dragging: SimNode | null = null;
    const md = (e: MouseEvent) => {
      const r = canvas.getBoundingClientRect();
      const x = e.clientX - r.left, y = e.clientY - r.top;
      for (const nd of nodes) if (Math.hypot(nd.x - x, nd.y - y) < 14) { dragging = nd; return; }
      let closest: SimEdge | null = null, cd = 10;
      for (const ed of edges) {
        const n = nodes.find((x2) => x2.id === ed.a);
        const m = nodes.find((x2) => x2.id === ed.b);
        if (!n || !m) continue;
        const d = pointToSegDist(x, y, n.x, n.y, m.x, m.y);
        if (d < cd) { cd = d; closest = ed; }
      }
      if (closest) {
        const key = closest.a < closest.b ? `${closest.a}-${closest.b}` : `${closest.b}-${closest.a}`;
        send({ cmd: 'toggle_edge', key, on: !closest.interfered });
        onLog(`Link n${closest.a}↔n${closest.b} interference ${closest.interfered ? '<span class="no">ON</span>' : '<span class="ok">cleared</span>'}`, '');
      }
    };
    const mm = (e: MouseEvent) => {
      if (!dragging) return;
      const r = canvas.getBoundingClientRect();
      dragging.x = e.clientX - r.left;
      dragging.y = e.clientY - r.top;
    };
    const mu = () => { dragging = null; };
    canvas.addEventListener('mousedown', md);
    canvas.addEventListener('mousemove', mm);
    window.addEventListener('mouseup', mu);
    return () => {
      canvas.removeEventListener('mousedown', md);
      canvas.removeEventListener('mousemove', mm);
      window.removeEventListener('mouseup', mu);
    };
  }, [nodes, edges, onLog]);

  return (
    <div className={`${styles.grid} ${styles.gridSingle}`}>
      <div className={styles.simCard}>
        <div className={styles.simHead}>
          <span className={`${styles.tag} ${styles.tagEtx}`}>RSSI + ETX</span>
          <span className={styles.desc}>cost = α·rssi + β·etx + ε·risk + γ·battery</span>
        </div>
        <canvas ref={etxRef} className={styles.canvas} />
        <div className={styles.stats}>
          <Stat label="Sent"           value={String(stats.sent)} />
          <Stat label="Delivered"      value={String(stats.delivered)} accent="good" />
          <Stat label="Delivery ratio" value={stats.ratio !== '—' ? `${stats.ratio}%` : '—'} accent="good" />
          <Stat label="Nodes explored" value={String(etxRoute.explored)} />
        </div>
      </div>
    </div>
  );
}

function Stat({ label, value, accent }: { label: string; value: string; accent?: 'good' | 'bad' }) {
  return (
    <div className={styles.stat}>
      <div className={styles.k}>{label}</div>
      <div className={`${styles.v} ${accent ? styles[accent] : ''}`}>{value}</div>
    </div>
  );
}