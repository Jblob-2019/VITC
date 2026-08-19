// =============================================================================
//  mesh_node_gateway.ino  —  gateway variant of mesh_node.ino.
//
//  Identical to mesh_node.ino except setup() always forces my_id = GATEWAY_ID
//  so this board becomes the gateway regardless of MY_ID in config.h.
//
//  Flash THIS file (with MeshDiagnostics.h, config.h, mesh_proto.h in the
//  same sketch folder) on the board that should be the gateway — usually
//  the one tethered to USB on the demo laptop.  Flash mesh_node.ino on
//  every other board; set MY_ID per board via config.h.
// =============================================================================

#include <Arduino.h>
#include <WiFi.h>
#include <esp_now.h>
#include <LittleFS.h>
#include <HTTPClient.h>

#include "config.h"
#include "mesh_proto.h"

// ---- Backend connection --------------------------------------------------
const char* WIFI_SSID   = "OPPO K13 5G";                  // <-- Wi-Fi SSID
const char* WIFI_PASS   = "12345678";                     // <-- Wi-Fi password
const char* BACKEND_URL = "http://10.49.11.179:4000/ingest";
const uint32_t HTTP_PERIOD_MS = 5000;
const uint16_t HTTP_TIMEOUT_MS = 8000;
const uint8_t  HTTP_MAX_RETRIES = 3;

// ---- Pins (ESP32-WROOM-32 DevKit v1) -------------------------------------
#define PIN_SENSOR_0          32
#define PIN_SENSOR_1          33
#define PIN_BATTERY_ADC       34
#define PIN_LED_OK            25
#define PIN_LED_ALERT         26
#define PIN_BTN_BOOT           0

// ---- Globals -------------------------------------------------------------
static const uint8_t BCAST[6] = {0xFF,0xFF,0xFF,0xFF,0xFF,0xFF};

uint8_t        my_id            = MY_ID;
uint8_t        my_role          = ROLE_SENSOR;
uint8_t        my_battery       = 90;
uint8_t        current_next_hop = 0xFF;
uint8_t        route_mode       = 0;
RTC_DATA_ATTR uint32_t seq_counter = 0;

neighbor_t neighbors[MAX_NEIGHBORS];
uint8_t    n_neighbors = 0;

QueueHandle_t q_crit, q_rel, q_be;

struct dedup_entry { uint32_t key; bool used; };
static dedup_entry dedup[DEDUP_CACHE_SIZE];
static uint8_t     dedup_head = 0;

struct anomaly_state {
    float mean, var;
    int   n, prev;
    bool  bootstrapped;
    uint8_t last_flag;
};
static anomaly_state anomaly_s0, anomaly_s1;

// ---- Helpers -------------------------------------------------------------
static inline float clamp01(float v) {
    return v < 0.0f ? 0.0f : (v > 1.0f ? 1.0f : v);
}
static float rssiCost(int8_t r)    { return clamp01(1.0f - (float)(r + 100) / 70.0f); }
static float etxCost(float e)      { if (e < 1) e = 1; if (e > 5) e = 5; return clamp01((e - 1) / 4); }
static float batteryCost(uint8_t b){ if (b > 100) b = 100; return clamp01(1.0f - (float)b / 100); }
static float riskCost(uint8_t r)   { return r ? 1.0f : 0.0f; }
static float hopCost(uint8_t h)    { return clamp01((float)h / PACKET_TTL_MAX); }

static uint16_t crc16(const uint8_t *d, int n) {
    uint16_t c = 0xFFFF;
    for (int i = 0; i < n; ++i) {
        c ^= d[i] << 8;
        for (int k = 0; k < 8; ++k) c = (c & 0x8000) ? (c << 1) ^ 0x1021 : c << 1;
    }
    return c;
}

static bool dedup_seen(uint32_t key) {
    for (uint8_t i = 0; i < DEDUP_CACHE_SIZE; ++i)
        if (dedup[i].used && dedup[i].key == key) return true;
    dedup[dedup_head] = {key, true};
    dedup_head = (dedup_head + 1) % DEDUP_CACHE_SIZE;
    return false;
}
static inline uint32_t dedup_key(const mesh_pkt_t &p) {
    return ((uint32_t)p.src << 24) | ((p.seq >> 8) & 0x00FFFFFFu);
}

