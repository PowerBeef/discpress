/* Streaming .7z archive unpacker built on Public Domain LZMA SDK 23.01 (engine/mame/3rdparty/lzma/C/).
   Uses SzArEx_Open() for archive metadata, then streams folder payloads in 2 MiB chunks via
   Lzma2Dec_DecodeToBuf / LzmaDec_DecodeToBuf / zlib / Copy (+ stateful Bra/Delta filters) directly
   to JS/OPFS via wasm_7z_write() so multi-GB solid .7z archives never OOM WASM heap.
   License: BSD-3-Clause (Discpress). */
#include <stdint.h>
#include <stdlib.h>
#include <stdio.h>
#include <string.h>
#include "7z.h"
#include "7zCrc.h"
#include "LzmaDec.h"
#include "Lzma2Dec.h"
#include "Bra.h"
#include "Delta.h"
#include "zlib.h"

#ifdef __EMSCRIPTEN__
extern int wasm_7z_write(uint32_t fileIdx, const uint8_t *ptr, uint32_t len);
#else
static int wasm_7z_write(uint32_t fileIdx, const uint8_t *ptr, uint32_t len) {
    (void)fileIdx; (void)ptr; (void)len; return 0;
}
#endif

#define k_Copy      0x0
#define k_Delta     0x3
#define k_LZMA2     0x21
#define k_LZMA      0x30101
#define k_Deflate   0x40108
#define k_AES       0x6F10701
#define k_BCJ       0x3030103
#define k_PPC       0x3030205
#define k_IA64      0x3030401
#define k_ARM       0x3030501
#define k_ARMT      0x3030701
#define k_SPARC     0x3030805
#define k_ARM64     0xa

static void *sz_alloc_fn(ISzAllocPtr p, size_t size) { (void)p; return size ? malloc(size) : NULL; }
static void sz_free_fn(ISzAllocPtr p, void *addr) { (void)p; free(addr); }
static const ISzAlloc g_sz_alloc = { sz_alloc_fn, sz_free_fn };

typedef struct {
    ISeekInStream vt;
    FILE *fp;
} CFileSeekStream;

static SRes file_read(ISeekInStreamPtr pp, void *buf, size_t *size) {
    CFileSeekStream *p = (CFileSeekStream *)pp;
    size_t want = *size;
    if (!want) return SZ_OK;
    size_t got = fread(buf, 1, want, p->fp);
    *size = got;
    return (got == 0 && ferror(p->fp)) ? SZ_ERROR_READ : SZ_OK;
}

static SRes file_seek(ISeekInStreamPtr pp, Int64 *pos, ESzSeek origin) {
    CFileSeekStream *p = (CFileSeekStream *)pp;
    int w = (origin == SZ_SEEK_SET) ? SEEK_SET : (origin == SZ_SEEK_CUR) ? SEEK_CUR : SEEK_END;
    if (fseeko(p->fp, (off_t)*pos, w) != 0) return SZ_ERROR_READ;
    off_t cur = ftello(p->fp);
    if (cur < 0) return SZ_ERROR_READ;
    *pos = (Int64)cur;
    return SZ_OK;
}

static int g_crc_ready = 0;
static int g_open = 0;
static CFileSeekStream g_in;
static CLookToRead2 g_look;
static Byte *g_look_buf = NULL;
static CSzArEx g_db;

void wasm_7z_close(void) {
    if (g_open) {
        SzArEx_Free(&g_db, &g_sz_alloc);
        if (g_in.fp) { fclose(g_in.fp); g_in.fp = NULL; }
        free(g_look_buf); g_look_buf = NULL;
        g_open = 0;
    }
}

static uint32_t coder_dic_size(const CSzCoderInfo *c, const Byte *codersData) {
    const Byte *props = codersData + c->PropsOffset;
    if (c->MethodID == k_LZMA2 && c->PropsSize >= 1) {
        Byte p = props[0];
        if (p > 40) return 0xFFFFFFFFU;
        if (p == 40) return 0xFFFFFFFFU;
        return (2U | (p & 1U)) << ((p / 2U) + 11U);
    }
    if (c->MethodID == k_LZMA && c->PropsSize >= 5) {
        return (uint32_t)props[1] | ((uint32_t)props[2] << 8) | ((uint32_t)props[3] << 16) | ((uint32_t)props[4] << 24);
    }
    return 0;
}

