#!/usr/bin/env python3
"""
bridge.py — demo-grade local backend.

Serves the dashboard + a built-in simulator over the same HTTP port,
exposes WebSocket at /ws, and forwards MODE:RSSI / MODE:ETX toggles
back to clients.

If a real serial port is given via --port, it forwards that stream too;
otherwise it runs a synthetic mesh simulator identical to the one in
mesh_dashboard.html so the live pane shows something moving.

Usage:
    python bridge.py                       # simulator mode (no hardware)
    python bridge.py --port COM3           # real ESP32
    python bridge.py --port /dev/ttyUSB0   # Linux/Mac
"""
import asyncio
import json
import math
import os
import random
import sys
import time
import argparse
from pathlib import Path

from aiohttp import web, WSMsgType  # type: ignore

ROOT = Path(__file__).parent.resolve()

# ----------------------------------------------------------------------------
# State
# ----------------------------------------------------------------------------
WS_CLIENTS: set = set()
LATEST_TELEMETRY = {}
SERIAL_TASK = None
SIM_TASK = None
ROUTE_MODE = 0           # 0=RSSI, 1=ETX (mirrors firmware)
POSITION_FILE = ROOT / "positions.json"

# ----------------------------------------------------------------------------
# Synthetic mesh simulator (no hardware needed)
# ----------------------------------------------------------------------------
N_NODES = 5
GATEWAY = 0
NODE_BATTERY = [100, 78, 64, 88, 55]
NODE_ROLES  = [2, 1, 0, 1, 0]
NODE_NAMES  = ["Buoy-GW", "Vessel-1", "Buoy-2", "Vessel-3", "Buoy-4"]

neighbors = {
    i: {"rssi": -55 - i*3, "etx": 1.1 + i*0.1, "battery": NODE_BATTERY[i],
        "risk": 0, "hop": 1 if i in (1, 3) else 2, "route": 0}
    for i in range(1, N_NODES)
}

def sim_tick():
    """Generate one tick of synthetic telemetry, returning a dict per node."""
    out = []
    for i in range(1, N_NODES):
        n = neighbors[i]
        n["rssi"] = max(-92, min(-45, n["rssi"] + random.randint(-2, 2)))
        n["etx"]  = max(1.0, min(3.5, n["etx"] + random.uniform(-0.05, 0.05)))
        n["risk"] = 1 if (n["rssi"] < -70 or n["etx"] > 2.0) else 0
        n["battery"] = max(5, n["battery"] - random.choice([0, 0, 0, 1]))
        nbrs = []
        for j in range(1, N_NODES):
            if j == i: continue
            r = neighbors[j]
            nbrs.append({
                "id": j, "rssi": r["rssi"], "etx": int(r["etx"]*10),
                "bat": r["battery"], "risk": r["risk"], "hop": r["hop"]
            })
        out.append({
            "id": i, "role": NODE_ROLES[i], "bat": n["battery"],
            "mode": ROUTE_MODE, "nb": len(nbrs), "route": n["route"],
            "nbrs": nbrs
        })
    return out

async def sim_loop():
    """Periodically broadcast synthetic telemetry to all WS clients."""
    while True:
        try:
            ticks = sim_tick()
            for payload in ticks:
                LATEST_TELEMETRY[payload["id"]] = payload
                await broadcast(payload)
        except Exception as e:
            print(f"[sim] {e}", file=sys.stderr)
        await asyncio.sleep(1.0)

# ----------------------------------------------------------------------------
# Real serial forwarder (optional)
# ----------------------------------------------------------------------------
async def serial_loop(path: str, baud: int):
    try:
        import serial_asyncio  # type: ignore
    except ImportError:
        print("[serial] pyserial-asyncio not installed; install with: pip install pyserial pyserial-asyncio", file=sys.stderr)
        return
    try:
        reader, writer = await serial_asyncio.open_serial_connection(
            url=path, baudrate=baud
        )
    except Exception as e:
        print(f"[serial] cannot open {path}: {e}", file=sys.stderr)
        return
    print(f"[serial] opened {path} @ {baud}")
    while True:
        try:
            line = await reader.readline()
            if not line:
                await asyncio.sleep(0.2); continue
            line = line.decode("utf-8", errors="ignore").strip()
            if not line: continue
            try:
                obj = json.loads(line)
            except json.JSONDecodeError:
                continue
            if "id" in obj:
                LATEST_TELEMETRY[obj["id"]] = obj
            await broadcast(obj)
        except Exception as e:
            print(f"[serial] {e}", file=sys.stderr)
            await asyncio.sleep(1)