// ---- Neighbour / predictor ----------------------------------------------
static void add_peer(const uint8_t *mac) {
    if (esp_now_is_peer_exist(mac)) return;
    esp_now_peer_info_t pi = {};
    memcpy(pi.peer_addr, mac, 6);
    pi.channel = 0; pi.encrypt = false;
    esp_now_add_peer(&pi);
}
static void del_peer(const uint8_t *mac) { esp_now_del_peer(mac); }

static void neighbor_update(const mesh_pkt_t &p, const uint8_t *mac) {
    if (p.type != HELLO) return;
    if (p.src == my_id) return;

    uint8_t idx = 0xFF;
    for (uint8_t i = 0; i < n_neighbors; ++i)
        if (neighbors[i].id == p.src) { idx = i; break; }

    if (idx == 0xFF) {
        if (n_neighbors >= MAX_NEIGHBORS) return;
        idx = n_neighbors++;
        neighbors[idx].id = p.src;
        memcpy(neighbors[idx].mac, mac, 6);
        add_peer(mac);
        neighbors[idx].ewma_rssi = (float)p.rssi;
        neighbors[idx].ewma_etx  = 1.0f;
        neighbors[idx].etx       = 1.0f;
        neighbors[idx].hist_idx  = 0;
        neighbors[idx].slope_idx = 0;
        for (uint8_t i = 0; i < 3; ++i) {
            neighbors[idx].ewma_hist[i] = p.rssi;
            neighbors[idx].slope_hist[i] = 0;
        }
    }
    neighbor_t &nb = neighbors[idx];
    nb.rssi = p.rssi;
    nb.last_seen_ms = millis();

    const hello_payload_t *hp = (const hello_payload_t *)p.payload;
    nb.battery    = hp->battery;
    nb.hop_count  = hp->hop_count;
    if (hp->etx_est_x10 > 0)
        nb.ewma_etx = (float)hp->etx_est_x10 / 10.0f;

    float prev = nb.ewma_rssi;
    float now  = ALPHA_EWMA * (float)nb.rssi + (1 - ALPHA_EWMA) * prev;
    nb.ewma_hist[nb.hist_idx] = (int8_t)prev;
    nb.hist_idx = (nb.hist_idx + 1) % 3;
    nb.ewma_rssi = now;

    float slope = now - prev;
    nb.slope_hist[nb.slope_idx] = slope;
    nb.slope_idx = (nb.slope_idx + 1) % 3;

    float avg = 0;
    for (uint8_t i = 0; i < 3; ++i) avg += nb.slope_hist[i];
    avg /= 3.0f;
    nb.pred_rssi = nb.ewma_rssi + avg * (PRED_WINDOW_MS / 1000.0f);
}

static void remove_neighbor(uint8_t idx) {
    del_peer(neighbors[idx].mac);
    for (uint8_t j = idx; j + 1 < n_neighbors; ++j) neighbors[j] = neighbors[j+1];
    n_neighbors--;
    if (current_next_hop >= n_neighbors && n_neighbors) current_next_hop = 0;
}

static void compute_costs_and_risk() {
    for (uint8_t i = 0; i < n_neighbors; ++i) {
        neighbor_t &nb = neighbors[i];
        if (nb.sent_cnt) {
            float dr = (float)nb.ack_cnt / (float)nb.sent_cnt;
            if (dr < 0.01f) dr = 0.01f;
            float e = 1.0f / dr;
            nb.ewma_etx = ALPHA_ETX * e + (1 - ALPHA_ETX) * nb.ewma_etx;
            nb.etx = e;
        }
        nb.risk = 0;
        if (nb.pred_rssi < THRESHOLD_HARD) nb.risk = 1;
        bool dec = true;
        for (uint8_t s = 0; s < 3; ++s)
            if (nb.slope_hist[s] >= PRED_SLOPE_THRESH) { dec = false; break; }
        if (dec) nb.risk = 1;
        if (nb.ewma_etx > 2.0f) nb.risk = 1;
        if (nb.battery < BATTERY_LOW_THRESH) nb.risk = 1;
    }
    uint32_t now = millis();
    for (int i = (int)n_neighbors - 1; i >= 0; --i) {
        if (now - neighbors[i].last_seen_ms > HELLO_DEAD_MS) {
            remove_neighbor((uint8_t)i);
        }
    }
}

