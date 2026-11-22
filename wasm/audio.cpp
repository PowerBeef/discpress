/* Unified windowed audio decoder for Discpress AudioStore:
   - FLAC via linked libFLAC (BSD-3-Clause, bit-exact 16-bit LE stereo PCM)
   - WAV / RF64 (clean-room: PCM 8/16/24/32, IEEE float 32/64, WAVE_FORMAT_EXTENSIBLE 0xFFFE)
   - AIFF / AIFC (clean-room: 80-bit IEEE extended rate, NONE BE PCM, sowt LE PCM, fl32)
   - Ogg Vorbis via stb_vorbis.c (Public Domain / MIT)
   - MP3 via minimp3_ex.h (CC0-1.0 Public Domain, Xing/Info/VBRI/LAME gapless trim)
   Outputs 16-bit signed LE stereo 44,100 Hz PCM padded to 2,352-byte CD sectors.
   License: BSD-3-Clause (Discpress). */
#include <stdint.h>
#include <stddef.h>
#include <stdlib.h>
#include <stdio.h>
#include <string.h>
#include <math.h>
#include <vector>
#include <algorithm>

#include "FLAC/stream_decoder.h"

#define STB_VORBIS_HEADER_ONLY
#include "stb_vorbis.c"

#define MINIMP3_IMPLEMENTATION
#include "minimp3_ex.h"

static uint16_t r16le(const uint8_t *p) { return uint16_t(p[0]) | (uint16_t(p[1]) << 8); }
static uint32_t r32le(const uint8_t *p) { return uint32_t(p[0]) | (uint32_t(p[1]) << 8) | (uint32_t(p[2]) << 16) | (uint32_t(p[3]) << 24); }
static uint64_t r64le(const uint8_t *p) { return uint64_t(r32le(p)) | (uint64_t(r32le(p + 4)) << 32); }
static uint16_t r16be(const uint8_t *p) { return (uint16_t(p[0]) << 8) | uint16_t(p[1]); }
static uint32_t r32be(const uint8_t *p) { return (uint32_t(p[0]) << 24) | (uint32_t(p[1]) << 16) | (uint32_t(p[2]) << 8) | uint32_t(p[3]); }

static int16_t clamp16(int32_t v) { return v < -32768 ? -32768 : v > 32767 ? 32767 : int16_t(v); }
static int16_t f2s16(double f) {
    if (!(f == f)) return 0;
    if (f >= 1.0) return 32767;
    if (f <= -1.0) return -32768;
    double s = f * 32768.0;
    return clamp16(int32_t(s >= 0 ? s + 0.5 : s - 0.5));
}

static uint32_t parse_ieee80(const uint8_t b[10]) {
    int sign = b[0] >> 7;
    int exp = ((int(b[0] & 0x7F) << 8) | b[1]) - 16383;
    uint64_t man = 0;
    for (int i = 2; i < 10; i++) man = (man << 8) | b[i];
    if (exp == -16383 && man == 0) return 0;
    if (exp < 0 || exp > 30) return 0;
    double val = ldexp(double(man), exp - 63);
    if (sign) val = -val;
    return val > 0 ? uint32_t(val + 0.5) : 0;
}

enum AudFmt { AUD_NONE = 0, AUD_FLAC = 1, AUD_WAV = 2, AUD_AIFF = 3, AUD_OGG = 4, AUD_MP3 = 5 };

struct AudStream {
    AudFmt fmt = AUD_NONE;
    FILE *fp = nullptr;
    uint64_t fileSize = 0;

    uint32_t origRate = 44100;
    uint32_t origCh = 2;
    uint32_t origBits = 16;
    bool isLossy = false;
    uint64_t srcFrames = 0;     // frames at origRate
    uint64_t outFramesRaw = 0;  // frames at 44100 Hz before sector pad
    uint64_t outFramesPad = 0;  // rounded up to multiple of 588 (2352 bytes)

    // WAV / AIFF PCM layout
    uint64_t dataOffset = 0;
    uint64_t dataSize = 0;
    uint32_t blockAlign = 4;
    bool isFloat = false;
    bool isBigEndian = false;

    // FLAC decoder
    FLAC__StreamDecoder *flac = nullptr;
    uint64_t flacCurFrame = 0;
    std::vector<int16_t> flacBuf; // interleaved stereo at origRate
    uint64_t flacBufStart = 0;

