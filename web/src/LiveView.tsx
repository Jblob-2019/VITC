import { useEffect, useRef, useState } from 'react';
import { computePath, pathHasEdge, qualityFromRSSI } from './algorithms';
import type { SimNode, SimEdge } from './types';
import { connectLive, sendLive, type LiveStatus, type LiveMsg } from './live';
import styles from './app.module.css';

const COLORS = { etx: '#34D399', rssi: '#38BDF8', bad: '#F87171', gw: '#F5A623' };

function circularFallback(id: number, total: number): [number, number] {
  const angle = (id / Math.max(1, total)) * Math.PI * 2;
  return [340 + Math.cos(angle) * 230, 180 + Math.sin(angle) * 140];
}

export default function LiveView({ algo, onLog }: {
  algo: 'astar';
  onLog: (msg: string, cls?: 'ok' | 'no' | 'rs' | '') => void;
}) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [nodes, setNodes] = useState<SimNode[]>([]);
  const [edges, setEdges] = useState<SimEdge[]>([]);
  const [meta, setMeta]   = useState<Record<number, { battery: number; anomaly: boolean; route_mode: number }>>({});
  const [lastUpdate, setLastUpdate] = useState<string>('—');
  const [status, setStatus] = useState<LiveStatus>('off');
  const [url, setUrl] = useState(`ws://${location.hostname}:8765`);
  const [reportedMode, setReportedMode] = useState<number | null>(null);
  const [explored, setExplored] = useState<number>(0);
  const livePosRef = useRef<Record<number, [number, number]>>({});
  const [tick, setTick] = useState(0);

  // Connect on mount
  useEffect(() => {
    const off = connectLive({
      url,
      onStatus: setStatus,
      onMessage: (m: LiveMsg) => {
        if (m.cmd === 'mode') {
          // ack of our own set_mode
          onLog(`mesh mode now: ${m.mode}`, 'rs');
          return;
        }
        if (!Array.isArray((m as any).nodes)) return;
        const incoming = m as any as { nodes: any[] };
        const ids = incoming.nodes.map((n) => n.id);
        const livePos = livePosRef.current;
        const newNodes: SimNode[] = incoming.nodes.map((n) => {
          const pos = livePos[n.id] || circularFallback(n.id, ids.length);
          return {
            id: n.id, x: pos[0], y: pos[1],
            isGateway: n.role === 2,
            role: n.role, battery: n.battery, anomaly: !!n.anomaly,
            route_mode: n.route_mode, timestamp: Date.now(),
          };
        });
        const seen = new Set<string>();
        const newEdges: SimEdge[] = [];
        const newMeta: typeof meta = {};
        for (const n of incoming.nodes) {
          newMeta[n.id] = { battery: n.battery, anomaly: !!n.anomaly, route_mode: n.route_mode };
          if (n.route_mode !== undefined) setReportedMode(n.route_mode);
          for (const nb of n.neighbors || []) {
            const k = nb.id < n.id ? `${nb.id}-${n.id}` : `${n.id}-${nb.id}`;
            if (seen.has(k)) continue;
            seen.add(k);
            const rssi = nb.rssi ?? -70;
            const etx  = (nb.etx ?? 100) / 100;
            newEdges.push({
              a: Math.min(n.id, nb.id), b: Math.max(n.id, nb.id),
              interfered: false,
              label: `${rssi}dBm / etx ${etx.toFixed(2)}`,
              _p: 1 / Math.max(etx, 0.05),
              _rssi: rssi,
            });
          }
        }
        setNodes(newNodes);
        setEdges(newEdges);
        setMeta(newMeta);
        setLastUpdate(new Date().toLocaleTimeString());
        setTick((t) => t + 1);
      },
    });
    return () => off();
  }, [url]);

  // Repaint
  useEffect(() => {
    if (!canvasRef.current) return;
    const canvas = canvasRef.current;
    const ctx = canvas.getContext('2d')!;
    const dpr = window.devicePixelRatio || 1;
    canvas.width = canvas.clientWidth * dpr;
    canvas.height = canvas.clientHeight * dpr;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const W = canvas.clientWidth, H = canvas.clientHeight;
    ctx.clearRect(0, 0, W, H);

    let path: number[] | null = null;
    let exploredCount = 0;
    if (nodes.length >= 2) {
      const gw = nodes.find((n) => n.isGateway) || nodes[0];
      const src = nodes.find((n) => n.id !== gw.id);
      if (src) {
        const costFn = reportedMode === 1
          ? (e: SimEdge, u: number, v: number, nodes: SimNode[]) => 1 / Math.max(0.05, 1 / (e._p ?? 0.8))
          : (e: SimEdge, u: number, v: number, nodes: SimNode[]) => 1 / qualityFromRSSI(e._rssi ?? -70);
        const r = computePath(algo, nodes, edges, costFn, src.id, gw.id);
        path = r.path;
        exploredCount = r.explored;
        setExplored(r.explored);
      }
    }
    const accent = reportedMode === 1 ? COLORS.etx : COLORS.rssi;

    for (const e of edges) {
      const a = nodes.find((x) => x.id === e.a);
      const b = nodes.find((x) => x.id === e.b);
      if (!a || !b) continue;
      const onPath = pathHasEdge(path, e.a, e.b);
      
      const rssi = e._rssi ?? -120;
      if (!onPath && !e.interfered && rssi <= -85) continue;

      ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y);
      ctx.strokeStyle = onPath ? accent : 'rgba(255,255,255,0.05)';
      ctx.lineWidth = onPath ? 2.6 : 1.0;
      ctx.stroke();
      const mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2;
      if (e.label && onPath) {
        ctx.font = '9.5px "IBM Plex Mono", monospace';
        ctx.fillStyle = 'rgba(255,255,255,0.75)';
        ctx.fillText(e.label, mx + 4, my - 4);
      }
    }
    for (const nd of nodes) {
      const isGW = nd.isGateway;
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
      if (nd.anomaly) {
        ctx.beginPath(); ctx.arc(nd.x + 10, nd.y - 10, 3.5, 0, Math.PI * 2);
        ctx.fillStyle = COLORS.bad; ctx.fill();
      }
    }
  }, [nodes, edges, algo, reportedMode, tick]);

  const sendMode = (mode: 'RSSI' | 'ETX') => {
    if (status !== 'on') {
      onLog('Not connected — cannot send mode command.', 'no');
      return;
    }
    sendLive({ cmd: 'set_mode', mode });
    onLog(`Sent set_mode → ${mode}`, '');
  };

  // Editable layout textarea
  const [posText, setPosText] = useState('');
  const applyPos = () => {
    try {
      const parsed = JSON.parse(posText);
      livePosRef.current = {};
      for (const k in parsed) livePosRef.current[Number(k)] = parsed[k];
      onLog(`Layout applied for ${Object.keys(parsed).length} node(s).`, 'ok');
      setTick((t) => t + 1);
    } catch (e: any) {
      onLog(`Layout JSON parse error: ${e.message}`, 'no');
    }
  };

  // Drag-to-move on the live canvas
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    let dragging: SimNode | null = null;
    const md = (e: MouseEvent) => {
      const r = canvas.getBoundingClientRect();
      const x = e.clientX - r.left, y = e.clientY - r.top;
      for (const nd of nodes) if (Math.hypot(nd.x - x, nd.y - y) < 12) { dragging = nd; return; }
    };
    const mm = (e: MouseEvent) => {
      if (!dragging) return;
      const r = canvas.getBoundingClientRect();
      dragging.x = e.clientX - r.left;
      dragging.y = e.clientY - r.top;
      livePosRef.current[dragging.id] = [dragging.x, dragging.y];
      setTick((t) => t + 1);
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
  }, [nodes]);

  return (
    <>
      <div className={`${styles.controls} ${styles.liveControls}`}>
        <span className={`${styles.statusDot} ${styles[status]}`} />
        <span className={`mono ${styles.wsStatus}`}>{status === 'on' ? 'connected' : status === 'pending' ? 'connecting…' : 'disconnected'}</span>
        <input className={styles.urlInput} value={url} onChange={(e) => setUrl(e.target.value)} />
        <button className={styles.primary} onClick={() => connectLive({ url, onStatus: setStatus, onMessage: () => {} })}>Connect</button>
        <label>Algorithm
          <select className={styles.select} value={algo} disabled>
            <option value="astar">A* (cost-consistent)</option>
          </select>
        </label>
        <button onClick={() => sendMode('RSSI')}>Set mesh: RSSI-only</button>
        <button onClick={() => sendMode('ETX')}>Set mesh: RSSI+ETX</button>
        <span className={styles.hint} style={{ marginLeft: 'auto' }}>
          mesh mode: {reportedMode === 1 ? 'RSSI+ETX' : reportedMode === 0 ? 'RSSI-only' : '—'}
        </span>
      </div>

      <div className={`${styles.grid} ${styles.gridSingle}`}>
        <div className={styles.simCard}>
          <div className={styles.simHead}>
            <span className={`${styles.tag} ${styles.tagEtx}`}>LIVE MESH</span>
            <span className={styles.desc}>real telemetry from gateway, via bridge WebSocket</span>
          </div>
          <canvas ref={canvasRef} className={styles.canvas} />
          <div className={styles.stats}>
            <div className={styles.stat}><div className={styles.k}>Nodes seen</div><div className={styles.v}>{nodes.length}</div></div>
            <div className={styles.stat}><div className={styles.k}>Last update</div><div className={styles.v}>{lastUpdate}</div></div>
            <div className={styles.stat}><div className={styles.k}>Displayed route to</div><div className={styles.v}>GW</div></div>
            <div className={styles.stat}><div className={styles.k}>Nodes explored</div><div className={styles.v}>{explored}</div></div>
          </div>
        </div>
      </div>

      <div className={styles.controls} style={{ marginTop: 14 }}>
        <span className={styles.hint} style={{ margin: 0 }}>
          optional fixed layout — paste {`{ "0":[x,y], "1":[x,y] }`} (unlisted nodes auto-placed on a circle):
        </span>
      </div>
      <textarea
        className={styles.textarea}
        value={posText}
        onChange={(e) => setPosText(e.target.value)}
        placeholder='{"0":[60,180]}'
      />
      <button onClick={applyPos} style={{ marginTop: 8, alignSelf: 'flex-start' }}>Apply layout</button>
    </>
  );
}