static float edge_cost(const neighbor_t &nb) {
    float rc = rssiCost(nb.rssi);
    float ec = route_mode ? etxCost(nb.ewma_etx) : rssiCost(nb.rssi);
    float bc = batteryCost(nb.battery);
    float hc = hopCost(nb.hop_count);
    float rk = riskCost(nb.risk);
    if (route_mode) return W_RSSI*rc + W_ETX*ec + W_BATTERY*bc + W_HOPS*hc + W_RISK*rk;
    else           return W_RSSI*rc + W_BATTERY*bc + W_HOPS*hc + W_RISK*rk;
}

static float current_etx() {
    float best = 1.0f;
    for (uint8_t i = 0; i < n_neighbors; ++i)
        if (neighbors[i].ewma_etx < best) best = neighbors[i].ewma_etx;
    return best;
}

// ---- PMA* ----------------------------------------------------------------
struct a_node { uint8_t id; float g, f; uint8_t parent; bool opened, closed; };

static uint8_t pma_next_hop(uint8_t src) {
    if (n_neighbors == 0) return 0xFF;
    if (my_id == GATEWAY_ID) return my_id;

    const uint8_t MAX_N = MAX_NEIGHBORS + 1;
    a_node nodes[MAX_N];
    uint8_t nc = 0;
    nodes[nc++] = {src, 0, 0, 0xFF, false, false};
    for (uint8_t i = 0; i < n_neighbors; ++i)
        nodes[nc++] = {neighbors[i].id, 1e9f, 1e9f, 0xFF, false, false};

    auto idx_of = [&](uint8_t id) -> int8_t {
        for (uint8_t i = 0; i < nc; ++i) if (nodes[i].id == id) return i;
        return -1;
    };
    uint8_t open[MAX_N]; uint8_t olen = 0;
    auto push = [&](uint8_t i) {
        open[olen++] = i;
        for (int x = (int)olen-1; x > 0;) {
            int p = (x-1)/2;
            if (nodes[open[x]].f < nodes[open[p]].f) {
                uint8_t t = open[x]; open[x] = open[p]; open[p] = t;
                x = p;
            } else break;
        }
    };
    auto pop = [&]() -> uint8_t {
        uint8_t top = open[0];
        open[0] = open[--olen];
        for (uint8_t x = 0;;) {
            uint8_t l = x*2+1, r = l+1, m = x;
            if (l < olen && nodes[open[l]].f < nodes[open[m]].f) m = l;
            if (r < olen && nodes[open[r]].f < nodes[open[m]].f) m = r;
            if (m == x) break;
            uint8_t t = open[x]; open[x] = open[m]; open[m] = t;
            x = m;
        }
        return top;
    };

    nodes[0].f = 0;
    push(0);
    while (olen) {
        uint8_t ci = pop();
        a_node &c = nodes[ci];
        if (c.closed) continue;
        c.closed = true;
        if (c.id == GATEWAY_ID) {
            uint8_t hop = c.parent;
            while (hop != 0xFF) {
                int8_t pi = idx_of(hop);
                if (pi < 0) break;
                uint8_t p = nodes[pi].parent;
                if (p == src) break;
                hop = p;
            }
            return (hop == src) ? GATEWAY_ID : hop;
        }
        for (uint8_t n = 0; n < n_neighbors; ++n) {
            neighbor_t &nbr = neighbors[n];
            if (nbr.id == c.id) continue;
            int8_t ni = idx_of(nbr.id);
            if (ni < 0) continue;
            a_node &s = nodes[ni];
            if (s.closed) continue;
            float tg = c.g + edge_cost(nbr);
            if (!s.opened || tg < s.g) {
                s.g = tg; s.f = tg; s.parent = c.id;
                if (!s.opened) { s.opened = true; push(ni); }
            }
        }
    }
    return 0xFF;
}

