import { useEffect, useMemo, useState } from 'react';
import { useMeshSocket, DEFAULT_POSITIONS } from './api';
import type { Position } from './types';
import Topology from './Topology';
import SidePanel from './SidePanel';
import EventLog from './EventLog';
import styles from './app.module.css';

type Mode = 'SIM' | 'LIVE';

export default function App() {
  const [uiMode, setUiMode] = useState<Mode>('SIM');
  const [positions, setPositions] = useState<Position[]>(DEFAULT_POSITIONS);
  const mesh = useMeshSocket();

  // Try to load positions.json; fall back to defaults silently.
  useEffect(() => {
    fetch('/positions.json').then((r) => r.ok ? r.json() : null).then((j) => {
      if (Array.isArray(j) && j.length) setPositions(j as Position[]);
    }).catch(() => {});
  }, []);

  const nodeCount = useMemo(() => positions.length, [positions]);

  return (
    <div className={styles.shell}>
      <header className={styles.header}>
        <div className={styles.brand}>
          <span className={styles.brandMark}>⚓</span>
          <div>
            <div className={styles.brandTitle}>AEGIS Networking</div>
            <div className={styles.brandSub}>Predictive Self-Healing Mesh · PMA* v1</div>
          </div>
        </div>
        <div className={styles.seg}>
          {(['SIM', 'LIVE'] as Mode[]).map((m) => (
            <button key={m}
              className={`${styles.segBtn} ${uiMode === m ? styles.segBtnActive : ''}`}
              onClick={() => setUiMode(m)}>
              {m}
            </button>
          ))}
        </div>
        <div className={styles.headerRight}>
          <span className={`${styles.dot} ${styles[mesh.status]}`} />
          <span className="mono">{mesh.status.toUpperCase()}</span>
          <span className={styles.dim}>·</span>
          <span className="mono">{nodeCount} nodes</span>
          <span className={styles.dim}>·</span>
          <span className="mono">{mesh.mode === 0 ? 'RSSI' : 'ETX'}</span>
        </div>
      </header>

      <main className={styles.main}>
        <section className={styles.canvasWrap}>
          <Topology positions={positions} telemetry={mesh.telemetry}
                    mode={uiMode} routeMode={mesh.mode} />
        </section>
        <aside className={styles.sidebar}>
          <SidePanel positions={positions} telemetry={mesh.telemetry}
                     mode={mesh.mode} uiMode={uiMode}
                     setRouteMode={mesh.setRouteMode} log={mesh.log} />
          <EventLog logs={mesh.logs} />
        </aside>
      </main>
    </div>
  );
}