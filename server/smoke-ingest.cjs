const WebSocket = require('ws');
const http = require('http');
const ws = new WebSocket('ws://127.0.0.1:4000/ws');
const ticks = [];

ws.on('open', () => {
  setTimeout(() => {
    const body = JSON.stringify({
      node: 7, role: 1, bat: 91, nb: 2, route: 0, mode: 0, rssi: -55,
      nbrs: [
        { id: 0, rssi: -60, etx: 1.0, bat: 100, risk: 0 },
        { id: 3, rssi: -72, etx: 1.6, bat: 60,  risk: 1 },
      ],
    });
    const req = http.request({
      host: '127.0.0.1', port: 4000, path: '/ingest', method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
    }, (res) => res.on('data', () => {}).on('end', () => {}));
    req.write(body); req.end();
  }, 200);
});

ws.on('message', (raw) => {
  const m = JSON.parse(raw.toString());
  if (m.cmd === 'tick') ticks.push(m);
  if (ticks.length >= 2) {
    const live = ticks.find((t) => t.live);
    console.log(`received ${ticks.length} ticks; ` +
      (live
        ? `live OK nodes=${live.nodes.length} edges=${live.edges.length}`
        : 'no live tick'));
    if (live) {
      console.log('sample node:', JSON.stringify(live.nodes[0]));
      console.log('sample edge:', JSON.stringify(live.edges[0]));
    }
    ws.close();
  }
});
setTimeout(() => {
  console.log(`timeout; saw ${ticks.length} ticks`);
  ws.close();
}, 3500);