// ---- Anomaly -------------------------------------------------------------
static uint8_t anomaly_push(anomaly_state &s, int x) {
    s.n++;
    float d = x - s.mean;
    s.mean += d / s.n;
    s.var  += d * (x - s.mean);
    if (s.n < ANOM_WIN) { s.prev = x; return 0; }
    if (!s.bootstrapped) { s.bootstrapped = true; s.prev = x; return 0; }
    float sd = sqrtf(s.var / s.n);
    if (sd < 0.001f) sd = 0.001f;
    uint8_t flag = 0;
    if (fabsf(x - s.mean) > ANOM_Z_THRESH * sd) flag = 1;
    else if (fabsf(x - s.prev) > ANOM_JUMP_THRESH * sd) flag = 2;
    s.prev = x;
    s.last_flag = flag;
    return flag;
}

// ---- Radio ---------------------------------------------------------------
static volatile bool last_send_ok = true;
static void onDataSent(const wifi_tx_info_t *, esp_now_send_status_t st) {
    last_send_ok = (st == ESP_NOW_SEND_SUCCESS);
}
static void onDataRecv(const esp_now_recv_info_t *info, const uint8_t *data, int len) {
    const uint8_t *mac = info ? info->src_addr : nullptr;
    if (len < (int)sizeof(mesh_pkt_t)) return;
    mesh_pkt_t p; memcpy(&p, data, sizeof(p));
    if (p.crc != crc16(data, sizeof(p) - 2)) return;
    if (p.type == HELLO) { neighbor_update(p, mac); return; }

    QueueHandle_t q;
    if (p.prio == CRITICAL)      q = q_crit;
    else if (p.prio == RELIABLE) q = q_rel;
    else                         q = q_be;

    BaseType_t hp = pdFALSE;
    xQueueSendFromISR(q, &p, &hp);
    if (hp) portYIELD_FROM_ISR(hp);
}

static void radio_init() {
    if (esp_now_init() != ESP_OK) { Serial.println(F("esp_now fail")); return; }
    esp_now_register_send_cb(onDataSent);
    esp_now_register_recv_cb(onDataRecv);
    esp_now_peer_info_t bc = {};
    memcpy(bc.peer_addr, BCAST, 6);
    bc.channel = (uint8_t)WiFi.channel();
    bc.encrypt = false;
    esp_now_add_peer(&bc);
    Serial.printf("{\"espnow\":{\"ready\":true,\"ch\":%d}}\n", (int)WiFi.channel());
}

static void espnow_refresh_channel() {
    uint8_t ch = (uint8_t)WiFi.channel();
    if (ch == 0) return;
    esp_now_del_peer(BCAST);
    esp_now_peer_info_t bc = {};
    memcpy(bc.peer_addr, BCAST, 6);
    bc.channel = ch; bc.encrypt = false;
    esp_now_add_peer(&bc);
}

// ---- Forwarding + buffer + ACK ------------------------------------------
static void send_unicast(uint8_t next_id, const mesh_pkt_t &p) {
    for (uint8_t i = 0; i < n_neighbors; ++i)
        if (neighbors[i].id == next_id) {
            mesh_pkt_t q = p;
            q.crc = crc16((uint8_t*)&q, sizeof(q) - 2);
            esp_now_send(neighbors[i].mac, (uint8_t*)&q, sizeof(q));
            neighbors[i].sent_cnt++;
            return;
        }
}

static void process_queue(QueueHandle_t q) {
    mesh_pkt_t p;
    while (xQueueReceive(q, &p, 0) == pdTRUE) {
        if (dedup_seen(dedup_key(p))) continue;
        if (p.ttl == 0) continue;
        p.ttl--;

        if (p.type == ACK) {
            for (uint8_t i = 0; i < n_neighbors; ++i)
                if (neighbors[i].id == p.src) { neighbors[i].ack_cnt++; break; }
            continue;
        }

        if (p.dst == my_id) {
            if (p.qos > 0) {
                mesh_pkt_t ack = {};
                ack.type = ACK; ack.ver = 1;
                ack.src = my_id; ack.dst = p.src;
                ack.seq = p.seq;
                ack.crc = crc16((uint8_t*)&ack, sizeof(ack) - 2);
                send_unicast(p.src, ack);
            }
            continue;
        }

        uint8_t nh = (p.prio == CRITICAL) ? pma_next_hop(my_id) : current_next_hop;
        if (nh == 0xFF || nh == my_id) {
            File f = LittleFS.open(BUFFER_FILE, "a");
            if (f) { f.write((uint8_t*)&p, sizeof(p)); f.close(); }
            continue;
        }
        send_unicast(nh, p);
    }
}

