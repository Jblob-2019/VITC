// server.js — AEGIS Networking simulator.
//
// Models the real PMA* cost function per overview.md §11:
//   rssi   = α·rssiCost + β·etxCost + γ·batteryCost + δ·hopCost + ε·riskCost
//   mode 'RSSI': only rssi/hop; mode 'RSSI+ETX' adds ETX-derived cost.
// The server is dumb: emits topology + per-edge RSSI/ETX/battery/risk,
// client computes the actual route and decides. We also include:
//   - EWMA RSSI prediction (α=0.2) + 3-sample slope buffer + monotonic guard
//     → risk bit if forecast RSSI < THRESHOLD_HARD and 3 consecutive declines
//   - Welford online delivery-ratio (ETX) per edge
//   - Battery drain per hop (0.05% per packet forwarded)
//   - Anomaly bit if delivery ratio drifts > 3σ below mean

import express from 'express';
import { WebSocketServer } from 'ws';
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import { dirname, resolve, join } from 'node:path';
import { existsSync, readFileSync } from 'node:fs';

// ESP32 gateway → server ingestion. The firmware batches a newline-delimited
// stream of {node, role, bat, nb, route, mode, rssi, nbrs:[{id,rssi,etx,bat,risk}]}
// records (one per gateway telemetry tick). We forward each as a single
// live snapshot into the WebSocket so the dashboard renders real data.
const INGEST_BODY_LIMIT = '256kb';

function espIngestTick(rec, n) {
    // Translate a single {node,role,...} record into the {cmd:'tick',nodes,edges}
    // shape the dashboard already consumes.
    const nodeId = rec.node | 0;
    const role   = rec.role | 0;
    const nbrs   = Array.isArray(rec.nbrs) ? rec.nbrs : [];
    const etx    = (rec.nbrs && rec.nbrs[0] && rec.nbrs[0].etx) ? rec.nbrs[0].etx : 1.0;

    // Position: pin the gateway at the left edge, distribute the rest in a
    // deterministic circle. The dashboard already overrides via /positions.json.
    if (!n.byId.has(nodeId)) {
        const total = Math.max(1, rec.nb | 0 || nbrs.length || 1);
        const ang = (n.byId.size / total) * Math.PI * 2;
        n.byId.set(nodeId, {
            id: nodeId,
            x: role === 2 ? 110 : (340 + Math.cos(ang) * 230),
            y: role === 2 ? 210 : (180 + Math.sin(ang) * 140),
            isGateway: role === 2,
            role, battery: rec.bat | 0, anomaly: false,
            route_mode: rec.mode | 0,
        });
        n.order.push(nodeId);
    } else {
        const cur = n.byId.get(nodeId);
        cur.role = role;
        cur.battery = rec.bat | 0;
        cur.route_mode = rec.mode | 0;
    }

    // Map neighbour records to edges (a-b keyed, deduped).
    const node = n.byId.get(nodeId);
    for (const nb of nbrs) {
        const a = Math.min(nodeId, nb.id | 0);
        const b = Math.max(nodeId, nb.id | 0);
        const k = `${a}-${b}`;
        if (n.edgeSeen.has(k)) continue;
        n.edgeSeen.add(k);
        const rssi = (nb.rssi | 0);
        const etx1 = (nb.etx != null) ? Number(nb.etx) : 1.0;
        n.edges.push({
            a, b,
            rssi,
            rssiEma: rssi,
            forecast: rssi,
            pEma: 1 / Math.max(0.05, etx1),
            risk: (nb.risk | 0) ? 1 : 0,
            interfered: false,
            history: [rssi],
            label: `${rssi}dBm / etx ${etx1.toFixed(2)}`,
        });
    }

    // Keep node history in sync so the dashboard's per-edge coloring still
    // has data points to plot when the simulation hasn't been run.
    void etx;
    return node;
}

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');
const PUBLIC_DIR = join(ROOT, 'public');
const IS_RENDER = !!process.env.RENDER || !!process.env.RENDER_EXTERNAL_URL;

const args = Object.fromEntries(
  process.argv.slice(2).reduce((acc, cur, i, arr) => {
    if (cur.startsWith('--')) acc.push([cur.slice(2), arr[i + 1]]);
    return acc;
  }, [])
);
const HTTP_PORT = parseInt(args['port-http'] || process.env.PORT || '4000', 10);
const TICK_MS = parseInt(args['tick'] || '1200', 10);   // slow down per request

