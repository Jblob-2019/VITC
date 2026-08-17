import type { Position, Telemetry, RouteMode, LogLine } from './types';
import styles from './app.module.css';

interface Props {
  positions: Position[];
  telemetry: Map<number, Telemetry>;
  mode: RouteMode;
  uiMode: 'SIM' | 'LIVE';
  setRouteMode: (m: 'RSSI' | 'ETX') => void;
  log: (level: LogLine['level'], text: string) => void;
}

const WEIGHTS = [
  { k: 'rssi',   w: 0.35, c: '#4dd0e1' },
  { k: 'etx',    w: 0.30, c: '#00bcd4' },
  { k: 'battery',w: 0.15, c: '#66bb6a' },
  { k: 'risk',   w: 0.15, c: '#ffb74d' },
  { k: 'hop',    w: 0.05, c: '#8b95a4' },
];

export default function SidePanel({ positions, telemetry, mode, uiMode, setRouteMode, log }: Props) {
  const total = positions.length;
  const online = Array.from(telemetry.keys()).length;
  const risk = Array.from(telemetry.values()).filter((t) => (t.rssi ?? -60) < -75 || t.bat < 20).length;

  return (
    <div className={styles.card}>
      <div className={styles.cardHead}>
        <span>Telemetry</span>
        <span className="mono">{online}/{total} · {risk} risk</span>
      </div>
      <div className={styles.statsRow}>
        <Stat label="Mode"   value={mode === 0 ? 'RSSI' : 'ETX'} />
        <Stat label="Queue"  value="3" />
        <Stat label="ETX̄"    value={avg(telemetry, (t) => {
          const e = t.nbrs?.map((n) => n.etx).filter(Boolean);
          return e?.length ? e.reduce((a, b) => a + b, 0) / e.length : 0;
        }).toFixed(2)} />
        <Stat label="Anom"   value="σ²" />
      </div>

      <div className={styles.cardHead}><span>PMA* weights</span></div>
      <div className={styles.weights}>
        {WEIGHTS.map((w) => (
          <div key={w.k} className={styles.weightRow}>
            <span className={styles.wKey}>{w.k}</span>
            <div className={styles.wBar}>
              <div style={{ width: `${w.w * 100}%`, background: w.c }} />
            </div>
            <span className="mono">{w.w.toFixed(2)}</span>
          </div>
        ))}
      </div>

      <div className={styles.cardHead}>
        <span>Route control</span>
        <span className="mono">MODE:{mode === 0 ? 'RSSI' : 'ETX'}</span>
      </div>
      <div className={styles.seg}>
        {(['RSSI', 'ETX'] as const).map((m) => (
          <button key={m}
            className={`${styles.segBtn} ${mode === (m === 'RSSI' ? 0 : 1) ? styles.segBtnActive : ''}`}
            onClick={() => setRouteMode(m)}>
            {m}
          </button>
        ))}
      </div>

      <button className={styles.crit} onClick={() => log('bad', 'CRITICAL ⚡ dispatched · MODE:ETX')}>
        ⚡ Fire CRITICAL · MODE:ETX
      </button>
      <div className={styles.dim}>{uiMode === 'SIM' ? 'simulator active' : 'live telemetry'}</div>
    </div>
  );
}

function avg<V, T>(m: Map<V, T>, sel: (t: T) => number): number {
  const arr = Array.from(m.values()).map(sel).filter((n) => !isNaN(n) && isFinite(n));
  return arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : 0;
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className={styles.stat}>
      <div className={styles.statLabel}>{label}</div>
      <div className={styles.statValue}>{value}</div>
    </div>
  );
}

// CSS module already imported at top