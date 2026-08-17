// pma.cpp - Predictive Maritime A* implementation
#include "pma.h"
#include <Arduino.h>
#include <esp_now.h>
#include <float.h>

// Global neighbour table
neighbor_t neighbors[MAX_NEIGHBORS];
uint8_t    n_neighbors = 0;

// ----- helpers ------------------------------------------------------------
static inline float clamp01(float v) {
    return v < 0.0f ? 0.0f : (v > 1.0f ? 1.0f : v);
}

float rssiCost(int8_t rssi) {
    // -100 dBm → 1.0 (worst), -30 dBm → 0.0 (best)
    float f = (float)(rssi + 100) / 70.0f;
    return clamp01(1.0f - f);
}

float etxCost(float etx) {
    if (etx < 1.0f) etx = 1.0f;
    if (etx > 5.0f) etx = 5.0f;
    return clamp01((etx - 1.0f) / 4.0f);
}

float batteryCost(uint8_t bat) {
    if (bat > 100) bat = 100;
    return clamp01(1.0f - (float)bat / 100.0f);
}

float riskCost(uint8_t risk) { return risk ? 1.0f : 0.0f; }

float hopCost(uint8_t hops) {
    return clamp01((float)hops / (float)PACKET_TTL_MAX);
}

// ----- ESP-NOW peer registration -------------------------------------------
static void add_peer(const uint8_t *mac) {
    esp_now_peer_info_t pi = {};
    memcpy(pi.peer_addr, mac, 6);
    pi.channel = 0;
    pi.encrypt = false;
    esp_now_add_peer(&pi);  // duplicate add is safe
}

// ----- HELLO handling -----------------------------------------------------
void pma_update_hello(const mesh_pkt_t &pkt, const uint8_t *mac) {
    if (pkt.type != HELLO) return;

    // Find or create entry
    uint8_t idx = 0xFF;
    for (uint8_t i = 0; i < n_neighbors; ++i) {
        if (neighbors[i].id == pkt.src) { idx = i; break; }
    }
    if (idx == 0xFF) {
        if (n_neighbors >= MAX_NEIGHBORS) return;
        idx = n_neighbors++;
        neighbors[idx].id = pkt.src;
        memcpy(neighbors[idx].mac, mac, 6);
        add_peer(mac);
        neighbors[idx].ewma_rssi = (float)pkt.rssi;
        neighbors[idx].ewma_etx  = 1.0f;
        neighbors[idx].hist_idx  = 0;
        neighbors[idx].slope_idx = 0;
        for (uint8_t i = 0; i < 3; ++i) {
            neighbors[idx].ewma_hist[i] = pkt.rssi;
            neighbors[idx].slope_hist[i] = 0.0f;
        }
    }

    neighbor_t &nb = neighbors[idx];
    nb.rssi = pkt.rssi;
    nb.last_seen_ms = millis();

    // HELLO payload fields
    const hello_payload_t *hp = (const hello_payload_t *)pkt.payload;
    nb.battery = hp->battery;
    if (hp->etx_est_x10 > 0) {
        // trust the neighbour's own etx estimate as a starting point
        nb.ewma_etx = (float)hp->etx_est_x10 / 10.0f;
    }

    // ----- EWMA update -----
    float prev_ewma = nb.ewma_rssi;
    float new_ewma = ALPHA_EWMA * (float)nb.rssi + (1.0f - ALPHA_EWMA) * prev_ewma;
    nb.ewma_hist[nb.hist_idx] = (int8_t)prev_ewma;
    nb.hist_idx = (nb.hist_idx + 1) % 3;
    nb.ewma_rssi = new_ewma;

    // ----- Slope -----
    float slope = (nb.ewma_rssi - prev_ewma) / 1.0f;  // HELLO ≈ 1 s apart
    nb.slope_hist[nb.slope_idx] = slope;
    nb.slope_idx = (nb.slope_idx + 1) % 3;

    // ----- Predicted RSSI -----
    float avg_slope = 0.0f;
    for (uint8_t i = 0; i < 3; ++i) avg_slope += nb.slope_hist[i];
    avg_slope /= 3.0f;
    nb.pred_rssi = nb.ewma_rssi + avg_slope * (PRED_WINDOW_MS / 1000.0f);
}

// ----- Compute risk bits & ETX EMA ----------------------------------------
static void update_risk_bits() {
    for (uint8_t i = 0; i < n_neighbors; ++i) {
        neighbor_t &nb = neighbors[i];
        nb.risk = 0;

        // predicted RSSI too low
        if (nb.pred_rssi < THRESHOLD_HARD) nb.risk = 1;

        // monotonically decreasing trend
        bool decreasing = true;
        for (uint8_t s = 0; s < 3; ++s) {
            if (nb.slope_hist[s] >= PRED_SLOPE_THRESH) { decreasing = false; break; }
        }
        if (decreasing) nb.risk = 1;

        // ETX rising
        if (nb.ewma_etx > 2.0f) nb.risk = 1;

        // low battery
        if (nb.battery < BATTERY_LOW_THRESH) nb.risk = 1;
    }
}