static void drain_buffer() {
    if (!LittleFS.exists(BUFFER_FILE)) return;
    LittleFS.remove(BUFFER_TMP);
    File src = LittleFS.open(BUFFER_FILE, "r");
    if (!src) return;
    File dst = LittleFS.open(BUFFER_TMP, "w");
    if (!dst) { src.close(); return; }

    mesh_pkt_t p;
    while ((int)src.available() >= (int)sizeof(p)) {
        src.readBytes((char*)&p, sizeof(p));
        uint8_t nh = pma_next_hop(my_id);
        if (nh != 0xFF && nh != my_id) {
            send_unicast(nh, p);
        } else {
            dst.write((uint8_t*)&p, sizeof(p));
        }
    }
    src.close(); dst.close();
    LittleFS.remove(BUFFER_FILE);
    LittleFS.rename(BUFFER_TMP, BUFFER_FILE);
}

// ---- Scheduler ticks -----------------------------------------------------
static void read_battery() {
    uint32_t sum = 0;
    for (int i = 0; i < 16; ++i) sum += analogRead(PIN_BATTERY_ADC);
    uint32_t raw = sum / 16;
    if (raw < 50) { my_battery = 100; return; }
    float v = (float)raw / 4095.0f * 3.3f * 2.0f;
    int pct = (int)((v - 3.0f) / 1.2f * 100.0f);
    if (pct < 0) pct = 0; if (pct > 100) pct = 100;
    my_battery = (uint8_t)pct;
}

static void tick_heartbeat() {
    mesh_pkt_t p = {};
    p.type = HELLO; p.ver = 1;
    p.src = my_id; p.dst = 0xFF;
    p.prio = BEST_EFFORT; p.qos = 0;
    p.seq = ++seq_counter;
    p.rssi = (int8_t)WiFi.RSSI();

    hello_payload_t hp = {};
    hp.battery     = my_battery;
    hp.role        = my_role;
    hp.etx_est_x10 = (uint8_t)(current_etx() * 10);
    hp.hop_count   = (my_id == GATEWAY_ID) ? 0
                      : (current_next_hop == 0xFF ? 255 : 1);
    memcpy(p.payload, &hp, sizeof(hp));
    p.crc = crc16((uint8_t*)&p, sizeof(p) - 2);
    esp_now_send(BCAST, (uint8_t*)&p, sizeof(p));
}

static void tick_anomaly() {
    int a0 = analogRead(PIN_SENSOR_0);
    int a1 = analogRead(PIN_SENSOR_1);
    uint8_t f0 = anomaly_push(anomaly_s0, a0);
    uint8_t f1 = anomaly_push(anomaly_s1, a1);

    static uint32_t last_led = 0;
    if (f0 || f1) {
        if (millis() - last_led > 120) {
            digitalWrite(PIN_LED_ALERT, !digitalRead(PIN_LED_ALERT));
            last_led = millis();
        }
        digitalWrite(PIN_LED_OK, LOW);
    } else {
        digitalWrite(PIN_LED_ALERT, LOW);
        digitalWrite(PIN_LED_OK, HIGH);
    }

    if (f0 || f1) {
        mesh_pkt_t p = {};
        p.type = ANOM; p.ver = 1; p.prio = RELIABLE;
        p.src = my_id; p.dst = GATEWAY_ID;
        p.seq = ++seq_counter;
        p.payload[0] = my_id;
        p.payload[1] = f0;
        p.payload[2] = f1;
        p.crc = crc16((uint8_t*)&p, sizeof(p) - 2);
        send_unicast(pma_next_hop(my_id), p);
    }
}

