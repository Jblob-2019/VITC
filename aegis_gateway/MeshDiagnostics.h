// =============================================================================
//  MeshDiagnostics.h — interactive diagnostics for the GATEWAY node.
//
//  Drop this next to mesh_node.ino and add to the main file:
//      #include "MeshDiagnostics.h"
//      diag_poll();      // call once per loop() iteration
//
//  Commands (serial monitor, baud 115200, newline):
//      HELP                          list commands
//      PING <id|ALL>                 unicast PING to neighbour (or all)
//      NEIGHBORS                     dump the neighbour table
//      TRACE <id>                    run PMA* and print chosen next-hop
//      ETXCHECK <id>                 compute live ETX for that neighbour
//      BEST                          best neighbour by RSSI / ETX
//      ROUTE                         currently-cached next-hop
//      ROLE                          print local role
//      BAT                           re-read battery now
//      WHOAMI                        id, role, battery, channel, heap
//      DROP <id>                     forget a neighbour (test forced reroute)
//      TEST_HTTP                     one-shot POST to BACKEND_URL
//
//  The header is included at the BOTTOM of mesh_node.ino, after its globals,
//  enums, typedefs, and function bodies.  We forward-declare the non-
//  aggregate globals (variables) the diagnostics reference — the enums,
//  structs, and functions are all in scope by the time the bodies below
//  are parsed.
// =============================================================================
#pragma once
#include <Arduino.h>
#include <WiFi.h>
#include <esp_now.h>
#include <HTTPClient.h>

// ---------- internal state for the command parser -------------------------
// Single instance across the translation unit (not static).
String   diag_line;
uint32_t diag_last_rx_ms = 0;

static void diag_print_banner() {
    Serial.println(F("\n=== mesh diagnostics ==="));
    Serial.println(F("type HELP for commands"));
}