void pma_compute_costs() {
    // ETX forward delivery ratio (simple: ack_cnt / max(sent_cnt,1))
    for (uint8_t i = 0; i < n_neighbors; ++i) {
        neighbor_t &nb = neighbors[i];
        if (nb.sent_cnt > 0) {
            float dr = (float)nb.ack_cnt / (float)nb.sent_cnt;
            if (dr < 0.01f) dr = 0.01f;
            float etx = 1.0f / dr;          // df = 1 (placeholder, uses remote ewma_etx)
            nb.ewma_etx = ALPHA_ETX * etx + (1.0f - ALPHA_ETX) * nb.ewma_etx;
            nb.etx = etx;
        }
    }
    update_risk_bits();
}

// ----- Edge cost ----------------------------------------------------------
static float edge_cost(const neighbor_t &nb) {
    float rc = rssiCost(nb.rssi);
    float ec = etxCost(nb.ewma_etx);
    float bc = batteryCost(nb.battery);
    float hc = hopCost(nb.hop_count);
    float rk = riskCost(nb.risk);

    return W_RSSI * rc + W_ETX * ec + W_BATTERY * bc + W_HOPS * hc + W_RISK * rk;
}

// ----- A* (PMA*) ----------------------------------------------------------
struct a_node {
    uint8_t id;
    float   g, f;
    uint8_t parent;
    bool    opened, closed;
};

static float heuristic(uint8_t /*from*/, uint8_t /*to*/) {
    return 0.0f;  // small mesh, Dijkstra is fine
}

uint8_t pma_next_hop(uint8_t src) {
    // Build node set: self + all known neighbours (max 9)
    const uint8_t MAX_NODES = MAX_NEIGHBORS + 1;
    a_node nodes[MAX_NODES];
    uint8_t node_count = 0;

    nodes[node_count++] = {src, 0.0f, 0.0f, 0xFF, false, false};
    for (uint8_t i = 0; i < n_neighbors; ++i) {
        nodes[node_count++] = {neighbors[i].id, FLT_MAX, FLT_MAX, 0xFF, false, false};
    }

    auto idx_of = [&](uint8_t nid) -> int8_t {
        for (uint8_t i = 0; i < node_count; ++i)
            if (nodes[i].id == nid) return (int8_t)i;
        return -1;
    };

    // tiny binary heap
    uint8_t open[MAX_NODES];
    uint8_t open_len = 0;
    auto heap_push = [&](uint8_t i) {
        open[open_len++] = i;
        for (int x = (int)open_len - 1; x > 0;) {
            int p = (x - 1) / 2;
            if (nodes[open[x]].f < nodes[open[p]].f) {
                uint8_t t = open[x]; open[x] = open[p]; open[p] = t;
                x = p;
            } else break;
        }
    };
    auto heap_pop = [&]() -> uint8_t {
        uint8_t top = open[0];
        open[0] = open[--open_len];
        for (uint8_t x = 0;;) {
            uint8_t l = x * 2 + 1, r = l + 1, m = x;
            if (l < open_len && nodes[open[l]].f < nodes[open[m]].f) m = l;
            if (r < open_len && nodes[open[r]].f < nodes[open[m]].f) m = r;
            if (m == x) break;
            uint8_t t = open[x]; open[x] = open[m]; open[m] = t;
            x = m;
        }
        return top;
    };

    // initialise start
    nodes[0].g = 0.0f;
    nodes[0].f = heuristic(src, GATEWAY_ID);
    heap_push(0);

    while (open_len) {
        uint8_t cur_i = heap_pop();
        a_node &cur = nodes[cur_i];
        if (cur.id == GATEWAY_ID) {
            // reconstruct first hop
            uint8_t hop = cur.parent;
            while (hop != src && hop != 0xFF) {
                int8_t pi = idx_of(hop);
                if (pi < 0) break;
                uint8_t p = nodes[pi].parent;
                if (p == src) break;
                hop = p;
            }
            return (hop == src) ? GATEWAY_ID : hop;
        }
        if (cur.closed) continue;
        cur.closed = true;

        // expand neighbours of cur.id
        for (uint8_t n = 0; n < n_neighbors; ++n) {
            neighbor_t &nbr = neighbors[n];
            if (nbr.id == cur.id) continue;  // self, ignore
            int8_t ni = idx_of(nbr.id);
            if (ni < 0) continue;
            a_node &succ = nodes[ni];
            if (succ.closed) continue;

            float cost = edge_cost(nbr);
            float tg = cur.g + cost;
            if (!succ.opened || tg < succ.g) {
                succ.g = tg;
                succ.f = tg + heuristic(succ.id, GATEWAY_ID);
                succ.parent = cur.id;
                if (!succ.opened) {
                    succ.opened = true;
                    heap_push(ni);
                }
            }
        }
    }
    return 0xFF;  // no route
}

// ----- Telemetry blob -----------------------------------------------------
uint8_t pma_fill_telemetry(uint8_t *buf, uint8_t maxlen) {
    uint8_t pos = 0;
    for (uint8_t i = 0; i < n_neighbors && pos + 6 <= maxlen; ++i) {
        neighbor_t &nb = neighbors[i];
        buf[pos++] = nb.id;
        buf[pos++] = (uint8_t)(nb.rssi + 100);   // 0-70
        buf[pos++] = (uint8_t)(nb.ewma_etx * 10);
        buf[pos++] = nb.battery;
        buf[pos++] = nb.risk;
        buf[pos++] = nb.hop_count;
    }
    return pos;
}