/* Open a .7z archive at path. Returns file count (>=0), or negative error:
   -1 open failed, -2 encrypted, -3 corrupt/not 7z, -4 unsupported/OOM. */
int wasm_7z_open(const char *path) {
    wasm_7z_close();
    if (!g_crc_ready) { CrcGenerateTable(); g_crc_ready = 1; }
    FILE *fp = fopen(path, "rb");
    if (!fp) return -1;
    g_look_buf = (Byte *)malloc(1 << 18);
    if (!g_look_buf) { fclose(fp); return -4; }
    g_in.vt.Read = file_read;
    g_in.vt.Seek = file_seek;
    g_in.fp = fp;
    LookToRead2_CreateVTable(&g_look, False);
    g_look.buf = g_look_buf;
    g_look.bufSize = 1 << 18;
    g_look.realStream = &g_in.vt;
    LookToRead2_INIT(&g_look);
    SzArEx_Init(&g_db);
    SRes res = SzArEx_Open(&g_db, &g_look.vt, &g_sz_alloc, &g_sz_alloc);
    if (res != SZ_OK) {
        SzArEx_Free(&g_db, &g_sz_alloc);
        fclose(fp); g_in.fp = NULL;
        free(g_look_buf); g_look_buf = NULL;
        if (res == SZ_ERROR_UNSUPPORTED) return -2;
        if (res == SZ_ERROR_MEM) return -4;
        return -3;
    }
    g_open = 1;
    return (int)g_db.NumFiles;
}

static uint32_t utf16_to_utf8(const UInt16 *src, size_t n16, char *dst, uint32_t cap) {
    uint32_t o = 0;
    for (size_t i = 0; i < n16 && src[i] != 0; i++) {
        uint32_t cp = src[i];
        if (cp >= 0xD800 && cp <= 0xDBFF && i + 1 < n16 && src[i + 1] >= 0xDC00 && src[i + 1] <= 0xDFFF) {
            cp = 0x10000 + (((cp - 0xD800) << 10) | (src[++i] - 0xDC00));
        }
        if (cp < 0x80) {
            if (o + 1 >= cap) break;
            dst[o++] = (char)cp;
        } else if (cp < 0x800) {
            if (o + 2 >= cap) break;
            dst[o++] = (char)(0xC0 | (cp >> 6));
            dst[o++] = (char)(0x80 | (cp & 0x3F));
        } else if (cp < 0x10000) {
            if (o + 3 >= cap) break;
            dst[o++] = (char)(0xE0 | (cp >> 12));
            dst[o++] = (char)(0x80 | ((cp >> 6) & 0x3F));
            dst[o++] = (char)(0x80 | (cp & 0x3F));
        } else {
            if (o + 4 >= cap) break;
            dst[o++] = (char)(0xF0 | (cp >> 18));
            dst[o++] = (char)(0x80 | ((cp >> 12) & 0x3F));
            dst[o++] = (char)(0x80 | ((cp >> 6) & 0x3F));
            dst[o++] = (char)(0x80 | (cp & 0x3F));
        }
    }
    if (cap) dst[o] = 0;
    return o;
}

/* Query metadata for file index idx.
   outMeta[0..7] = [sizeLo, sizeHi, crc, folderIdx(or 0xFFFFFFFF), isDir, hasCrc, dicSize, encrypted]. */