    // Ogg Vorbis
    stb_vorbis *ogg = nullptr;
    uint64_t oggCurFrame = 0;

    // MP3
    mp3dec_ex_t mp3;
    mp3dec_io_t mp3Io;
    bool mp3Open = false;
    uint64_t mp3CurFrame = 0;

    ~AudStream() { close(); }
    void close() {
        if (flac) { FLAC__stream_decoder_delete(flac); flac = nullptr; }
        if (ogg) { stb_vorbis_close(ogg); ogg = nullptr; }
        if (mp3Open) { mp3dec_ex_close(&mp3); mp3Open = false; }
        if (fp) { fclose(fp); fp = nullptr; }
        flacBuf.clear();
        fmt = AUD_NONE;
    }
};

static const int MAX_AUD = 32;
static AudStream *g_aud[MAX_AUD] = {};

/* ---- FLAC callbacks ---- */
static FLAC__StreamDecoderReadStatus flac_read_cb(const FLAC__StreamDecoder *, FLAC__byte buf[], size_t *bytes, void *cd) {
    AudStream *s = (AudStream *)cd;
    if (*bytes == 0) return FLAC__STREAM_DECODER_READ_STATUS_ABORT;
    size_t got = fread(buf, 1, *bytes, s->fp);
    *bytes = got;
    if (got == 0) return feof(s->fp) ? FLAC__STREAM_DECODER_READ_STATUS_END_OF_STREAM : FLAC__STREAM_DECODER_READ_STATUS_ABORT;
    return FLAC__STREAM_DECODER_READ_STATUS_CONTINUE;
}
static FLAC__StreamDecoderSeekStatus flac_seek_cb(const FLAC__StreamDecoder *, FLAC__uint64 off, void *cd) {
    AudStream *s = (AudStream *)cd;
    return fseeko(s->fp, (off_t)off, SEEK_SET) == 0 ? FLAC__STREAM_DECODER_SEEK_STATUS_OK : FLAC__STREAM_DECODER_SEEK_STATUS_ERROR;
}
static FLAC__StreamDecoderTellStatus flac_tell_cb(const FLAC__StreamDecoder *, FLAC__uint64 *off, void *cd) {
    AudStream *s = (AudStream *)cd;
    off_t p = ftello(s->fp);
    if (p < 0) return FLAC__STREAM_DECODER_TELL_STATUS_ERROR;
    *off = (FLAC__uint64)p;
    return FLAC__STREAM_DECODER_TELL_STATUS_OK;
}
static FLAC__StreamDecoderLengthStatus flac_len_cb(const FLAC__StreamDecoder *, FLAC__uint64 *len, void *cd) {
    AudStream *s = (AudStream *)cd;
    *len = s->fileSize;
    return FLAC__STREAM_DECODER_LENGTH_STATUS_OK;
}
static FLAC__bool flac_eof_cb(const FLAC__StreamDecoder *, void *cd) {
    AudStream *s = (AudStream *)cd;
    return feof(s->fp) ? true : false;
}
static FLAC__StreamDecoderWriteStatus flac_write_cb(const FLAC__StreamDecoder *, const FLAC__Frame *frame, const FLAC__int32 *const buf[], void *cd) {
    AudStream *s = (AudStream *)cd;
    uint32_t n = frame->header.blocksize;
    uint32_t ch = frame->header.channels;
    uint32_t bps = frame->header.bits_per_sample;
    if (s->flacBuf.empty()) s->flacBufStart = frame->header.number.sample_number;
    size_t old = s->flacBuf.size();
    s->flacBuf.resize(old + size_t(n) * 2);
    int16_t *dst = s->flacBuf.data() + old;
    for (uint32_t i = 0; i < n; i++) {
        int32_t l = buf[0][i];
        int32_t r = (ch > 1) ? buf[1][i] : l;
        if (bps == 16) {
            dst[i * 2] = int16_t(l);
            dst[i * 2 + 1] = int16_t(r);
        } else if (bps < 16) {
            int sh = 16 - int(bps);
            dst[i * 2] = clamp16(l << sh);
            dst[i * 2 + 1] = clamp16(r << sh);
        } else {
            int sh = int(bps) - 16;
            dst[i * 2] = clamp16(l >> sh);
            dst[i * 2 + 1] = clamp16(r >> sh);
        }
    }
    return FLAC__STREAM_DECODER_WRITE_STATUS_CONTINUE;
}
static void flac_meta_cb(const FLAC__StreamDecoder *, const FLAC__StreamMetadata *meta, void *cd) {
    AudStream *s = (AudStream *)cd;
    if (meta->type == FLAC__METADATA_TYPE_STREAMINFO) {
        s->origRate = meta->data.stream_info.sample_rate;
        s->origCh = meta->data.stream_info.channels;
        s->origBits = meta->data.stream_info.bits_per_sample;
        s->srcFrames = meta->data.stream_info.total_samples;
    }
}
static void flac_err_cb(const FLAC__StreamDecoder *, FLAC__StreamDecoderErrorStatus, void *) {}

