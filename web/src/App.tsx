import { useEffect, useRef, useState } from 'react';
import { useMeshStream, send, resetClientStats } from './api';
import SimView from './SimView';
import LiveView from './LiveView';
import styles from './app.module.css';

type Mode = 'sim' | 'live';

export default function App() {
  const { tick, stats } = useMeshStream();
  const [mode, setMode] = useState<Mode>('sim');
  const [algo] = useState<'astar'>('astar');
  const [nodeCount, setNodeCount] = useState(16);
  const [noise, setNoise] = useState(2);
  const [pickedSrc, setPickedSrc] = useState<number | null>(null);
  const [logs, setLogs] = useState<{ text: string }[]>([]);
  const [showPredictor, setShowPredictor] = useState(true);
  const [showRisk, setShowRisk] = useState(true);
  const [showBattery, setShowBattery] = useState(true);
  const logRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    logRef.current?.scrollTo({ top: logRef.current.scrollHeight });
  }, [logs.length]);

  const log = (text: string, cls?: 'ok' | 'no' | 'rs' | '') => {
    setLogs((p) => [...p, { text: `<span class="${cls || ''}">▸</span> ${text}` }].slice(-100));
  };

  // The user can either (a) let the server rotate src automatically, or
  // (b) pin a specific source via the dropdown or by clicking a node.
  useEffect(() => {
    if (pickedSrc !== null) send({ cmd: 'pick_src', src: pickedSrc });
  }, [pickedSrc]);

  const regen = () => {
    send({ cmd: 'new_topology' });
    resetClientStats(); setPickedSrc(null);
    log('New topology', 'rs');
  };
  const resetStats = () => { resetClientStats(); send({ cmd: 'reset_stats' }); log('Stats reset', 'ok'); };
  const onNodes = (n: number) => { setNodeCount(n); send({ cmd: 'set_nodes', n }); log(`Nodes: ${n}`, 'rs'); };
  const onNoise = (n: number) => { setNoise(n); send({ cmd: 'set_noise', n }); };

  const src  = tick?.src ?? 0;
  const tg   = tick?.target ?? 0;
  const tickMs = tick?.tickMs ?? 1200;
  const rRatio = stats.sent.rssi ? (100 * stats.delivered.rssi / stats.sent.rssi).toFixed(1) : '—';
  const eRatio = stats.sent.etx  ? (100 * stats.delivered.etx  / stats.sent.etx ).toFixed(1) : '—';

  return (
    <div className={styles.shell}>
      <header className={styles.header}>
        <div className={styles.eyebrow}>MESH DASHBOARD</div>
        <h1 className={styles.h1}>
          {mode === 'sim'
            ? 'Simulation — RSSI vs RSSI+ETX routing'
            : 'Live — real ESP32 mesh telemetry'}
        </h1>
        <p className={styles.lede}>
          {mode === 'sim'
            ? `Origin pulses violet, target (GW) is amber. Tick ${tickMs}ms. Click any edge to inject interference. Click any non-GW node to pin it as the source.`
            : 'Fed by bridge over WebSocket from the gateway node’s serial telemetry.'}
        </p>
      </header>

      <div className={styles.modebar}>
        <div className={`${styles.modebtn} ${mode === 'sim' ? styles.active : ''}`} onClick={() => setMode('sim')}>◧ Simulation</div>
        <div className={`${styles.modebtn} ${mode === 'live' ? styles.active : ''}`} onClick={() => setMode('live')}>◉ Live (ESP32)</div>
      </div>

      {mode === 'sim' && (
        <>
          <div className={styles.controls}>
            <button className={styles.primary} onClick={regen}>↻ New topology</button>
            <button onClick={resetStats}>Reset stats</button>
            <button onClick={() => { send({ cmd: 'recharge' }); log('Nodes recharged', 'ok'); }}>Recharge</button>
            <label>Nodes
              <input type="range" min={6} max={40} value={nodeCount}
                     onChange={(e) => onNodes(+e.target.value)} />
              <span className="mono">{nodeCount}</span>
            </label>
            <label>Noise
              <input type="range" min={0} max={10} value={noise}
                     onChange={(e) => onNoise(+e.target.value)} />
              <span className="mono">{noise}</span>
            </label>
            <label>Source
              <select value={pickedSrc ?? ''} onChange={(e) => setPickedSrc(e.target.value === '' ? null : +e.target.value)}>
                <option value="">rotate (auto)</option>
                {(tick?.nodes || []).filter((n) => !n.isGateway).map((n) => (
                  <option key={n.id} value={n.id}>n{n.id} ({(n.battery|0)}%)</option>
                ))}
              </select>
            </label>
            <span className={styles.hint}>click an edge to toggle interference · click a non-GW node to pin source</span>
          </div>

          <div className={styles.featureBar}>
            <label><input type="checkbox" checked={showPredictor} onChange={(e) => setShowPredictor(e.target.checked)} /> EWMA predictor + risk bits</label>
            <label><input type="checkbox" checked={showRisk} onChange={(e) => setShowRisk(e.target.checked)} /> Highlight ⚠ forecast</label>
            <label><input type="checkbox" checked={showBattery} onChange={(e) => setShowBattery(e.target.checked)} /> Show battery drain</label>
            <span className={styles.miniStat}>
              <span className={styles.miniK}>delivery RSSI</span>
              <span className={styles.miniV}>{rRatio}%</span>
              <span className={styles.miniK}>delivery ETX</span>
              <span className={styles.miniV} style={{ color: '#34D399' }}>{eRatio}%</span>
              <span className={styles.miniK}>tick</span>
              <span className={styles.miniV}>{tickMs}ms</span>
            </span>
          </div>

          {tick ? (
            <SimView nodes={tick.nodes} edges={tick.edges} algo={algo} src={src} target={tg} stats={{ sent: stats.sent.etx, delivered: stats.delivered.etx, ratio: eRatio }} onLog={log} />
          ) : (
            <div className={styles.simCard} style={{ padding: 40, textAlign: 'center', color: '#8B93A1' }}>connecting…</div>
          )}
        </>
      )}

      {mode === 'live' && <LiveView algo={algo} onLog={log} />}

      <div className={styles.logWrap}>
        <div className={styles.k}>Event log</div>
        <div ref={logRef} className={styles.logScroll} dangerouslySetInnerHTML={{ __html: logs.map(l => l.text).join('<br/>') }} />
      </div>
    </div>
  );
}