int wasm_7z_info(uint32_t idx, char *nameBuf, uint32_t nameCap, uint32_t *outMeta) {
    if (!g_open || idx >= g_db.NumFiles) return -1;
    size_t len16 = SzArEx_GetFileNameUtf16(&g_db, idx, NULL);
    UInt16 *u16 = (UInt16 *)malloc(len16 * sizeof(UInt16));
    if (!u16) return -1;
    SzArEx_GetFileNameUtf16(&g_db, idx, u16);
    uint32_t n8 = utf16_to_utf8(u16, len16, nameBuf, nameCap);
    free(u16);

    uint64_t fsz = SzArEx_GetFileSize(&g_db, idx);
    uint32_t fidx = g_db.FileToFolder[idx];
    uint32_t dic = 0, enc = 0;
    if (fidx != (uint32_t)-1 && fidx < g_db.db.NumFolders) {
        CSzFolder f;
        CSzData sd;
        sd.Data = g_db.db.CodersData + g_db.db.FoCodersOffsets[fidx];
        sd.Size = g_db.db.FoCodersOffsets[fidx + 1] - g_db.db.FoCodersOffsets[fidx];
        if (SzGetNextFolderItem(&f, &sd) == SZ_OK) {
            for (UInt32 ci = 0; ci < f.NumCoders; ci++) {
                if (f.Coders[ci].MethodID == k_AES) enc = 1;
                uint32_t d = coder_dic_size(&f.Coders[ci], g_db.db.CodersData + g_db.db.FoCodersOffsets[fidx]);
                if (d > dic) dic = d;
            }
        }
    }
    outMeta[0] = (uint32_t)(fsz & 0xFFFFFFFFU);
    outMeta[1] = (uint32_t)(fsz >> 32);
    outMeta[2] = SzBitWithVals_Check(&g_db.CRCs, idx) ? g_db.CRCs.Vals[idx] : 0;
    outMeta[3] = fidx;
    outMeta[4] = SzArEx_IsDir(&g_db, idx) ? 1U : 0U;
    outMeta[5] = SzBitWithVals_Check(&g_db.CRCs, idx) ? 1U : 0U;
    outMeta[6] = dic;
    outMeta[7] = enc;
    return (int)n8;
}

typedef struct {
    uint32_t firstFile;
    uint32_t endFile;
    uint32_t curFile;
    uint64_t folderBase;
    uint64_t curPos;
    int err;
} DemuxCtx;

static int demux_emit(DemuxCtx *d, const uint8_t *buf, size_t len) {
    size_t off = 0;
    while (off < len && d->curFile < d->endFile) {
        uint64_t fStart = g_db.UnpackPositions[d->curFile] - d->folderBase;
        uint64_t fEnd = g_db.UnpackPositions[d->curFile + 1] - d->folderBase;
        if (d->curPos >= fEnd) { d->curFile++; continue; }
        if (d->curPos < fStart) {
            uint64_t skip = fStart - d->curPos;
            size_t step = (skip < (uint64_t)(len - off)) ? (size_t)skip : (len - off);
            off += step; d->curPos += step;
            continue;
        }
        uint64_t rem = fEnd - d->curPos;
        size_t take = (rem < (uint64_t)(len - off)) ? (size_t)rem : (len - off);
        if (take > 0 && !SzArEx_IsDir(&g_db, d->curFile)) {
            if (wasm_7z_write(d->curFile, buf + off, (uint32_t)take) != 0) {
                d->err = -5;
                return -5;
            }
        }
        off += take;
        d->curPos += take;
        if (d->curPos >= fEnd) d->curFile++;
    }
    return 0;
}

typedef struct {
    uint32_t method;
    uint32_t pc;
    uint32_t x86State;
    Byte deltaState[DELTA_STATE_SIZE];
    unsigned deltaDist;
    uint8_t carry[16];
    size_t carryLen;
} FilterCtx;

static void filter_init(FilterCtx *fl, const CSzCoderInfo *c, const Byte *codersBase) {
    memset(fl, 0, sizeof(*fl));
    fl->method = c ? c->MethodID : 0;
    fl->x86State = Z7_BRANCH_CONV_ST_X86_STATE_INIT_VAL;
    if (c && c->MethodID == k_Delta) {
        fl->deltaDist = (c->PropsSize >= 1) ? ((unsigned)codersBase[c->PropsOffset] + 1U) : 1U;
        Delta_Init(fl->deltaState);
    } else if (c && c->MethodID == k_ARM64 && c->PropsSize == 4) {
        const Byte *p = codersBase + c->PropsOffset;
        fl->pc = (uint32_t)p[0] | ((uint32_t)p[1] << 8) | ((uint32_t)p[2] << 16) | ((uint32_t)p[3] << 24);
    }
}

