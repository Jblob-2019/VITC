# ESP32 firmware — which `.ino` to flash

Three files belong in every Arduino IDE sketch folder. Copy these into a fresh folder named after your sketch:

- `mesh_node.ino` or `mesh_node_gateway.ino` (one of them)
- `MeshDiagnostics.h`
- `config.h`
- `mesh_proto.h`

## Which `.ino` for which board

| Board role | Flash this | Notes |
|---|---|---|
| **Gateway** (USB-tethered, runs the demo dashboard serial link) | `mesh_node_gateway.ino` | Forcibly sets `my_id = GATEWAY_ID` in `setup()`. No need to hold BOOT. |
| **All other boards** (sensors, relays) | `mesh_node.ino` | Set `MY_ID` per board in `config.h`. Optional: hold BOOT button at reset to also force gateway (handy for one-board tests). |

## Per-board `MY_ID`

Open `config.h` and change this line for each board you flash:

```cpp
#define MY_ID   2   // unique per ESP32 — 0 is reserved for the gateway
```

If you forget and two boards share an ID, their HELLO packets collide and
neighbour tables churn. Pick 1, 2, 3, … and don't repeat.

## Same sketch folder, two `.ino`s?

No. Arduino IDE treats each sketch folder as one project — having both
`.ino` files in the same folder causes a "multiple .ino files" build error.

**Workflow:**

1. `mkdir aegis_gateway && cp mesh_node_gateway.ino MeshDiagnostics.h config.h mesh_proto.h aegis_gateway/`
2. Open `aegis_gateway.ino` in Arduino IDE, flash onto the gateway board.
3. `mkdir aegis_node1 && cp mesh_node.ino MeshDiagnostics.h config.h mesh_proto.h aegis_node1/`
4. Edit `config.h` in `aegis_node1/` so `MY_ID = 1`. Flash.
5. Repeat for each board.

Or copy them all into one folder and rename the unused `.ino` to `.ino.skip`
so Arduino IDE ignores it.

## What to set in `config.h` before flashing

```cpp
#define MY_ID               <unique per board, 1..N>
#define GATEWAY_ID          0   // leave as-is, gateway board picks this up
```

That's it for board identity. Everything else (EWMA α, ETX weights, queue
sizes, anomaly thresholds) is the same on every board.

## Wi-Fi + backend URL

Both `.ino` files have `WIFI_SSID`, `WIFI_PASS`, and `BACKEND_URL` at the
top — currently:

```cpp
const char* WIFI_SSID   = "OPPO K13 5G";
const char* WIFI_PASS   = "12345678";
const char* BACKEND_URL = "http://10.49.11.179:4000/ingest";
```

Change these per-network before flashing. Only the **gateway** board needs
`BACKEND_URL` to be reachable — non-gateway nodes only use ESP-NOW and don't
need Wi-Fi, but they do need to join the same SSID to share it with peers.

## After flashing

1. Open Serial Monitor at 115200 baud.
2. You should see:
   - `mesh_node booting…`
   - `{"wifi":{"connected":true,"ip":"..."}}`
   - `{"espnow":{"ready":true,"ch":N}}`
   - `{"boot":{"id":N,"role":N,"bat":N,"ch":N}}`
3. On the gateway board only: `{"http":"scheme=http target=http://10.49.11.179:4000/ingest"}` followed every 5 s by `[http] POST ... -> 200`.

If you don't see the POST line, the gateway isn't reaching the backend — see
the troubleshooting section in `overview.md`.

## Demo commands (gateway board only, type in Serial Monitor)

```
HELP                  list all commands
NEIGHBORS             dump neighbour table
BEST                  strongest neighbour by RSSI
ETXCHECK <id>         live delivery ratio / ETX for one neighbour
PING <id|ALL>         unicast PING (or broadcast to all)
TEST_HTTP             one-shot POST to BACKEND_URL
MODE:ETX              switch to RSSI+ETX routing
MODE:RSSI             switch to RSSI-only routing
```