// Comma-separated list of allowed origins for the SPA → /ws handshake.
// In production this is your Render URL (and its www variant). In dev, allow
// the Vite origin and same-host. Wildcard `*` is used only when explicitly
// opted in (handy for a quick LAN ESP32 test).
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS ||
  (IS_RENDER
    ? [process.env.RENDER_EXTERNAL_URL, `https://${process.env.RENDER_EXTERNAL_HOSTNAME}`].filter(Boolean).join(',')
    : 'http://localhost:3000,http://127.0.0.1:3000')
).split(',').map((s) => s.trim()).filter(Boolean);
const ALLOW_ALL_ORIGINS = process.env.ALLOW_ALL_ORIGINS === '1' || ALLOWED_ORIGINS.includes('*');

function isOriginAllowed(origin) {
  if (!origin) return true; // native apps (ESP32 / curl) send no Origin
  if (ALLOW_ALL_ORIGINS) return true;
  return ALLOWED_ORIGINS.includes(origin);
}

const CLIENTS = new Set();

// ===== Tunables (mirror mesh_node.ino config.h) =====
const ALPHA_EWMA = 0.2;
const PRED_SLOPE_THRESH = -0.03;
const PRED_TREND_COUNT = 3;
const THRESHOLD_HARD = -70;     // dBm
const PRED_WINDOW_S = 5;

const NODE_ROLES = [2, 1, 0, 1, 0, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0];

let state = { nodeCount: 16, noise: 2 };

// ===== Topology =====
let nodes = [];
let edges = [];                 // { a, b, rssiEma, slopeBuf, history, pEma, mu, var, battery }
let srcRotate = 1;
let pinnedSrc = null;           // when set, src stays on this node every tick
let tickN = 0;

function dist(a, b) { return Math.hypot(a.x - b.x, a.y - b.y); }
function edgeKey(a, b) { return a < b ? `${a}-${b}` : `${b}-${a}`; }

const SIM_W = 1100;
const SIM_H = 420;

// Pathological-but-deterministic initial seed so the page renders without chaos.
function regen(n) {
  state.nodeCount = n;
  nodes = [];
  nodes.push({ id: 0, x: SIM_W * 0.10, y: SIM_H * 0.5, isGateway: true, role: NODE_ROLES[0] });
  let s = n * 12345 + 7;
  for (let i = 1; i < n; i++) {
    s = (s * 1103515245 + 12345) & 0x7fffffff;
    const x = SIM_W * 0.22 + (s % (SIM_W * 0.72));
    s = (s * 1103515245 + 12345) & 0x7fffffff;
    const y = 30 + (s % (SIM_H - 60));
    nodes.push({
      id: i, x, y, isGateway: false, role: NODE_ROLES[i % NODE_ROLES.length],
      battery: 100 - (i * 5) % 60, anomaly: false, route_mode: 1,
      vx: (Math.random() - 0.5) * 2, vy: (Math.random() - 0.5) * 2
    });
  }
  edges = [];
  for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) {
    const d0 = dist(nodes[i], nodes[j]);
    const rssi0 = Math.round(-30 - 55 * (d0 / 190) + (Math.random() - 0.5) * state.noise);
    edges.push({
      a: Math.min(i, j), b: Math.max(i, j),
      rssi: rssi0,            // last raw sample
      rssiEma: rssi0,         // EWMA
      slopeBuf: [],           // last 3 slopes
      prevRssi: rssi0,
      mu: 0.9,                // Welford mean of p (= delivery prob)
      M2: 0,
      samples: 0,
      pEma: 0.9,              // EWMA of p
      risk: 0,                // 0 or 1: forecast breach
      interfered: false,
      lastForecast: rssi0,
      history: [rssi0],
    });
  }
  srcRotate = 1;
  pinnedSrc = null;          // any pin resets on topology regeneration
  tickN = 0;
}

function setInterfered(key, on) {
  const [i, j] = key.split('-').map(Number);
  const e = edges.find((ee) => ee.a === i && ee.b === j || ee.a === j && ee.b === i);
  if (e) e.interfered = !!on;
}

