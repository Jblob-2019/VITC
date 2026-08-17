// Wire shape from server.js.
export interface SimNode {
  id: number; x: number; y: number;
  isGateway: boolean;
  role: number;        // 0=sensor, 1=relay, 2=GW
  battery: number;
  anomaly: boolean;
  route_mode: number;  // 0=RSSI, 1=ETX
  timestamp: number;
}
export interface SimEdge {
  a: number; b: number;
  interfered?: boolean;
  label?: string;
  rssi?: number; rssiEma?: number; forecast?: number;
  pEma?: number; risk?: 0 | 1;
  history?: number[];
  _p?: number; _rssi?: number;
}
export interface TickPayload {
  cmd: 'tick';
  tick: number;
  nodes: SimNode[];
  edges: SimEdge[];
  src: number;
  target: number;
  tickMs: number;
}

export interface MeshStats {
  sent: { rssi: number; etx: number };
  delivered: { rssi: number; etx: number };
}
