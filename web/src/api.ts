import { useEffect, useRef, useState, useCallback } from 'react';
import type { Telemetry, RouteMode, LogLine } from './types';

// Default positions if /positions.json is missing — Buoy/Vessel layout.
export const DEFAULT_POSITIONS = [
  { id: 0, name: 'Buoy-GW',  x: 500, y: 220, role: 2 as const },
  { id: 1, name: 'Vessel-1', x: 250, y: 110, role: 1 as const },
  { id: 2, name: 'Buoy-2',   x: 120, y: 380, role: 0 as const },
  { id: 3, name: 'Vessel-3', x: 760, y: 130, role: 1 as const },
  { id: 4, name: 'Buoy-4',   x: 880, y: 380, role: 0 as const },
];

export function useMeshSocket() {
  const [telemetry, setTelemetry] = useState<Map<number, Telemetry>>(new Map());
  const [mode, setMode] = useState<RouteMode>(0);
  const [status, setStatus] = useState<'connecting' | 'open' | 'closed'>('connecting');
  const [logs, setLogs] = useState<LogLine[]>([]);
  const wsRef = useRef<WebSocket | null>(null);

  const log = useCallback((level: LogLine['level'], text: string) => {
    setLogs((prev) => {
        const next = [...prev, { ts: Date.now(), level, text }];
        return next.slice(-200);
    });
  }, []);

  useEffect(() => {
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    const url = `${proto}://${location.host}/ws`;
    const ws = new WebSocket(url);
    wsRef.current = ws;

    ws.onopen = () => { setStatus('open'); log('good', 'WS open'); };
    ws.onclose = () => { setStatus('closed'); log('bad', 'WS closed'); };
    ws.onerror = () => log('warn', 'WS error');
    ws.onmessage = (ev) => {
      let msg: any;
      try { msg = JSON.parse(ev.data); } catch { return; }
      if (msg.cmd === 'mode') {
        setMode(msg.route_mode);
        log('info', `MODE:${msg.mode}`);
        return;
      }
      if ('id' in msg) {
        setTelemetry((prev) => {
          const next = new Map(prev);
          next.set(msg.id, msg);
          return next;
        });
        log('recv', `#${msg.id} bat=${msg.bat}% nb=${msg.nb} mode=${msg.mode === 0 ? 'RSSI' : 'ETX'}`);
      }
    };
    return () => ws.close();
  }, [log]);

  const setRouteMode = useCallback((m: 'RSSI' | 'ETX') => {
    wsRef.current?.send(JSON.stringify({ cmd: 'set_mode', mode: m }));
    log('send', `set_mode → ${m}`);
  }, [log]);

  return { telemetry, mode, status, logs, setRouteMode, log };
}