static void tick_telemetry() {
    String s;
    s.reserve(256 + n_neighbors * 80);
    s  = F("{\"id\":");    s += my_id;
    s += F(",\"role\":");  s += my_role;
    s += F(",\"bat\":");   s += my_battery;
    s += F(",\"mode\":");  s += route_mode;
    s += F(",\"nb\":");    s += n_neighbors;
    s += F(",\"route\":"); s += current_next_hop;
    s += F(",\"nbrs\":[");
    for (uint8_t i = 0; i < n_neighbors; ++i) {
        if (i) s += ',';
        s += F("{\"id\":");    s += neighbors[i].id;
        s += F(",\"rssi\":");  s += neighbors[i].rssi;
        s += F(",\"etx\":");   s += String(neighbors[i].ewma_etx, 1);
        s += F(",\"bat\":");   s += neighbors[i].battery;
        s += F(",\"risk\":");  s += neighbors[i].risk;
        s += F(",\"hop\":");   s += neighbors[i].hop_count;
        s += '}';
    }
    s += F("]}\n");
    Serial.print(s);
}

static void tick_role() {
    if (my_id == GATEWAY_ID) { my_role = ROLE_GW; return; }
    my_role = (n_neighbors >= 3) ? ROLE_RELAY : ROLE_SENSOR;
}

// ---- Backend HTTP push ---------------------------------------------------
static String  http_buf;
static uint16_t http_count = 0;
static uint32_t http_last_fail_log_ms = 0;

static bool url_is_https() { return strncmp(BACKEND_URL, "https://", 8) == 0; }

static void http_diag_once() {
    const char* scheme = url_is_https() ? "https" : "http";
    Serial.printf("[http] scheme=%s target=%s\n", scheme, BACKEND_URL);
}

static int http_post_once(const String &body) {
    HTTPClient http;
    if (url_is_https()) {
        WiFiClientSecure sec;
        sec.setInsecure();
        http.begin(sec, BACKEND_URL);
    } else {
        WiFiClient plain;
        http.begin(plain, BACKEND_URL);
    }
    http.setTimeout(HTTP_TIMEOUT_MS);
    http.setReuse(false);
    http.addHeader("Content-Type", "application/json");
    int code = http.POST(body);
    http.end();
    return code;
}

static void http_push_now() {
    if (my_role != ROLE_GW) return;
    if (WiFi.status() != WL_CONNECTED) {
        uint32_t now = millis();
        if (now - http_last_fail_log_ms > 30000) {
            Serial.println(F("[http] skipped: WiFi down"));
            http_last_fail_log_ms = now;
        }
        http_buf = ""; http_count = 0;
        return;
    }
    if (http_buf.length() == 0) return;

    int code = -1;
    for (uint8_t attempt = 1; attempt <= HTTP_MAX_RETRIES && code <= 0; ++attempt) {
        code = http_post_once(http_buf);
        if (code <= 0 && attempt < HTTP_MAX_RETRIES) delay(1500 * attempt);
    }

    uint32_t now = millis();
    if (code > 0) {
        Serial.printf("[http] POST %s -> %d (n=%u, bytes=%u)\n",
                      BACKEND_URL, code, http_count, (unsigned)http_buf.length());
        http_last_fail_log_ms = 0;
    } else {
        if (now - http_last_fail_log_ms > 30000) {
            Serial.printf("[http] POST %s -> %d (connect/timeout)\n", BACKEND_URL, code);
            http_last_fail_log_ms = now;
        }
    }

    if (code > 0) { http_buf = ""; http_count = 0; }
    else if (http_count > 10) { http_buf = ""; http_count = 0; }
}

static void tick_http() {
    if (my_role != ROLE_GW) return;

    String line;
    line.reserve(256);
    line  = F("{\"node\":"); line += my_id;
    line += F(",\"role\":"); line += my_role;
    line += F(",\"bat\":");  line += my_battery;
    line += F(",\"nb\":");   line += n_neighbors;
    line += F(",\"route\":");line += current_next_hop;
    line += F(",\"mode\":"); line += route_mode;
    line += F(",\"rssi\":"); line += WiFi.RSSI();
    line += F(",\"nbrs\":[");
    for (uint8_t i = 0; i < n_neighbors; ++i) {
        if (i) line += ',';
        line += F("{\"id\":");   line += neighbors[i].id;
        line += F(",\"rssi\":"); line += neighbors[i].rssi;
        line += F(",\"etx\":");  line += String(neighbors[i].ewma_etx, 1);
        line += F(",\"bat\":");  line += neighbors[i].battery;
        line += F(",\"risk\":"); line += neighbors[i].risk;
        line += '}';
    }
    line += F("]}\n");

    http_buf  += line;
    http_count++;
}