/* ---- MP3 callbacks ---- */
static size_t mp3_read_cb(void *buf, size_t size, void *ud) {
    AudStream *s = (AudStream *)ud;
    return fread(buf, 1, size, s->fp);
}
static int mp3_seek_cb(uint64_t pos, void *ud) {
    AudStream *s = (AudStream *)ud;
    return fseeko(s->fp, (off_t)pos, SEEK_SET);
}

/* ---- WAV / RF64 parser ---- */
static bool open_wav(AudStream *s) {
    uint8_t h[12];
    fseeko(s->fp, 0, SEEK_SET);
    if (fread(h, 1, 12, s->fp) != 12) return false;
    bool rf64 = (memcmp(h, "RF64", 4) == 0);
    if ((!rf64 && memcmp(h, "RIFF", 4) != 0) || memcmp(h + 8, "WAVE", 4) != 0) return false;

    uint64_t ds64Data = 0;
    bool gotFmt = false, gotData = false;
    uint64_t pos = 12;
    while (pos + 8 <= s->fileSize) {
        uint8_t ch[8];
        if (fseeko(s->fp, (off_t)pos, SEEK_SET) != 0 || fread(ch, 1, 8, s->fp) != 8) break;
        uint64_t csz = r32le(ch + 4);
        uint64_t body = pos + 8;
        if (memcmp(ch, "ds64", 4) == 0 && csz >= 24) {
            uint8_t d[24];
            if (fread(d, 1, 24, s->fp) == 24) ds64Data = r64le(d + 8);
        } else if (memcmp(ch, "fmt ", 4) == 0 && csz >= 16) {
            uint8_t fb[40];
            size_t rlen = csz < sizeof(fb) ? size_t(csz) : sizeof(fb);
            if (fread(fb, 1, rlen, s->fp) != rlen) return false;
            uint16_t tag = r16le(fb);
            s->origCh = r16le(fb + 2);
            s->origRate = r32le(fb + 4);
            s->blockAlign = r16le(fb + 12);
            s->origBits = r16le(fb + 14);
            if (tag == 0x0001) { s->isFloat = false; }
            else if (tag == 0x0003) { s->isFloat = true; }
            else if (tag == 0xFFFE && rlen >= 40) {
                uint16_t sub = r16le(fb + 24);
                static const uint8_t guidTail[14] = { 0x00,0x00,0x00,0x00,0x10,0x00,0x80,0x00,0x00,0xAA,0x00,0x38,0x9B,0x71 };
                if (memcmp(fb + 26, guidTail, 14) != 0) return false;
                if (sub == 0x0001) s->isFloat = false;
                else if (sub == 0x0003) s->isFloat = true;
                else return false;
            } else return false;
            gotFmt = true;
        } else if (memcmp(ch, "data", 4) == 0) {
            if (rf64 && csz == 0xFFFFFFFFU && ds64Data) csz = ds64Data;
            s->dataOffset = body;
            s->dataSize = (body + csz <= s->fileSize) ? csz : (s->fileSize - body);
            gotData = true;
            if (gotFmt) break;
        }
        pos = body + csz + (csz & 1);
    }
    if (!gotFmt || !gotData || s->origCh < 1 || s->origCh > 8 || s->origRate < 8000 || s->origRate > 192000) return false;
    if (s->isFloat && s->origBits != 32 && s->origBits != 64) return false;
    if (!s->isFloat && s->origBits != 8 && s->origBits != 16 && s->origBits != 24 && s->origBits != 32) return false;
    if (s->blockAlign < s->origCh * (s->origBits / 8)) s->blockAlign = s->origCh * (s->origBits / 8);
    if (!s->blockAlign) return false;
    s->isBigEndian = false;
    s->srcFrames = s->dataSize / s->blockAlign;
    s->fmt = AUD_WAV;
    return true;
}