static int filter_emit(FilterCtx *fl, DemuxCtx *dm, uint8_t *buf, size_t len, int finish) {
    if (!fl->method) return demux_emit(dm, buf, len);
    if (fl->method == k_Delta) {
        if (len) Delta_Decode(fl->deltaState, fl->deltaDist, buf, len);
        return demux_emit(dm, buf, len);
    }
    /* Branch converters require preserving 0..15 trailing unprocessed lookahead bytes across chunks */
    uint8_t *work = buf;
    size_t total = len;
    uint8_t *tmp = NULL;
    if (fl->carryLen > 0) {
        tmp = (uint8_t *)malloc(fl->carryLen + len);
        if (!tmp) return -4;
        memcpy(tmp, fl->carry, fl->carryLen);
        if (len) memcpy(tmp + fl->carryLen, buf, len);
        work = tmp;
        total = fl->carryLen + len;
        fl->carryLen = 0;
    }
    Byte *endPtr = work;
    if (total > 0) {
        switch (fl->method) {
            case k_BCJ:   endPtr = z7_BranchConvSt_X86_Dec(work, total, fl->pc, &fl->x86State); break;
            case k_ARM:   endPtr = z7_BranchConv_ARM_Dec(work, total, fl->pc); break;
            case k_ARM64: endPtr = z7_BranchConv_ARM64_Dec(work, total, fl->pc); break;
            case k_ARMT:  endPtr = z7_BranchConv_ARMT_Dec(work, total, fl->pc); break;
            case k_PPC:   endPtr = z7_BranchConv_PPC_Dec(work, total, fl->pc); break;
            case k_SPARC: endPtr = z7_BranchConv_SPARC_Dec(work, total, fl->pc); break;
            case k_IA64:  endPtr = z7_BranchConv_IA64_Dec(work, total, fl->pc); break;
            default:      endPtr = work + total; break;
        }
    }
    size_t done = (size_t)(endPtr - work);
    fl->pc += (uint32_t)done;
    int rc = 0;
    if (done > 0) rc = demux_emit(dm, work, done);
    size_t left = total - done;
    if (rc == 0 && left > 0) {
        if (finish) {
            rc = demux_emit(dm, work + done, left);
        } else if (left <= sizeof(fl->carry)) {
            memcpy(fl->carry, work + done, left);
            fl->carryLen = left;
        } else {
            rc = demux_emit(dm, work + done, left);
        }
    }
    free(tmp);
    return rc;
}

/* Stream-extract all files belonging to folderIdx, calling wasm_7z_write() in <=2 MiB slices.
   Returns 0 on success, -2 encrypted, -3 corrupt, -4 unsupported/OOM/dic-too-large, -5 write error. */