#include "MeshDiagnostics.h"

void setup() {
    Serial.begin(115200);
    delay(200);
    Serial.println(F("mesh_node (gateway) booting…"));

    pinMode(PIN_LED_OK,    OUTPUT);
    pinMode(PIN_LED_ALERT, OUTPUT);
    pinMode(PIN_BTN_BOOT,  INPUT_PULLUP);
    analogReadResolution(12);
    digitalWrite(PIN_LED_OK, HIGH);

    // ---- GATEWAY VARIANT: force gateway id regardless of MY_ID ----
    my_id   = GATEWAY_ID;
    my_role = ROLE_GW;
    Serial.printf("{\"boot\":{\"forced_gateway\":true,\"my_id\":%u}}\n", my_id);

    read_battery();
    if (!LittleFS.begin()) Serial.println(F("FS fail"));

    WiFi.mode(WIFI_STA);
    WiFi.begin(WIFI_SSID, WIFI_PASS);
    Serial.printf("{\"wifi\":{\"ssid\":\"%s\",\"connecting\":true}}\n", WIFI_SSID);
    uint32_t t0 = millis();
    while (WiFi.status() != WL_CONNECTED && millis() - t0 < 8000) delay(200);
    if (WiFi.status() == WL_CONNECTED) {
        Serial.printf("{\"wifi\":{\"connected\":true,\"ip\":\"%s\",\"rssi\":%d,\"ch\":%d}}\n",
                      WiFi.localIP().toString().c_str(), WiFi.RSSI(),
                      (int)WiFi.channel());
    } else {
        Serial.println(F("{\"wifi\":{\"connected\":false}}"));
    }

    q_crit = xQueueCreate(16, sizeof(mesh_pkt_t));
    q_rel  = xQueueCreate(32, sizeof(mesh_pkt_t));
    q_be   = xQueueCreate(32, sizeof(mesh_pkt_t));
    radio_init();
    my_role = ROLE_GW;
    http_diag_once();

    Serial.printf("{\"boot\":{\"id\":%u,\"role\":%u,\"bat\":%u,\"ch\":%d}}\n",
                  my_id, my_role, my_battery, (int)WiFi.channel());
}

uint32_t last_hb = 0, last_cost = 0, last_telem = 0,
         last_anom = 0, last_role = 0, last_drain = 0,
         last_bat  = 0, last_http = 0;

void loop() {
    uint32_t now = millis();

    process_queue(q_crit);
    process_queue(q_rel);
    process_queue(q_be);

    static uint8_t last_ch = 0xFF;
    uint8_t ch = (uint8_t)WiFi.channel();
    if (ch && ch != last_ch) {
        if (last_ch != 0xFF) espnow_refresh_channel();
        last_ch = ch;
    }

    if (now - last_hb    >= HELLO_INTERVAL_MS) { tick_heartbeat();   last_hb    = now; }
    if (now - last_cost  >= 1000)              { compute_costs_and_risk();
        uint8_t new_nh = pma_next_hop(my_id);
        if (new_nh != 0xFF && new_nh != current_next_hop) current_next_hop = new_nh;
        last_cost = now; }
    if (now - last_anom  >= 100)               { tick_anomaly();     last_anom  = now; }
    if (now - last_drain >= 1000)              { drain_buffer();     last_drain = now; }
    if (now - last_role  >= 30000)             { tick_role();        last_role  = now; }
    if (now - last_telem >= 1000)              { tick_telemetry();   last_telem = now; }
    if (now - last_bat   >= 30000)             { read_battery();     last_bat   = now; }

    if (my_role == ROLE_GW) {
        tick_http();
        if (now - last_http >= HTTP_PERIOD_MS) {
            http_push_now();
            last_http = now;
        }
    }

    static String line;
    while (Serial.available()) {
        char c = (char)Serial.read();
        if (c == '\n') {
            line.trim();
            if      (line == "MODE:ETX") route_mode = 1;
            else if (line == "MODE:RSSI") route_mode = 0;
            line = "";
        } else if (line.length() < 32) {
            line += c;
        }
    }
    diag_poll();
}