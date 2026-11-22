/* Clean-room LZ4 raw block compressor & libdeflate raw-deflate wrapper for CSO v1/v2 and ZSO (--block=2048).
   License: BSD-3-Clause (Discpress). */
#include <stdint.h>
#include <stddef.h>
#include <string.h>
#include "libdeflate.h"

static uint32_t lz4_r32(const uint8_t *p) {
    uint32_t v;
    memcpy(&v, p, 4);
    return v;
}

static uint32_t lz4_hash(uint32_t v) {
    return (v * 2654435761U) >> (32 - 12);
}

/* Compress src[0..srcLen) into raw LZ4 block format (no frame header) in dst[0..dstCap).
   Returns compressed byte count (>0) on success, or 0 if incompressible / exceeds dstCap. */
int wasm_lz4_compress_block(const uint8_t *src, int srcLen, uint8_t *dst, int dstCap) {
    if (!src || !dst || srcLen <= 0 || dstCap <= 0) return 0;
    const uint8_t *ip = src;
    const uint8_t *anchor = src;
    const uint8_t *const iend = src + srcLen;
    const uint8_t *const mflimit = (srcLen >= 12) ? (iend - 12) : src;
    const uint8_t *const matchlimit = (srcLen >= 5) ? (iend - 5) : src;
    uint8_t *op = dst;
    uint8_t *const oend = dst + dstCap;

    uint16_t table[4096];
    memset(table, 0, sizeof(table));

    if (srcLen >= 13) {
        table[lz4_hash(lz4_r32(ip))] = 0;
        ip++;
        while (ip < mflimit) {
            uint32_t h = lz4_hash(lz4_r32(ip));
            const uint8_t *ref = src + table[h];
            table[h] = (uint16_t)(ip - src);

            if (ref >= ip || (ip - ref) > 65535 || lz4_r32(ref) != lz4_r32(ip)) {
                ip++;
                continue;
            }

            /* Found >= 4-byte match */
            int litLen = (int)(ip - anchor);
            if (op + 1 + litLen + (litLen / 255) + 3 > oend) return 0;
            uint8_t *tok = op++;
            if (litLen >= 15) {
                *tok = 0xF0;
                int rem = litLen - 15;
                while (rem >= 255) {
                    if (op >= oend) return 0;
                    *op++ = 255;
                    rem -= 255;
                }
                if (op >= oend) return 0;
                *op++ = (uint8_t)rem;
            } else {
                *tok = (uint8_t)(litLen << 4);
            }
            if (op + litLen + 2 > oend) return 0;
            if (litLen) {
                memcpy(op, anchor, (size_t)litLen);
                op += litLen;
            }

            uint16_t off = (uint16_t)(ip - ref);
            *op++ = (uint8_t)(off & 0xFF);
            *op++ = (uint8_t)(off >> 8);

            ip += 4;
            ref += 4;
            const uint8_t *mstart = ip;
            while (ip < matchlimit && *ip == *ref) { ip++; ref++; }
            int mlen = (int)(ip - mstart); /* match_len - 4 */
            if (mlen >= 15) {
                *tok |= 0x0F;
                int rem = mlen - 15;
                while (rem >= 255) {
                    if (op >= oend) return 0;
                    *op++ = 255;
                    rem -= 255;
                }
                if (op >= oend) return 0;
                *op++ = (uint8_t)rem;
            } else {
                *tok |= (uint8_t)mlen;
            }

            anchor = ip;
            if (ip < mflimit) {
                table[lz4_hash(lz4_r32(ip - 2))] = (uint16_t)((ip - 2) - src);
            }
        }
    }

    /* Emit final literal run */
    int lastLit = (int)(iend - anchor);
    if (op + 1 + (lastLit / 255) + 1 + lastLit > oend) return 0;
    if (lastLit >= 15) {
        *op++ = 0xF0;
        int rem = lastLit - 15;
        while (rem >= 255) { *op++ = 255; rem -= 255; }
        *op++ = (uint8_t)rem;
    } else {
        *op++ = (uint8_t)(lastLit << 4);
    }
    if (lastLit) {
        memcpy(op, anchor, (size_t)lastLit);
        op += lastLit;
    }
    return (int)(op - dst);
}

static struct libdeflate_compressor *g_ciso_comp = NULL;
static int g_ciso_level = -1;

/* Compress src[0..srcLen) into raw DEFLATE (-MAX_WBITS) using libdeflate.
   Returns compressed byte count (>0) on success, or 0 if it doesn't fit in dstCap. */
int wasm_deflate_raw(const uint8_t *src, int srcLen, uint8_t *dst, int dstCap, int level) {
    if (!src || !dst || srcLen <= 0 || dstCap <= 0) return 0;
    if (level < 1) level = 6;
    if (level > 12) level = 12;
    if (!g_ciso_comp || g_ciso_level != level) {
        if (g_ciso_comp) libdeflate_free_compressor(g_ciso_comp);
        g_ciso_comp = libdeflate_alloc_compressor(level);
        g_ciso_level = level;
    }
    if (!g_ciso_comp) return 0;
    size_t n = libdeflate_deflate_compress(g_ciso_comp, src, (size_t)srcLen, dst, (size_t)dstCap);
    return (n > 0 && n <= (size_t)dstCap) ? (int)n : 0;
}