/* ---- AIFF / AIFC parser ---- */
static bool open_aiff(AudStream *s) {
    uint8_t h[12];
    fseeko(s->fp, 0, SEEK_SET);
    if (fread(h, 1, 12, s->fp) != 12) return false;
    if (memcmp(h, "FORM", 4) != 0) return false;
    bool aifc = (memcmp(h + 8, "AIFC", 4) == 0);
    if (!aifc && memcmp(h + 8, "AIFF", 4) != 0) return false;

    bool gotComm = false, gotSsnd = false;
    s->isBigEndian = true;
    s->isFloat = false;
    uint64_t pos = 12;
    while (pos + 8 <= s->fileSize) {
        uint8_t ch[8];
        if (fseeko(s->fp, (off_t)pos, SEEK_SET) != 0 || fread(ch, 1, 8, s->fp) != 8) break;
        uint64_t csz = r32be(ch + 4);
        uint64_t body = pos + 8;
        if (memcmp(ch, "COMM", 4) == 0 && csz >= 18) {
            uint8_t cb[26];
            size_t rlen = csz < sizeof(cb) ? size_t(csz) : sizeof(cb);
            if (fread(cb, 1, rlen, s->fp) != rlen) return false;
            s->origCh = r16be(cb);
            s->srcFrames = r32be(cb + 2);
            s->origBits = r16be(cb + 6);
            s->origRate = parse_ieee80(cb + 8);
            if (aifc && rlen >= 22) {
                if (memcmp(cb + 18, "NONE", 4) == 0 || memcmp(cb + 18, "twos", 4) == 0) { s->isBigEndian = true; s->isFloat = false; }
                else if (memcmp(cb + 18, "sowt", 4) == 0) { s->isBigEndian = false; s->isFloat = false; }
                else if (memcmp(cb + 18, "fl32", 4) == 0 || memcmp(cb + 18, "FL32", 4) == 0) { s->isBigEndian = true; s->isFloat = true; s->origBits = 32; }
                else return false;
            }
            gotComm = true;
        } else if (memcmp(ch, "SSND", 4) == 0 && csz >= 8) {
            uint8_t sb[8];
            if (fread(sb, 1, 8, s->fp) != 8) return false;
            uint32_t ssndOff = r32be(sb);
            s->dataOffset = body + 8 + ssndOff;
            s->dataSize = (csz > 8 + ssndOff) ? (csz - 8 - ssndOff) : 0;
            if (s->dataOffset + s->dataSize > s->fileSize) s->dataSize = s->fileSize > s->dataOffset ? s->fileSize - s->dataOffset : 0;
            gotSsnd = true;
            if (gotComm) break;
        }
        pos = body + csz + (csz & 1);
    }
    if (!gotComm || !gotSsnd || s->origCh < 1 || s->origCh > 8 || s->origRate < 8000 || s->origRate > 192000) return false;
    if (s->origBits != 8 && s->origBits != 16 && s->origBits != 24 && s->origBits != 32) return false;
    s->blockAlign = s->origCh * (s->origBits / 8);
    if (!s->blockAlign) return false;
    uint64_t avail = s->dataSize / s->blockAlign;
    if (!s->srcFrames || avail < s->srcFrames) s->srcFrames = avail;
    s->fmt = AUD_AIFF;
    return true;
}