// ===== Per-tick update =====
function tickTopology() {
  tickN++;
  // Battery drain and node mobility
  for (const n of nodes) {
    if (!n.isGateway) {
      n.battery = Math.max(0, n.battery - 0.05 + (Math.random() - 0.5) * 0.04);
      if (n.battery > 0) {
        n.vx += (Math.random() - 0.5) * 0.5;
        n.vy += (Math.random() - 0.5) * 0.5;
        n.vx *= 0.95; n.vy *= 0.95; // drag
        n.x += n.vx; n.y += n.vy;
        if (n.x < 20) { n.x = 20; n.vx *= -1; } else if (n.x > SIM_W - 20) { n.x = SIM_W - 20; n.vx *= -1; }
        if (n.y < 20) { n.y = 20; n.vy *= -1; } else if (n.y > SIM_H - 20) { n.y = SIM_H - 20; n.vy *= -1; }
      }
    }
  }
  // Per-edge: resample RSSI, update EWMA + slope, update Welford delivery prob.
  for (const e of edges) {
    const n = nodes.find((x) => x.id === e.a);
    const m = nodes.find((x) => x.id === e.b);
    
    // Environmental wave interference (1% chance to start, lasts a few ticks)
    if (Math.random() < 0.01 && !e.interfered) e.waveDuration = 5 + Math.random() * 10;
    if (e.waveDuration > 0) e.waveDuration--;

    const d = dist(n, m);
    // RSSI = -30 − 55·(d/190) + jitter·noise − 22 if interfered
    let r = -30 - 55 * (d / 190) + (Math.random() - 0.5) * 2 * state.noise;
    if (e.interfered) r -= 22;
    if (e.waveDuration > 0) r -= 25; // wave attenuation
    
    // Dead nodes sever all connections
    if (n.battery === 0 || m.battery === 0) r = -120;

    const rssi = Math.round(r);

    // Update EWMA
    e.rssiEma = ALPHA_EWMA * rssi + (1 - ALPHA_EWMA) * e.rssiEma;
    // Update slope buffer (Δ/Δt in dBm/s; ~1 tick ≈ TICK_MS)
    const slope = (rssi - e.prevRssi) / (TICK_MS / 1000);
    e.slopeBuf.push(slope); if (e.slopeBuf.length > PRED_TREND_COUNT) e.slopeBuf.shift();
    e.prevRssi = rssi;
    // Forecast: m + slope·W; if forecast < THRESHOLD_HARD AND last 3 slopes all < thresh → risk bit
    const meanSlope = e.slopeBuf.reduce((a, b) => a + b, 0) / Math.max(1, e.slopeBuf.length);
    const forecast = e.rssiEma + meanSlope * PRED_WINDOW_S;
    e.lastForecast = forecast;
    const allDeclining = e.slopeBuf.length === PRED_TREND_COUNT &&
      e.slopeBuf.every((s) => s < PRED_SLOPE_THRESH);
    e.risk = (forecast < THRESHOLD_HARD && allDeclining) ? 1 : 0;

    // Delivery probability (Welford + EMA)
    const ok = Math.random() < ((e.interfered ? 0.35 : 1) * Math.min(0.99, Math.max(0.05,
      (forecast + 100) / 80,  // map -100..-20 → 0..1, capped
    )));
    e.samples++;
    const delta = (ok ? 1 : 0) - e.mu;
    e.mu += delta / e.samples;
    e.M2 += delta * ((ok ? 1 : 0) - e.mu);
    e.pEma = 0.7 * e.pEma + 0.3 * (ok ? 1 : 0);

    e.rssi = rssi;
    e.history.push(rssi); if (e.history.length > 10) e.history.shift();
    e.label = `${rssi}dBm` + (e.risk ? ` ⚠` : ``);
  }
  // Anomaly on a node: roughly 5% of nodes if delivery on any of its edges falls >3σ below mean
  for (const n of nodes) {
    n.anomaly = false;
    for (const e of edges) {
      if (e.a !== n.id && e.b !== n.id) continue;
      if (e.samples < 8) continue;
      const sigma = Math.sqrt(e.M2 / e.samples);
      if (sigma > 0.05 && e.pEma < e.mu - 3 * sigma) { n.anomaly = true; break; }
    }
  }
}

