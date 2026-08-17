// server.js — AEGIS Networking local backend
// Express static + ws WebSocket + synthetic mesh simulator.
// Pass --port <COM> to forward real serial telemetry.

import express from 'express';
import { WebSocketServer } from 'ws';
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { existsSync } from 'node:fs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');

const args = Object.fromEntries(
  process.argv.slice(2).reduce((acc, cur, i, arr) => {
    if (cur.startsWith('--')) acc.push([cur.slice(2), arr[i + 1]]);
    return acc;
  }, [])
);
const HTTP_PORT = parseInt(args['port-http'] || process.env.PORT || '4000', 10);
const SERIAL_PORT = args.port || null;
const SERIAL_BAUD = parseInt(args.baud || '115200', 10);

const LATEST = new Map();   // id -> telemetry object
const CLIENTS = new Set();
let ROUTE_MODE = 0;         // 0=RSSI, 1=ETX

// ---------- Synthetic mesh simulator ----------
const NODE_BATTERY = [100, 78, 64, 88, 55];
const NODE_ROLES  = [2, 1, 0, 1, 0];  // GW, Relay, Sensor, Relay, Sensor
const NODE_NAMES  = ['Buoy-GW', 'Vessel-1', 'Buoy-2', 'Vessel-3', 'Buoy-4'];
const nodes = NODE_BATTERY.map((b, i) => ({
  id: i, name: NODE_NAMES[i], role: NODE_ROLES[i], battery: b,
  rssi: -55 - i * 3, etx: 1.1 + i * 0.1, hop: (i === 1 || i === 3) ? 1 : 2,
  route: 0
}));

function simTick() {
  const out = [];
  for (let i = 1; i < nodes.length; i++) {
    const n = nodes[i];
    n.rssi = Math.max(-92, Math.min(-45, n.rssi + Math.floor(Math.random() * 5 - 2)));
    n.etx  = Math.max(1.0, Math.min(3.5, n.etx + (Math.random() * 0.1 - 0.05)));
    n.risk = (n.rssi < -70 || n.etx > 2.0) ? 1 : 0;
    n.battery = Math.max(5, n.battery - (Math.random() < 0.25 ? 1 : 0));
    const nbrs = [];
    for (let j = 1; j < nodes.length; j++) {
      if (j === i) continue;
      const r = nodes[j];
      nbrs.push({ id: j, rssi: r.rssi, etx: Math.round(r.etx * 10), bat: r.battery, risk: r.risk, hop: r.hop });
    }
    const payload = {
      id: i, role: n.role, bat: n.battery,
      mode: ROUTE_MODE, nb: nbrs.length, route: n.route, nbrs
    };
    out.push(payload);
  }
  return out;
}

function broadcast(obj) {
  const data = JSON.stringify(obj);
  for (const ws of CLIENTS) {
    if (ws.readyState === ws.OPEN) {
      try { ws.send(data); } catch {}
    }
  }
}

setInterval(() => {
  const ticks = simTick();
  for (const t of ticks) {
    LATEST.set(t.id, t);
    broadcast(t);
  }
}, 1000);

// ---------- Real serial forwarder (optional) ----------
if (SERIAL_PORT) {
  // eslint-disable-next-line no-console
  console.log(`[serial] requested ${SERIAL_PORT} @ ${SERIAL_BAUD}`);
  // optional: lazy-load serialport if installed
  import('serialport').then(({ SerialPort }) => {
    import('@serialport/parser-readline').then(({ ReadlineParser }) => {
      const port = new SerialPort({ path: SERIAL_PORT, baudRate: SERIAL_BAUD });
      const parser = port.pipe(new ReadlineParser({ delimiter: '\n' }));
      parser.on('data', (line) => {
        const s = line.toString().trim();
        if (!s) return;
        try {
          const obj = JSON.parse(s);
          if ('id' in obj) LATEST.set(obj.id, obj);
          broadcast(obj);
        } catch { /* ignore non-JSON */ }
      });
      port.on('open', () => console.log(`[serial] opened ${SERIAL_PORT}`));
      port.on('error', (e) => console.error('[serial]', e.message));
    }).catch((e) => console.error('[serial parser]', e.message));
  }).catch(() => {
    console.log('[serial] serialport not installed; simulator continues');
  });
}

// ---------- HTTP ----------
const app = express();
app.use(express.static(ROOT));
// Fallback dashboard: serve mesh_dashboard.html if no root index exists.
const INDEX_FILE = (() => {
  for (const name of ['index.html', 'mesh_dashboard.html']) {
    const p = join(ROOT, name);
    if (existsSync(p)) return p;
  }
  return null;
})();
app.get('/', (_req, res) => {
  if (INDEX_FILE) return res.sendFile(INDEX_FILE);
  res.status(404).send('No dashboard file in ' + ROOT + '. Run `cd web && npm run build` to generate one.');
});
app.get('/positions.json', (_req, res) => {
  res.sendFile(join(ROOT, 'positions.json'));
});
app.get('/api/latest', (_req, res) => {
  res.json(Array.from(LATEST.values()));
});
app.get('/api/positions', (_req, res) => {
  res.sendFile(join(ROOT, 'positions.json'));
});

const server = createServer(app);
const wss = new WebSocketServer({ server, path: '/ws' });

wss.on('connection', (ws) => {
  CLIENTS.add(ws);
  console.log(`[ws] client connected (${CLIENTS.size} total)`);
  // immediately push the latest cached telemetry so the UI fills in
  for (const obj of LATEST.values()) {
    try { ws.send(JSON.stringify(obj)); } catch {}
  }
  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch { return; }
    if (msg.cmd === 'set_mode') {
      if (msg.mode === 'ETX')  ROUTE_MODE = 1;
      else if (msg.mode === 'RSSI') ROUTE_MODE = 0;
      else return;
      console.log(`[ws] MODE:${msg.mode}`);
      broadcast({ cmd: 'mode', mode: msg.mode, route_mode: ROUTE_MODE });
    }
  });
  ws.on('close', () => {
    CLIENTS.delete(ws);
    console.log(`[ws] client disconnected (${CLIENTS.size} total)`);
  });
});

server.listen(HTTP_PORT, '0.0.0.0', () => {
  console.log(`[http] serving on http://localhost:${HTTP_PORT}`);
  console.log(`[http] open http://localhost:${HTTP_PORT}/ in a browser`);
});