int wasm_7z_extract_folder(uint32_t folderIdx, uint32_t maxDicBytes) {
    if (!g_open || folderIdx >= g_db.db.NumFolders) return -3;
    CSzFolder f;
    CSzData sd;
    const Byte *codersBase = g_db.db.CodersData + g_db.db.FoCodersOffsets[folderIdx];
    sd.Data = codersBase;
    sd.Size = g_db.db.FoCodersOffsets[folderIdx + 1] - g_db.db.FoCodersOffsets[folderIdx];
    if (SzGetNextFolderItem(&f, &sd) != SZ_OK) return -3;

    for (UInt32 ci = 0; ci < f.NumCoders; ci++) {
        if (f.Coders[ci].MethodID == k_AES) return -2;
        uint32_t dic = coder_dic_size(&f.Coders[ci], codersBase);
        if (maxDicBytes && dic > maxDicBytes) return -4;
    }

    uint64_t unpackSize = SzAr_GetFolderUnpackSize(&g_db.db, folderIdx);
    uint32_t ps0 = g_db.db.FoStartPackStreamIndex[folderIdx];
    uint32_t ps1 = g_db.db.FoStartPackStreamIndex[folderIdx + 1];
    if (ps1 < ps0 || ps1 > g_db.db.NumPackStreams) return -3;
    uint64_t packSize = g_db.db.PackPositions[ps1] - g_db.db.PackPositions[ps0];

    DemuxCtx dm;
    dm.firstFile = g_db.FolderToFile[folderIdx];
    dm.endFile = g_db.FolderToFile[folderIdx + 1];
    dm.curFile = dm.firstFile;
    dm.folderBase = g_db.UnpackPositions[dm.firstFile];
    dm.curPos = 0;
    dm.err = 0;

    /* Identify streaming pipeline: 1 main coder, or 2 coders (main coder -> filter) */
    const CSzCoderInfo *mainCoder = NULL;
    const CSzCoderInfo *filtCoder = NULL;
    int canStream = 0;
    if (f.NumCoders == 1 && f.NumPackStreams == 1 && f.PackStreams[0] == 0 && f.NumBonds == 0) {
        mainCoder = &f.Coders[0];
        canStream = (mainCoder->MethodID == k_Copy || mainCoder->MethodID == k_LZMA ||
                     mainCoder->MethodID == k_LZMA2 || mainCoder->MethodID == k_Deflate);
    } else if (f.NumCoders == 2 && f.NumBonds == 1 && f.NumPackStreams == 1) {
        UInt32 filtIdx = f.UnpackStream;
        UInt32 mainIdx = (filtIdx == 0) ? 1 : 0;
        if (f.PackStreams[0] == mainIdx && f.Bonds[0].InIndex == filtIdx && f.Bonds[0].OutIndex == mainIdx) {
            mainCoder = &f.Coders[mainIdx];
            filtCoder = &f.Coders[filtIdx];
            int mainOk = (mainCoder->MethodID == k_Copy || mainCoder->MethodID == k_LZMA ||
                          mainCoder->MethodID == k_LZMA2 || mainCoder->MethodID == k_Deflate);
            int filtOk = (filtCoder->MethodID == k_BCJ || filtCoder->MethodID == k_ARM ||
                          filtCoder->MethodID == k_ARM64 || filtCoder->MethodID == k_ARMT ||
                          filtCoder->MethodID == k_PPC || filtCoder->MethodID == k_SPARC ||
                          filtCoder->MethodID == k_IA64 || filtCoder->MethodID == k_Delta);
            canStream = mainOk && filtOk;
        }
    }

    if (!canStream) {
        /* Fallback for BCJ2 / PPMd folders only when folder fits safely under 64 MiB */
        if (unpackSize > (64ULL << 20)) return -4;
        Byte *full = (Byte *)malloc((size_t)(unpackSize ? unpackSize : 1));
        if (!full) return -4;
        SRes r = SzAr_DecodeFolder(&g_db.db, folderIdx, &g_look.vt, g_db.dataPos, full, (size_t)unpackSize, &g_sz_alloc);
        int rc = (r == SZ_OK) ? demux_emit(&dm, full, (size_t)unpackSize) : -3;
        free(full);
        return rc;
    }

    if (ps0 >= g_db.db.NumPackStreams) return -3;
    uint64_t packStart = g_db.dataPos + g_db.db.PackPositions[ps0];
    if (fseeko(g_in.fp, (off_t)packStart, SEEK_SET) != 0) return -3;

    const size_t IN_CAP = 1 << 18;  /* 256 KiB read buffer */
    const size_t OUT_CAP = 2 << 20; /* 2 MiB output slice */
    uint8_t *inBuf = (uint8_t *)malloc(IN_CAP);
    uint8_t *outBuf = (uint8_t *)malloc(OUT_CAP);
    if (!inBuf || !outBuf) { free(inBuf); free(outBuf); return -4; }

    FilterCtx fl;
    filter_init(&fl, filtCoder, codersBase);

    int rc = 0;
    uint64_t packRem = packSize;
    uint64_t outRem = unpackSize;

    if (mainCoder->MethodID == k_Copy) {
        while (outRem > 0 && rc == 0) {
            size_t want = (outRem < OUT_CAP) ? (size_t)outRem : OUT_CAP;
            size_t got = fread(outBuf, 1, want, g_in.fp);
            if (got != want) { rc = -3; break; }
            outRem -= got;
            rc = filter_emit(&fl, &dm, outBuf, got, outRem == 0);
        }
    } else if (mainCoder->MethodID == k_Deflate) {
        z_stream zs;
        memset(&zs, 0, sizeof(zs));
        if (inflateInit2(&zs, -MAX_WBITS) != Z_OK) { rc = -4; }
        else {
            while (outRem > 0 && rc == 0) {
                if (zs.avail_in == 0 && packRem > 0) {
                    size_t rwant = (packRem < IN_CAP) ? (size_t)packRem : IN_CAP;
                    size_t rgot = fread(inBuf, 1, rwant, g_in.fp);
                    if (rgot == 0) { rc = -3; break; }
                    packRem -= rgot;
                    zs.next_in = inBuf;
                    zs.avail_in = (uInt)rgot;
                }
                zs.next_out = outBuf;
                zs.avail_out = (uInt)((outRem < OUT_CAP) ? outRem : OUT_CAP);
                int zr = inflate(&zs, Z_NO_FLUSH);
                size_t produced = (size_t)(((outRem < OUT_CAP) ? outRem : OUT_CAP) - zs.avail_out);
                if (produced > 0) {
                    outRem -= produced;
                    rc = filter_emit(&fl, &dm, outBuf, produced, outRem == 0);
                }
                if (zr == Z_STREAM_END) break;
                if (zr != Z_OK && zr != Z_BUF_ERROR) { rc = -3; break; }
                if (produced == 0 && zs.avail_in == 0 && packRem == 0) { rc = -3; break; }
            }
            inflateEnd(&zs);
        }
    } else if (mainCoder->MethodID == k_LZMA2) {
        CLzma2Dec dec;
        Lzma2Dec_Construct(&dec);
        const Byte *props = codersBase + mainCoder->PropsOffset;
        if (mainCoder->PropsSize < 1 || Lzma2Dec_Allocate(&dec, props[0], &g_sz_alloc) != SZ_OK) {
            rc = -4;
        } else {
            Lzma2Dec_Init(&dec);
            size_t inPos = 0, inSize = 0;
            while (outRem > 0 && rc == 0) {
                if (inPos == inSize && packRem > 0) {
                    size_t rwant = (packRem < IN_CAP) ? (size_t)packRem : IN_CAP;
                    inSize = fread(inBuf, 1, rwant, g_in.fp);
                    inPos = 0;
                    if (inSize == 0) { rc = -3; break; }
                    packRem -= inSize;
                }
                SizeT srcLen = inSize - inPos;
                SizeT dstLen = (outRem < OUT_CAP) ? (SizeT)outRem : (SizeT)OUT_CAP;
                ELzmaFinishMode fm = (dstLen == outRem) ? LZMA_FINISH_END : LZMA_FINISH_ANY;
                ELzmaStatus status;
                SRes sres = Lzma2Dec_DecodeToBuf(&dec, outBuf, &dstLen, inBuf + inPos, &srcLen, fm, &status);
                inPos += srcLen;
                if (dstLen > 0) {
                    outRem -= dstLen;
                    rc = filter_emit(&fl, &dm, outBuf, dstLen, outRem == 0);
                }
                if (sres != SZ_OK) { rc = -3; break; }
                if (status == LZMA_STATUS_FINISHED_WITH_MARK) break;
                if (srcLen == 0 && dstLen == 0) { rc = -3; break; }
            }
            Lzma2Dec_Free(&dec, &g_sz_alloc);
        }
    } else if (mainCoder->MethodID == k_LZMA) {
        CLzmaDec dec;
        LzmaDec_Construct(&dec);
        const Byte *props = codersBase + mainCoder->PropsOffset;
        if (mainCoder->PropsSize < LZMA_PROPS_SIZE || LzmaDec_Allocate(&dec, props, LZMA_PROPS_SIZE, &g_sz_alloc) != SZ_OK) {
            rc = -4;
        } else {
            LzmaDec_Init(&dec);
            size_t inPos = 0, inSize = 0;
            while (outRem > 0 && rc == 0) {
                if (inPos == inSize && packRem > 0) {
                    size_t rwant = (packRem < IN_CAP) ? (size_t)packRem : IN_CAP;
                    inSize = fread(inBuf, 1, rwant, g_in.fp);
                    inPos = 0;
                    if (inSize == 0) { rc = -3; break; }
                    packRem -= inSize;
                }
                SizeT srcLen = inSize - inPos;
                SizeT dstLen = (outRem < OUT_CAP) ? (SizeT)outRem : (SizeT)OUT_CAP;
                ELzmaFinishMode fm = (dstLen == outRem) ? LZMA_FINISH_END : LZMA_FINISH_ANY;
                ELzmaStatus status;
                SRes sres = LzmaDec_DecodeToBuf(&dec, outBuf, &dstLen, inBuf + inPos, &srcLen, fm, &status);
                inPos += srcLen;
                if (dstLen > 0) {
                    outRem -= dstLen;
                    rc = filter_emit(&fl, &dm, outBuf, dstLen, outRem == 0);
                }
                if (sres != SZ_OK) { rc = -3; break; }
                if (status == LZMA_STATUS_FINISHED_WITH_MARK) break;
                if (srcLen == 0 && dstLen == 0) { rc = -3; break; }
            }
            LzmaDec_Free(&dec, &g_sz_alloc);
        }
    }

    if (rc == 0 && outRem != 0) rc = -3;
    free(inBuf);
    free(outBuf);
    return rc;
}
