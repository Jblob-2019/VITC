// Telemetry shape streamed by Node backend (server.js synthetic simulator or real serial).
export type NodeRole = 0 | 1 | 2; // 0=Sensor, 1=Relay, 2=Gateway
export type RouteMode = 0 | 1;   // 0=RSSI, 1=ETX

export interface Neighbor {
  id: number;
  rssi: number;
  etx: number;
  bat: number;
  risk: number;
  hop: number;
}

export interface Telemetry {
  id: number;
  role: NodeRole;
  bat: number;
  mode: RouteMode;
  nb: number;
  route: number;
  nbrs: Neighbor[];
  // optional fields from live serial:
  rssi?: number;
  risk?: number;
}

export interface Position {
  id: number;
  name: string;
  x: number;
  y: number;
  role: NodeRole;
}

export interface LogLine {
  ts: number;
  level: 'info' | 'warn' | 'bad' | 'good' | 'recv' | 'send';
  text: string;
}