function snapshot(srcOverride) {
  tickTopology();
  if (srcOverride !== undefined) {
    // explicit pick_src from a client: pin
    srcRotate = srcOverride;
    pinnedSrc = srcOverride;
  } else if (pinnedSrc === null) {
    // auto-rotate only when no client has pinned a source
    srcRotate = (srcRotate % Math.max(1, nodes.length - 1)) + 1;
  } else {
    // honour the existing pin
    srcRotate = pinnedSrc;
  }
  const src = nodes[srcRotate] || nodes[Math.max(1, srcRotate % (nodes.length - 1) + 1)];
  return {
    cmd: 'tick',
    tick: tickN,
    nodes: nodes.map((n) => ({ ...n, history: undefined })),
    edges: edges.map((e) => ({
      a: e.a, b: e.b,
      rssi: e.rssi, rssiEma: Math.round(e.rssiEma), forecast: Math.round(e.lastForecast),
      pEma: e.pEma, risk: e.risk, interfered: e.interfered, history: e.history, label: e.label,
    })),
    src: src?.id ?? 0,
    target: 0,                // GW always
    tickMs: TICK_MS,
    pinned: pinnedSrc !== null,
  };
}

regen(state.nodeCount);

// ===== HTTP + WS =====
const app = express();

// Render (and most PaaS) terminate TLS at an edge proxy and forward X-Forwarded-*
// to the app. Trust the first hop so req.ip / secure() reflect the real client.
// In dev we run direct, so leave trust-proxy off.
if (IS_RENDER) app.set('trust proxy', 1);

// Lightweight CORS for the /ws handshake and any REST. Browsers require an
// explicit Access-Control-Allow-Origin to upgrade a cross-origin WS.
app.use((req, res, next) => {
  const origin = req.headers.origin;
  if (isOriginAllowed(origin)) {
    if (origin) res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
    res.setHeader('Access-Control-Allow-Credentials', 'true');
    res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  }
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

// Health probe — Render uses this; cheap and idempotent.
app.get('/healthz', (_req, res) => {
  res.json({ ok: true, tickMs: TICK_MS, nodes: nodes.length, edges: edges.length });
});

// ---- ESP32 /ingest ------------------------------------------------------
// Body is a batch of newline-delimited JSON records:
//     {"node":2,"role":1,"bat":87,"nb":3,"route":4,"mode":0,"rssi":-58,
//      "nbrs":[{"id":0,"rssi":-62,"etx":1.1,"bat":99,"risk":0}, ...]}
//     {"node":4,...}\n
// We translate each into the {cmd:'tick',nodes,edges} shape the dashboard
// already speaks and broadcast it on /ws so real ESP32 telemetry replaces
// the simulator until the next sim tick overwrites it.
app.use('/ingest', express.text({ type: '*/*', limit: INGEST_BODY_LIMIT }));

// Live state from real hardware. The simulator continues to broadcast on
// its own TICK_MS cadence; the ESP32 snapshots sit on top.
const LIVE = {
    byId: new Map(),
    order: [],
    edges: [],
    edgeSeen: new Set(),
    lastSeen: 0,
};

function liveSnapshot() {
    const list = LIVE.order.map((id) => LIVE.byId.get(id));
    return {
        cmd: 'tick',
        tick: ++tickN,
        src: 0,
        target: 0,
        pinned: false,
        tickMs: TICK_MS,
        nodes: list.map((n) => ({ ...n, history: undefined })),
        edges: LIVE.edges.map((e) => ({ ...e })),
        live: true,
    };
}

app.post('/ingest', (req, res) => {
    const body = req.body || '';
    if (!body.length) return res.status(204).end();
    const lines = String(body).split('\n').map((l) => l.trim()).filter(Boolean);
    let parsed = 0, skipped = 0;
    for (const line of lines) {
        let rec;
        try { rec = JSON.parse(line); }
        catch { skipped++; continue; }
        if (typeof rec !== 'object' || rec === null || rec.node == null) { skipped++; continue; }
        espIngestTick(rec, LIVE);
        parsed++;
    }
    LIVE.lastSeen = Date.now();
    if (parsed) {
        const snap = liveSnapshot();
        // Push to every WS client. Replaces the simulator's snapshot on
        // this tick for any browser that has `live` clients, so the
        // dashboard reflects real radio state immediately.
        const data = JSON.stringify(snap);
        for (const ws of CLIENTS) {
            if (ws.readyState === ws.OPEN) {
                try { ws.send(data); } catch {}
            }
        }
    }
    res.json({ ok: true, parsed, skipped });
});

// Serve the React build (web → /public) if it exists. In dev, Vite owns /.
// In Render production, `npm run build` populates public/ and we serve it here.
if (existsSync(PUBLIC_DIR)) {
  app.use(express.static(PUBLIC_DIR, { maxAge: '5m', index: 'index.html' }));
  // Anything that isn't /ws /api /healthz /positions.json falls back to the SPA.
  app.get(/^\/(?!ws$|api|healthz|positions\.json).*/, (_req, res, next) => {
    const indexFile = join(PUBLIC_DIR, 'index.html');
    if (!existsSync(indexFile)) return next();
    res.setHeader('Cache-Control', 'no-cache');
    res.send(readFileSync(indexFile));
  });
}

// Useful for the dashboard's optional fixed-layout file.
app.get('/positions.json', (_req, res) => {
  const f = join(ROOT, 'positions.json');
  if (!existsSync(f)) return res.json({});
  res.type('application/json').send(readFileSync(f));
});

// Generic static fallback for non-React assets (positions.json at root, etc.).
app.use(express.static(ROOT));

const httpServer = createServer(app);

// WebSocket server. We attach to the same HTTP server but route the
// Upgrade event ourselves — that lets us enforce the Origin allow-list
// and also keeps the path explicit, which helps when Render terminates
// the TLS connection.
const wss = new WebSocketServer({ noServer: true });

httpServer.on('upgrade', (req, socket, head) => {
  if (req.url !== '/ws' && req.url !== '/ws/') {
    socket.destroy();
    return;
  }
  if (!isOriginAllowed(req.headers.origin)) {
    socket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
    socket.destroy();
    return;
  }
  wss.handleUpgrade(req, socket, head, (ws) => {
    wss.emit('connection', ws, req);
  });
});

wss.on('connection', (ws) => {
  CLIENTS.add(ws);
  try { ws.send(JSON.stringify(snapshot())); } catch {}
  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch { return; }
    switch (msg.cmd) {
      case 'new_topology': regen(state.nodeCount); broadcast(snapshot()); break;
      case 'set_nodes':    regen(Math.max(6, Math.min(40, msg.n | 0))); broadcast(snapshot()); break;
      case 'set_noise':    state.noise = Math.max(0, Math.min(10, msg.n | 0)); broadcast(snapshot()); break;
      case 'reset_stats':  regen(state.nodeCount); broadcast(snapshot()); break;
      case 'toggle_edge':  setInterfered(msg.key, !!msg.on); broadcast(snapshot()); break;
      case 'set_mode':     broadcast({ cmd: 'mode', mode: msg.mode }); break;
      case 'pick_src':
        if (msg.src === null || msg.src === undefined || msg.src === '') {
          pinnedSrc = null;           // resume auto-rotate
          broadcast(snapshot());
        } else {
          broadcast(snapshot(msg.src | 0));    // pin and emit
        }
        break;
      case 'recharge':
        for (const n of nodes) n.battery = 100;
        broadcast(snapshot());
        break;
    }
  });
  ws.on('close', () => CLIENTS.delete(ws));
});

