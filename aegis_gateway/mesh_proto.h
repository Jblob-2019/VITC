// mesh_proto.h - packet and neighbour record
#pragma once
#include <stdint.h>
#include "config.h"

#define MAX_PAYLOAD 220

// Message types (ESP-NOW type byte)
enum msg_type : uint8_t {
    HELLO          = 0x01,
    DATA           = 0x02,
    ACK            = 0x03,
    CONTROL        = 0x04,
    OTA            = 0x05,
    ANOM           = 0x06,
    TELEMETRY_AGG  = 0x07
};

enum prio : uint8_t {
    BEST_EFFORT = 0,
    RELIABLE    = 1,
    CRITICAL    = 2
};

enum role_t : uint8_t {
    ROLE_SENSOR = 0,
    ROLE_RELAY  = 1,
    ROLE_GW     = 2
};

// Wire packet (packed for ESP-NOW)
typedef struct __attribute__((packed)) {
    uint8_t  type;
    uint8_t  ver;
    uint8_t  prio;
    uint8_t  qos;
    uint8_t  src;
    uint8_t  dst;
    uint8_t  hop;
    uint8_t  ttl;
    uint32_t seq;
    int8_t   rssi;                     // last self RSSI (for HELLO)
    uint8_t  payload[MAX_PAYLOAD];
    uint16_t crc;
} mesh_pkt_t;

// HELLO payload (fits in first bytes of mesh_pkt_t.payload)
// byte 0: battery %, byte 1: role, byte 2: etx_est (×10), rest reserved
typedef struct __attribute__((packed)) {
    uint8_t battery;
    uint8_t role;
    uint8_t etx_est_x10;
    uint8_t reserved[5];
} hello_payload_t;

// Neighbour table entry
typedef struct {
    uint8_t  id;
    uint8_t  mac[6];
    int8_t   rssi;
    float    ewma_rssi;
    int8_t   ewma_hist[3];          // last 3 EWMA values
    uint8_t  hist_idx;
    float    slope_hist[3];         // last 3 slopes (dB/s)
    uint8_t  slope_idx;
    float    pred_rssi;
    uint16_t sent_cnt;
    uint16_t ack_cnt;
    float    etx;
    float    ewma_etx;
    uint8_t  battery;
    uint8_t  hop_count;
    uint8_t  risk;                  // 0=low, 1=high
    uint32_t last_seen_ms;
} neighbor_t;

// Global state lives in mesh_node.ino (single-file firmware).