/* ---- Read stereo int16 frames at source sample rate ---- */
static size_t read_src_pcm(AudStream *s, uint64_t framePos, int16_t *dst, size_t nFrames) {
    if (framePos >= s->srcFrames || nFrames == 0) return 0;
    if (framePos + nFrames > s->srcFrames) nFrames = size_t(s->srcFrames - framePos);

    if (s->fmt == AUD_WAV || s->fmt == AUD_AIFF) {
        size_t bpp = s->origBits / 8;
        size_t rawBytes = nFrames * s->blockAlign;
        if (fseeko(s->fp, (off_t)(s->dataOffset + framePos * s->blockAlign), SEEK_SET) != 0) return 0;
        // Fast path: 16-bit LE stereo WAV (Redump bit-exact!)
        if (!s->isFloat && !s->isBigEndian && s->origBits == 16 && s->origCh == 2 && s->blockAlign == 4) {
            size_t got = fread(dst, 4, nFrames, s->fp);
            return got;
        }
        std::vector<uint8_t> raw(rawBytes);
        size_t got = fread(raw.data(), s->blockAlign, nFrames, s->fp);
        auto decodeOne = [&](const uint8_t *p) -> int16_t {
            if (s->isFloat) {
                if (s->origBits == 32) {
                    uint32_t u = s->isBigEndian ? r32be(p) : r32le(p);
                    float f; memcpy(&f, &u, 4);
                    return f2s16(f);
                } else {
                    uint64_t u = r64le(p);
                    double d; memcpy(&d, &u, 8);
                    return f2s16(d);
                }
            }
            if (s->origBits == 8) {
                // WAV 8-bit is unsigned [0..255]; AIFF 8-bit is signed [-128..127]
                int v = (s->fmt == AUD_WAV) ? (int(p[0]) - 128) : int(int8_t(p[0]));
                return int16_t(v << 8);
            }
            if (s->origBits == 16) {
                return int16_t(s->isBigEndian ? r16be(p) : r16le(p));
            }
            if (s->origBits == 24) {
                int32_t v = s->isBigEndian
                    ? ((int32_t(int8_t(p[0])) << 16) | (int32_t(p[1]) << 8) | p[2])
                    : ((int32_t(int8_t(p[2])) << 16) | (int32_t(p[1]) << 8) | p[0]);
                return int16_t(v >> 8);
            }
            uint32_t u = s->isBigEndian ? r32be(p) : r32le(p);
            return int16_t(int32_t(u) >> 16);
        };
        for (size_t i = 0; i < got; i++) {
            const uint8_t *f = raw.data() + i * s->blockAlign;
            int16_t l = decodeOne(f);
            int16_t r = (s->origCh > 1) ? decodeOne(f + bpp) : l;
            dst[i * 2] = l;
            dst[i * 2 + 1] = r;
        }
        return got;
    }

    if (s->fmt == AUD_FLAC) {
        size_t done = 0;
        while (done < nFrames) {
            uint64_t want = framePos + done;
            uint64_t bufEnd = s->flacBufStart + (s->flacBuf.size() / 2);
            if (want >= s->flacBufStart && want < bufEnd) {
                size_t avail = size_t(bufEnd - want);
                size_t take = std::min(avail, nFrames - done);
                memcpy(dst + done * 2, s->flacBuf.data() + size_t(want - s->flacBufStart) * 2, take * 4);
                done += take;
                continue;
            }
            if (want < s->flacBufStart || want > bufEnd + 16384) {
                s->flacBuf.clear();
                s->flacBufStart = want;
                if (!FLAC__stream_decoder_seek_absolute(s->flac, want)) {
                    FLAC__stream_decoder_flush(s->flac);
                    break;
                }
            } else {
                s->flacBuf.clear();
                if (!FLAC__stream_decoder_process_single(s->flac)) break;
                if (s->flacBuf.empty()) {
                    auto st = FLAC__stream_decoder_get_state(s->flac);
                    if (st == FLAC__STREAM_DECODER_END_OF_STREAM || st == FLAC__STREAM_DECODER_ABORTED) break;
                }
            }
        }
        return done;
    }

    if (s->fmt == AUD_OGG) {
        if (framePos != s->oggCurFrame) {
            if (!stb_vorbis_seek(s->ogg, (unsigned int)framePos)) return 0;
            s->oggCurFrame = framePos;
        }
        size_t done = 0;
        while (done < nFrames) {
            int got = stb_vorbis_get_samples_short_interleaved(s->ogg, 2, dst + done * 2, int((nFrames - done) * 2));
            if (got <= 0) break;
            done += size_t(got);
            s->oggCurFrame += size_t(got);
        }
        return done;
    }

    if (s->fmt == AUD_MP3) {
        if (framePos != s->mp3CurFrame) {
            if (mp3dec_ex_seek(&s->mp3, framePos * s->origCh) != 0) return 0;
            s->mp3CurFrame = framePos;
        }
        if (s->origCh == 2) {
            size_t gotSamp = mp3dec_ex_read(&s->mp3, dst, nFrames * 2);
            size_t gotF = gotSamp / 2;
            s->mp3CurFrame += gotF;
            return gotF;
        } else {
            std::vector<mp3d_sample_t> mono(nFrames * s->origCh);
            size_t gotSamp = mp3dec_ex_read(&s->mp3, mono.data(), mono.size());
            size_t gotF = gotSamp / s->origCh;
            for (size_t i = 0; i < gotF; i++) {
                int16_t l = mono[i * s->origCh];
                int16_t r = (s->origCh > 1) ? mono[i * s->origCh + 1] : l;
                dst[i * 2] = l;
                dst[i * 2 + 1] = r;
            }
            s->mp3CurFrame += gotF;
            return gotF;
        }
    }
    return 0;
}