function broadcast(obj) {
  const data = JSON.stringify(obj);
  for (const ws of CLIENTS) {
    if (ws.readyState === ws.OPEN) try { ws.send(data); } catch {}
  }
}

setInterval(() => {
    // Once the ESP32 is talking, suspend the simulator so real telemetry
    // stays visible. Resume 60 s after the last ingest.
    const liveFresh = LIVE.lastSeen && (Date.now() - LIVE.lastSeen < 60000);
    if (liveFresh && LIVE.order.length) return;
    broadcast(snapshot());
}, TICK_MS);

httpServer.listen(HTTP_PORT, '0.0.0.0', () => {
  const secure = IS_RENDER;
  const proto = secure ? 'https' : 'http';
  const wsProto = secure ? 'wss' : 'ws';
  const host = process.env.RENDER_EXTERNAL_HOSTNAME || `localhost:${HTTP_PORT}`;
  console.log(`[http] serving on ${proto}://${host}`);
  console.log(`[ws]   WebSocket at ${wsProto}://${host}/ws  (tick ${TICK_MS}ms)`);
  if (ALLOW_ALL_ORIGINS) console.log('[cors] ALLOW_ALL_ORIGINS=1 — every Origin accepted');
  else console.log(`[cors] allowed origins: ${ALLOWED_ORIGINS.join(', ') || '(none)'}`);
});
