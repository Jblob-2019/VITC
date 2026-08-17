// pma.h - Predictive Maritime A* (PMA*) public API
#pragma once
#include <stdint.h>
#include "mesh_proto.h"

// Update neighbour table on incoming HELLO and register peer for unicast
void pma_update_hello(const mesh_pkt_t &pkt, const uint8_t *mac);

// Recompute edge costs (called from the scheduler tick)
void pma_compute_costs();

// Run PMA* from `src` to the gateway; return next-hop id, or 0xFF if none
uint8_t pma_next_hop(uint8_t src);

// Fill a compact telemetry blob (id, rssi, etx, bat, risk, hop) per neighbour
// Returns number of bytes written. `buf` must be >= 48 bytes.
uint8_t pma_fill_telemetry(uint8_t *buf, uint8_t maxlen);

// Cost helpers (0 = best, 1 = worst)
float rssiCost(int8_t rssi);
float etxCost(float etx);
float batteryCost(uint8_t bat);
float riskCost(uint8_t risk);
float hopCost(uint8_t hops);
