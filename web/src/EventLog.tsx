import { useEffect, useRef } from 'react';
import type { LogLine } from './types';
import styles from './app.module.css';

interface Props { logs: LogLine[]; }

export default function EventLog({ logs }: Props) {
  const ref = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    ref.current?.scrollTo({ top: ref.current.scrollHeight });
  }, [logs.length]);

  return (
    <div className={styles.card}>
      <div className={styles.cardHead}><span>Event log</span><span className="mono">{logs.length}</span></div>
      <div className={styles.logScroll} ref={ref}>
        {logs.slice().reverse().map((l, i) => (
          <div key={logs.length - i} className={`${styles.logLine} ${styles['lv_' + l.level] || ''}`}>
            <span className="mono">{new Date(l.ts).toLocaleTimeString()}</span>
            <span> {l.text}</span>
          </div>
        ))}
        {logs.length === 0 && <div className={styles.dim}>no events yet</div>}
      </div>
    </div>
  );
}