# ----------------------------------------------------------------------------
# WebSocket plumbing
# ----------------------------------------------------------------------------
async def broadcast(obj):
    if not WS_CLIENTS: return
    payload = json.dumps(obj)
    dead = []
    for ws in list(WS_CLIENTS):
        try:
            if ws.closed: dead.append(ws)
            else: await ws.send_str(payload)
        except Exception:
            dead.append(ws)
    for d in dead:
        WS_CLIENTS.discard(d)

async def ws_handler(request: web.Request):
    ws = web.WebSocketResponse()
    await ws.prepare(request)
    WS_CLIENTS.add(ws)
    print(f"[ws] client connected ({len(WS_CLIENTS)} total)")
    # immediately push the latest cached telemetry so the UI fills in
    for obj in LATEST_TELEMETRY.values():
        try: await ws.send_str(json.dumps(obj))
        except Exception: break
    async for msg in ws:
        if msg.type == WSMsgType.TEXT:
            try:
                cmd = json.loads(msg.data)
            except Exception:
                continue
            if cmd.get("cmd") == "set_mode":
                mode = cmd.get("mode", "RSSI")
                if mode == "ETX":  ROUTE_MODE = 1
                elif mode == "RSSI": ROUTE_MODE = 0
                else: continue
                print(f"[ws→broadcast] MODE:{mode}")
                await broadcast({"cmd": "mode", "mode": mode, "route_mode": ROUTE_MODE})
        elif msg.type == WSMsgType.ERROR:
            break
    WS_CLIENTS.discard(ws)
    print(f"[ws] client disconnected ({len(WS_CLIENTS)} total)")
    return ws

# ----------------------------------------------------------------------------
# Static files (so the dashboard works from the same origin)
# ----------------------------------------------------------------------------
async def static_handler(request: web.Request):
    p = request.match_info.get("path", "")
    full = (ROOT / p).resolve()
    if not str(full).startswith(str(ROOT)) or not full.is_file():
        return web.Response(status=404, text="not found")
    return web.FileResponse(full)

# ----------------------------------------------------------------------------
# Main
# ----------------------------------------------------------------------------
async def on_startup(app):
    global SIM_TASK
    if app["serial_path"]:
        asyncio.create_task(serial_loop(app["serial_path"], app["serial_baud"]))
    SIM_TASK = asyncio.create_task(sim_loop())

async def on_cleanup(app):
    for t in (SIM_TASK,):
        if t: t.cancel()

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--port", default=None, help="serial port (optional, e.g. COM3)")
    ap.add_argument("--baud", type=int, default=115200)
    ap.add_argument("--http", default="0.0.0.0")
    ap.add_argument("--port-http", type=int, default=8080)
    args = ap.parse_args()

    app = web.Application()
    app["serial_path"] = args.port
    app["serial_baud"] = args.baud
    app.router.add_get("/ws", ws_handler)

    async def index(request): return web.FileResponse(ROOT / "mesh_dashboard.html")
    async def dash(request):  return web.FileResponse(ROOT / "mesh_dashboard.html")
    async def pos(request):   return web.FileResponse(ROOT / "positions.json")
    app.router.add_get("/", index)
    app.router.add_get("/mesh_dashboard.html", dash)
    app.router.add_get("/positions.json", pos)
    app.router.add_get("/{path:.*}", static_handler)

    app.on_startup.append(on_startup)
    app.on_cleanup.append(on_cleanup)

    runner = web.AppRunner(app)
    async def _run():
        await runner.setup()
        site = web.TCPSite(runner, args.http, args.port_http)
        await site.start()
        print(f"[http] serving on http://{args.http}:{args.port_http}")
        print(f"[http] open http://localhost:{args.port_http}/ in a browser")
        # run forever
        await asyncio.Event().wait()
    try:
        asyncio.run(_run())
    except KeyboardInterrupt:
        print("\n[bye]")

if __name__ == "__main__":
    main()
