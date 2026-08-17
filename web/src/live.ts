// Live WS bridge helper. The LIVE pane is wired to whatever URL the user
// enters in the toolbar (defaults to ws://<host>:8765 — port the original
// aiohttp bridge used). The runtime will reconnect automatically.
export type LiveStatus = 'off' | 'pending' | 'on';
export interface LiveMsg { cmd?: string; [k: string]: any; }

interface Options {
  url: string;
  onStatus: (s: LiveStatus) => void;
  onMessage: (m: LiveMsg) => void;
}

let socket: WebSocket | null = null;
let reconnectTimer: number | null = null;

export function connectLive({ url, onStatus, onMessage }: Options): () => void {
  if (!url) return () => {};
  if (socket && socket.readyState === WebSocket.OPEN) {
    try { socket.close(); } catch {}
  }
  onStatus('pending');
  try {
    socket = new WebSocket(url);
  } catch {
    onStatus('off');
    scheduleReconnect({ url, onStatus, onMessage });
    return () => {};
  }
  socket.onopen  = () => onStatus('on');
  socket.onclose = () => {
    onStatus('off');
    scheduleReconnect({ url, onStatus, onMessage });
  };
  socket.onerror = () => onStatus('off');
  socket.onmessage = (ev) => {
    let m: LiveMsg;
    try { m = JSON.parse(ev.data); } catch { return; }
    onMessage(m);
  };
  return () => {
    if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
    try { socket?.close(); } catch {}
  };
}
function scheduleReconnect(opts: Options) {
  if (reconnectTimer) clearTimeout(reconnectTimer);
  reconnectTimer = window.setTimeout(() => connectLive(opts), 2000);
}
export function sendLive(msg: LiveMsg) {
  if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify(msg));
}