extern "C" {

int wasm_aud_open(const char *path, uint32_t *outInfo) {
    if (!path || !outInfo) return -1;
    int slot = -1;
    for (int i = 1; i < MAX_AUD; i++) if (!g_aud[i]) { slot = i; break; }
    if (slot < 0) return -1;

    FILE *fp = fopen(path, "rb");
    if (!fp) return -1;
    fseeko(fp, 0, SEEK_END);
    off_t fsz = ftello(fp);
    fseeko(fp, 0, SEEK_SET);
    if (fsz <= 12) { fclose(fp); return -1; }

    uint8_t head[16] = {};
    if (fread(head, 1, 16, fp) < 12) { fclose(fp); return -1; }
    fseeko(fp, 0, SEEK_SET);

    AudStream *s = new AudStream();
    s->fp = fp;
    s->fileSize = uint64_t(fsz);
    bool ok = false;

    if (memcmp(head, "fLaC", 4) == 0) {
        s->flac = FLAC__stream_decoder_new();
        if (s->flac && FLAC__stream_decoder_init_stream(s->flac, flac_read_cb, flac_seek_cb, flac_tell_cb, flac_len_cb, flac_eof_cb, flac_write_cb, flac_meta_cb, flac_err_cb, s) == FLAC__STREAM_DECODER_INIT_STATUS_OK) {
            if (FLAC__stream_decoder_process_until_end_of_metadata(s->flac) && s->origRate >= 8000 && s->origCh >= 1) {
                s->fmt = AUD_FLAC;
                ok = true;
            }
        }
    } else if ((memcmp(head, "RIFF", 4) == 0 || memcmp(head, "RF64", 4) == 0) && memcmp(head + 8, "WAVE", 4) == 0) {
        ok = open_wav(s);
    } else if (memcmp(head, "FORM", 4) == 0 && (memcmp(head + 8, "AIFF", 4) == 0 || memcmp(head + 8, "AIFC", 4) == 0)) {
        ok = open_aiff(s);
    } else if (memcmp(head, "OggS", 4) == 0) {
        int err = 0;
        s->ogg = stb_vorbis_open_file(fp, 0, &err, nullptr);
        if (s->ogg) {
            stb_vorbis_info vi = stb_vorbis_get_info(s->ogg);
            unsigned int len = stb_vorbis_stream_length_in_samples(s->ogg);
            if (vi.sample_rate >= 8000 && vi.channels >= 1 && len > 0) {
                s->origRate = uint32_t(vi.sample_rate);
                s->origCh = uint32_t(vi.channels);
                s->origBits = 16;
                s->srcFrames = len;
                s->isLossy = true;
                s->fmt = AUD_OGG;
                ok = true;
            }
        }
    } else {
        // Try MP3 (ID3 tag or MPEG frame sync)
        s->mp3Io.read = mp3_read_cb;
        s->mp3Io.read_data = s;
        s->mp3Io.seek = mp3_seek_cb;
        s->mp3Io.seek_data = s;
        if (mp3dec_ex_open_cb(&s->mp3, &s->mp3Io, MP3D_SEEK_TO_SAMPLE) == 0 && s->mp3.info.hz >= 8000 && s->mp3.info.channels >= 1 && s->mp3.samples > 0) {
            s->mp3Open = true;
            s->origRate = uint32_t(s->mp3.info.hz);
            s->origCh = uint32_t(s->mp3.info.channels);
            s->origBits = 16;
            s->srcFrames = s->mp3.samples / s->origCh;
            s->isLossy = true;
            s->fmt = AUD_MP3;
            ok = true;
        }
    }

    if (!ok || s->srcFrames == 0) {
        delete s;
        return -1;
    }

    if (s->origRate == 44100) s->outFramesRaw = s->srcFrames;
    else s->outFramesRaw = uint64_t(llround(double(s->srcFrames) * (44100.0 / double(s->origRate))));
    // Pad final partial Red Book sector (588 frames = 2,352 bytes) with silence
    s->outFramesPad = ((s->outFramesRaw + 587ULL) / 588ULL) * 588ULL;

    g_aud[slot] = s;
    outInfo[0] = uint32_t(s->fmt);
    outInfo[1] = uint32_t(s->outFramesPad & 0xFFFFFFFFU);
    outInfo[2] = uint32_t(s->outFramesPad >> 32);
    outInfo[3] = s->origRate;
    outInfo[4] = s->origCh;
    outInfo[5] = s->origBits;
    outInfo[6] = s->isLossy ? 1U : 0U;
    return slot;
}

int wasm_aud_read(int handle, uint32_t frameLo, uint32_t frameHi, uint8_t *dst, uint32_t wantBytes) {
    if (handle <= 0 || handle >= MAX_AUD || !g_aud[handle] || !dst) return -1;
    AudStream *s = g_aud[handle];
    uint64_t outPos = uint64_t(frameLo) | (uint64_t(frameHi) << 32);
    uint32_t wantFrames = wantBytes / 4;
    if (outPos >= s->outFramesPad || wantFrames == 0) return 0;
    if (outPos + wantFrames > s->outFramesPad) wantFrames = uint32_t(s->outFramesPad - outPos);

    int16_t *out16 = (int16_t *)dst;
    uint32_t active = (outPos < s->outFramesRaw) ? uint32_t(std::min<uint64_t>(wantFrames, s->outFramesRaw - outPos)) : 0;
    if (active > 0) {
        if (s->origRate == 44100) {
            size_t got = read_src_pcm(s, outPos, out16, active);
            if (got < active) memset(out16 + got * 2, 0, (active - got) * 4);
        } else {
            // Deterministic 4-tap Catmull-Rom resampling from origRate -> 44100 Hz
            double ratio = double(s->origRate) / 44100.0;
            double firstPos = double(outPos) * ratio;
            double lastPos = double(outPos + active - 1) * ratio;
            int64_t baseIdx = std::max<int64_t>(0, int64_t(floor(firstPos)) - 1);
            int64_t endIdx = std::min<int64_t>(int64_t(s->srcFrames), int64_t(ceil(lastPos)) + 3);
            size_t needSrc = endIdx > baseIdx ? size_t(endIdx - baseIdx) : 0;
            std::vector<int16_t> sb(needSrc * 2, 0);
            if (needSrc > 0) read_src_pcm(s, uint64_t(baseIdx), sb.data(), needSrc);
            auto samp = [&](int64_t idx, int ch) -> double {
                int64_t rel = idx - baseIdx;
                if (rel < 0) rel = 0;
                if (rel >= int64_t(needSrc)) rel = int64_t(needSrc) - 1;
                return needSrc ? double(sb[size_t(rel) * 2 + ch]) : 0.0;
            };
            for (uint32_t i = 0; i < active; i++) {
                double p = double(outPos + i) * ratio;
                int64_t i1 = int64_t(floor(p));
                double t = p - double(i1), t2 = t * t, t3 = t2 * t;
                for (int ch = 0; ch < 2; ch++) {
                    double y0 = samp(i1 - 1, ch), y1 = samp(i1, ch), y2 = samp(i1 + 1, ch), y3 = samp(i1 + 2, ch);
                    double v = 0.5 * ((2.0 * y1) + (-y0 + y2) * t + (2.0 * y0 - 5.0 * y1 + 4.0 * y2 - y3) * t2 + (-y0 + 3.0 * y1 - 3.0 * y2 + y3) * t3);
                    out16[i * 2 + ch] = clamp16(int32_t(v >= 0 ? v + 0.5 : v - 0.5));
                }
            }
        }
    }
    if (wantFrames > active) {
        memset(out16 + active * 2, 0, size_t(wantFrames - active) * 4);
    }
    return int(wantFrames * 4);
}

void wasm_aud_close(int handle) {
    if (handle > 0 && handle < MAX_AUD && g_aud[handle]) {
        delete g_aud[handle];
        g_aud[handle] = nullptr;
    }
}

} // extern "C"