// ---------- command dispatcher --------------------------------------------
static void diag_handle_command(const String &raw) {
    String s = raw; s.trim();
    if (!s.length()) return;

    // ---- HELP ----
    if (s == "HELP" || s == "?") {
        Serial.println(F("HELP                list commands"));
        Serial.println(F("PING <id|ALL>       unicast PING (or to all neighbours)"));
        Serial.println(F("NEIGHBORS           dump neighbour table"));
        Serial.println(F("TRACE <id>          PMA* -> next-hop for that dst"));
        Serial.println(F("ETXCHECK <id>       live ETX for one neighbour"));
        Serial.println(F("BEST                strongest neighbour"));
        Serial.println(F("ROUTE               cached next-hop"));
        Serial.println(F("ROLE                local role"));
        Serial.println(F("BAT                 re-read battery"));
        Serial.println(F("WHOAMI              id/role/bat/ch/heap"));
        Serial.println(F("DROP <id>           drop neighbour (test reroute)"));
        Serial.println(F("TEST_HTTP           one-shot POST to BACKEND_URL"));
        return;
    }

    // ---- WHOAMI ----
    if (s == "WHOAMI") {
        Serial.printf("[diag] id=%u role=%u bat=%u ch=%d free_heap=%u\n",
                      my_id, my_role, my_battery,
                      (int)WiFi.channel(),
                      (unsigned)ESP.getFreeHeap());
        return;
    }

    // ---- ROLE ----
    if (s == "ROLE") {
        const char *nm = "SENSOR";
        if (my_role == ROLE_GW)    nm = "GW";
        if (my_role == ROLE_RELAY) nm = "RELAY";
        Serial.printf("[diag] role=%u (%s)\n", my_role, nm);
        return;
    }

    // ---- BAT ----
    if (s == "BAT") {
        read_battery();
        Serial.printf("[diag] battery=%u%%\n", my_battery);
        return;
    }

    // ---- ROUTE ----
    if (s == "ROUTE") {
        Serial.printf("[diag] cached next-hop=%u (0xFF = none)\n", current_next_hop);
        return;
    }

    // ---- NEIGHBORS ----
    if (s == "NEIGHBORS" || s == "N") {
        Serial.printf("[diag] %u neighbour(s)\n", n_neighbors);
        Serial.println(F("  id  rssi  ewma   etx  bat  hop  risk  sent  ack  last_ms"));
        uint32_t now = millis();
        for (uint8_t i = 0; i < n_neighbors; ++i) {
            const neighbor_t &nb = neighbors[i];
            Serial.printf("  %2u  %4d  %5.1f  %4.1f  %3u  %3u  %4u  %4u  %4u  %u\n",
                nb.id, nb.rssi, nb.ewma_rssi, nb.ewma_etx,
                nb.battery, nb.hop_count, nb.risk,
                nb.sent_cnt, nb.ack_cnt,
                now - nb.last_seen_ms);
        }
        return;
    }

    // ---- BEST ----
    if (s == "BEST") {
        if (!n_neighbors) { Serial.println(F("[diag] no neighbours")); return; }
        int8_t  best_rssi = -128;
        uint8_t best_id   = 0xFF;
        for (uint8_t i = 0; i < n_neighbors; ++i) {
            if (neighbors[i].rssi > best_rssi) {
                best_rssi = neighbors[i].rssi;
                best_id   = neighbors[i].id;
            }
        }
        Serial.printf("[diag] best neighbour id=%u rssi=%d\n", best_id, best_rssi);
        return;
    }

    // ---- TRACE ----
    if (s.startsWith("TRACE ")) {
        uint8_t dst = (uint8_t)strtoul(s.c_str()+6, nullptr, 10);
        uint8_t nh  = pma_next_hop(my_id);
        Serial.printf("[diag] PMA*(%u->%u) next-hop=%u (0xFF = no path)\n",
                      my_id, dst, nh);
        return;
    }

    // ---- ETXCHECK ----
    if (s.startsWith("ETXCHECK ")) {
        uint8_t id = (uint8_t)strtoul(s.c_str()+8, nullptr, 10);
        for (uint8_t i = 0; i < n_neighbors; ++i) {
            if (neighbors[i].id == id) {
                float dr = neighbors[i].sent_cnt
                            ? (float)neighbors[i].ack_cnt / neighbors[i].sent_cnt
                            : 0.0f;
                Serial.printf("[diag] id=%u sent=%u ack=%u dr=%.2f etx=%.2f ewma_etx=%.2f\n",
                    neighbors[i].id,
                    neighbors[i].sent_cnt, neighbors[i].ack_cnt, dr,
                    neighbors[i].etx, neighbors[i].ewma_etx);
                return;
            }
        }
        Serial.println(F("[diag] not a neighbour"));
        return;
    }

    // ---- DROP ----
    if (s.startsWith("DROP ")) {
        uint8_t id = (uint8_t)strtoul(s.c_str()+5, nullptr, 10);
        for (uint8_t i = 0; i < n_neighbors; ++i) {
            if (neighbors[i].id == id) {
                remove_neighbor(i);
                if (current_next_hop == id) current_next_hop = 0xFF;
                Serial.printf("[diag] dropped id=%u - route now %u\n", id, current_next_hop);
                return;
            }
        }
        Serial.println(F("[diag] not a neighbour"));
        return;
    }

    // ---- PING ----
    if (s.startsWith("PING")) {
        bool to_all = (s == "PING ALL");
        if (!to_all && !s.startsWith("PING ")) return;
        uint8_t id = to_all ? 0xFF : (uint8_t)strtoul(s.c_str()+5, nullptr, 10);

        mesh_pkt_t p = {};
        p.type = CONTROL; p.ver = 1; p.prio = RELIABLE; p.qos = 1;
        p.src  = my_id;  p.dst  = id;
        p.seq  = ++seq_counter;
        p.rssi = (int8_t)WiFi.RSSI();
        snprintf((char*)p.payload, sizeof(p.payload), "PING %lu", (unsigned long)p.seq);
        p.crc  = crc16((uint8_t*)&p, sizeof(p) - 2);

        uint32_t t0 = millis();
        uint8_t sent = 0;
        for (uint8_t i = 0; i < n_neighbors; ++i) {
            if (to_all || neighbors[i].id == id) {
                send_unicast(neighbors[i].id, p);
                sent++;
            }
        }
        Serial.printf("[diag] PING sent to %u target(s) seq=%lu (awaiting ACK)\n",
                      sent, (unsigned long)p.seq);
        diag_last_rx_ms = t0;
        return;
    }

    // ---- TEST_HTTP -------------------------------------------------------
    // One-shot synchronous POST that mirrors the gateway's batching path —
    // useful for proving the ESP32 -> phone hotspot -> laptop backend link
    // is live without waiting for the periodic flush.
    if (s == "TEST_HTTP" || s == "TEST") {
        if (WiFi.status() != WL_CONNECTED) {
            Serial.println(F("[test] WiFi not connected"));
            return;
        }
        String body;
        body.reserve(256);
        body  = F("{\"test\":true,\"node\":"); body += my_id;
        body += F(",\"bat\":");  body += my_battery;
        body += F(",\"heap\":"); body += ESP.getFreeHeap();
        body += F(",\"rssi\":");body += WiFi.RSSI();
        body += F(",\"ts\":");  body += millis();
        body += '}';

        WiFiClient client;
        HTTPClient http;
        http.begin(client, BACKEND_URL);
        http.setTimeout(HTTP_TIMEOUT_MS);
        http.addHeader("Content-Type", "application/json");
        uint32_t t0 = millis();
        int code = http.POST(body);
        uint32_t dt = millis() - t0;
        Serial.printf("[test] POST %s -> %d in %u ms (%u bytes)\n",
                      BACKEND_URL, code, (unsigned)dt, (unsigned)body.length());
        http.end();
        return;
    }

    // ---- unknown ----
    Serial.printf("[diag] unknown command '%s' - type HELP\n", s.c_str());
}

// ---------- poll once per loop() ------------------------------------------
static void diag_poll() {
    if (my_id != GATEWAY_ID && my_role != ROLE_GW) {
        // non-gateway: drain serial so it doesn't fill up
        while (Serial.available()) Serial.read();
        return;
    }

    while (Serial.available()) {
        char c = (char)Serial.read();
        if (c == '\n' || c == '\r') {
            if (diag_line.length()) {
                diag_handle_command(diag_line);
                diag_line = "";
            }
        } else if (diag_line.length() < 64) {
            diag_line += c;
        }
    }
}