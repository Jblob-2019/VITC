// config.h - Centralised tunables for the maritime mesh
#pragma once

// ---- Node identity (demo-pinned) ---------------------------------------
#ifndef GATEWAY_ID
#define GATEWAY_ID          0
#endif
#ifndef MY_ID
#define MY_ID               0   // override per board
#endif

// ---- Tables -------------------------------------------------------------
#define MAX_NEIGHBORS       8
#define DEDUP_CACHE_SIZE    64

// ---- Discovery ----------------------------------------------------------
#define HELLO_INTERVAL_MS   1000
#define HELLO_STALE_MS      3000
#define HELLO_DEAD_MS       6000

// ---- Predictor ----------------------------------------------------------
#define ALPHA_EWMA          0.2f
#define PRED_SLOPE_THRESH  -0.03f
#define PRED_TREND_COUNT    3
#define PRED_WINDOW_MS      5000
#define THRESHOLD_HARD     -70   // dBm

// ---- ETX ----------------------------------------------------------------
#define ALPHA_ETX           0.2f
#define ETX_WINDOW          20

// ---- Edge-cost weights (PMA*) -------------------------------------------
#define W_RSSI              0.35f
#define W_ETX               0.30f
#define W_BATTERY           0.15f
#define W_HOPS              0.10f
#define W_RISK              0.10f

// ---- Routing stability --------------------------------------------------
#define ROUTE_SWITCH_MARGIN 0.15f
#define PACKET_TTL_MAX      5

// ---- Anomaly detection --------------------------------------------------
#define ANOM_WIN            32
#define ANOM_Z_THRESH       4.0f
#define ANOM_JUMP_THRESH    6.0f
#define ANOM_STUCK_EPS_FRAC 0.01f

// ---- On-board buffer ----------------------------------------------------
#define BUFFER_FILE         "/buf"
#define BUFFER_MAX_ATTEMPTS 6

// ---- Energy -------------------------------------------------------------
#define BATTERY_LOW_THRESH  20

// ---- TLS (HTTPS to Render / other public hosts) --------------------------
// Paste the PEM of your backend's CA here to skip `setInsecure()`. Leave
// the macro undefined to fall back to insecure mode (fine for telemetry).
//   #define BACKEND_CA  "-----BEGIN CERTIFICATE-----\n...\n-----END CERTIFICATE-----\n"
