/*
 * cosf and log for libFLAC, identical in every Discpress build (see README.md).
 *
 * From Arm's optimized-routines, commit 47597821aaa52e9c055caf1ecf8f3aecfd751cd9
 * (math/cosf.c, math/sincosf.h, math/sincosf_data.c, math/log.c, math/log_data.c),
 * the code glibc's cosf and log are built from.
 * Copyright (c) 2018-2024, Arm Limited.
 * SPDX-License-Identifier: MIT OR Apache-2.0 WITH LLVM-exception (used here under MIT, see LICENSE)
 *
 * Changes: one file, renamed functions, the configuration fixed (TOINT_INTRINSICS 0, a
 * 128-entry log table), unused paths removed, and in log the multiply-adds that GCC fuses when
 * glibc is built for x86-64 with FMA written as fma() calls. Build with -ffp-contract=off.
 */

#include "flac_libm.h"

#include <math.h>
#include <stdint.h>
#include <string.h>

static inline uint32_t asuint(float f) { uint32_t i; memcpy(&i, &f, sizeof(i)); return i; }
static inline uint64_t asuint64(double f) { uint64_t i; memcpy(&i, &f, sizeof(i)); return i; }
static inline double asdouble(uint64_t i) { double f; memcpy(&f, &i, sizeof(f)); return f; }


/* ---------------------------------------------------------------- cosf */

/* 2PI * 2^-64.  */
static const double pi63 = 0x1.921FB54442D18p-62;
/* PI / 4.  */
static const float pio4f = 0x1.921FB6p-1f;

/* The constants and polynomials for sine and cosine.  */
typedef struct
{
  double sign[4];		/* Sign of sine in quadrants 0..3.  */
  double hpi_inv;		/* 2 / PI * 2^24.  */
  double hpi;			/* PI / 2.  */
  double c0, c1, c2, c3, c4;	/* Cosine polynomial.  */
  double s1, s2, s3;		/* Sine polynomial.  */
} sincos_t;

/* The 2nd entry computes -cos (x) rather than cos (x) to get negation for free.  */
static const sincos_t sincosf_table[2] =
{
  {
    { 1.0, -1.0, -1.0, 1.0 },
    0x1.45F306DC9C883p+23,
    0x1.921FB54442D18p0,
    0x1p0,
    -0x1.ffffffd0c621cp-2,
    0x1.55553e1068f19p-5,
    -0x1.6c087e89a359dp-10,
    0x1.99343027bf8c3p-16,
    -0x1.555545995a603p-3,
    0x1.1107605230bc4p-7,
    -0x1.994eb3774cf24p-13
  },
  {
    { 1.0, -1.0, -1.0, 1.0 },
    0x1.45F306DC9C883p+23,
    0x1.921FB54442D18p0,
    -0x1p0,
    0x1.ffffffd0c621cp-2,
    -0x1.55553e1068f19p-5,
    0x1.6c087e89a359dp-10,
    -0x1.99343027bf8c3p-16,
    -0x1.555545995a603p-3,
    0x1.1107605230bc4p-7,
    -0x1.994eb3774cf24p-13
  }
};

/* Table with 4/PI to 192 bit precision.  To avoid unaligned accesses
   only 8 new bits are added per entry, making the table 4 times larger.  */
static const uint32_t inv_pio4[24] =
{
  0xa2,       0xa2f9,	  0xa2f983,   0xa2f9836e,
  0xf9836e4e, 0x836e4e44, 0x6e4e4415, 0x4e441529,
  0x441529fc, 0x1529fc27, 0x29fc2757, 0xfc2757d1,
  0x2757d1f5, 0x57d1f534, 0xd1f534dd, 0xf534ddc0,
  0x34ddc0db, 0xddc0db62, 0xc0db6295, 0xdb629599,
  0x6295993c, 0x95993c43, 0x993c4390, 0x3c439041
};

/* Top 12 bits of the float representation with the sign bit cleared.  */
static inline uint32_t
abstop12 (float x)
{
  return (asuint (x) >> 20) & 0x7ff;
}

/* Return the sine of inputs X and X2 (X squared) using the polynomial P.
   N is the quadrant, and if odd the cosine polynomial is used.  */
static inline float
sinf_poly (double x, double x2, const sincos_t *p, int n)
{
  double x3, x4, x6, x7, s, c, c1, c2, s1;

  if ((n & 1) == 0)
    {
      x3 = x * x2;
      s1 = p->s2 + x2 * p->s3;

      x7 = x3 * x2;
      s = x + x3 * p->s1;

      return s + x7 * s1;
    }
  else
    {
      x4 = x2 * x2;
      c2 = p->c3 + x2 * p->c4;
      c1 = p->c0 + x2 * p->c1;

      x6 = x4 * x2;
      c = c1 + x4 * p->c2;

      return c + x6 * c2;
    }
}

/* Fast range reduction using single multiply-subtract.  Return the modulo of
   X as a value between -PI/4 and PI/4 and store the quadrant in NP.
   The values for PI/2 and 2/PI are accessed via P.  Since PI/2 as a double
   is accurate to 55 bits and the worst-case cancellation happens at 6 * PI/4,
   the result is accurate for |X| <= 120.0.  */
static inline double
reduce_fast (double x, const sincos_t *p, int *np)
{
  double r;
  /* Use scaled float to int conversion with explicit rounding.
     hpi_inv is prescaled by 2^24 so the quadrant ends up in bits 24..31.
     This avoids inaccuracies introduced by truncating negative values.  */
  r = x * p->hpi_inv;
  int n = ((int32_t)r + 0x800000) >> 24;
  *np = n;
  return x - n * p->hpi;
}

/* Reduce the range of XI to a multiple of PI/2 using fast integer arithmetic.
   XI is a reinterpreted float and must be >= 2.0f (the sign bit is ignored).
   Return the modulo between -PI/4 and PI/4 and store the quadrant in NP.
   Reduction uses a table of 4/PI with 192 bits of precision.  A 32x96->128 bit
   multiply computes the exact 2.62-bit fixed-point modulo.  Since the result
   can have at most 29 leading zeros after the binary point, the double
   precision result is accurate to 33 bits.  */
static inline double
reduce_large (uint32_t xi, int *np)
{
  const uint32_t *arr = &inv_pio4[(xi >> 26) & 15];
  int shift = (xi >> 23) & 7;
  uint64_t n, res0, res1, res2;

  xi = (xi & 0xffffff) | 0x800000;
  xi <<= shift;

  res0 = xi * arr[0];
  res1 = (uint64_t)xi * arr[4];
  res2 = (uint64_t)xi * arr[8];
  res0 = (res2 >> 32) | (res0 << 32);
  res0 += res1;

  n = (res0 + (1ULL << 61)) >> 62;
  res0 -= n << 62;
  double x = (int64_t)res0;
  *np = n;
  return x * pi63;
}

/* Fast cosf implementation.  Worst-case ULP is 0.5607, maximum relative
   error is 0.5303 * 2^-23.  A single-step range reduction is used for
   small values.  Large inputs have their range reduced using fast integer
   arithmetic.  */
float
discpress_cosf (float y)
{
  double x = y;
  double s;
  int n;
  const sincos_t *p = &sincosf_table[0];

  if (abstop12 (y) < abstop12 (pio4f))
    {
      double x2 = x * x;

      if (abstop12 (y) < abstop12 (0x1p-12f))
	return 1.0f;

      return sinf_poly (x, x2, p, 1);
    }
  else if (abstop12 (y) < abstop12 (120.0f))
    {
      x = reduce_fast (x, p, &n);

      /* Setup the signs for sin and cos.  */
      s = p->sign[n & 3];

      if (n & 2)
	p = &sincosf_table[1];

      return sinf_poly (x * s, x * x, p, n ^ 1);
    }
  else if (abstop12 (y) < abstop12 (INFINITY))
    {
      uint32_t xi = asuint (y);
      int sign = xi >> 31;

      x = reduce_large (xi, &n);

      /* Setup signs for sin and cos - include original sign.  */
      s = p->sign[(n + sign) & 3];

      if ((n + sign) & 2)
	p = &sincosf_table[1];

      return sinf_poly (x * s, x * x, p, n ^ 1);
    }
  else
    return (y - y) / (y - y);
}


/* ---------------------------------------------------------------- log */

#define LOG_TABLE_BITS 7
#define LOG_POLY_ORDER 6
#define LOG_POLY1_ORDER 12
#define N (1 << LOG_TABLE_BITS)
#define OFF 0x3fe6000000000000

static const struct
{
  double ln2hi;
  double ln2lo;
  double poly[LOG_POLY_ORDER - 1]; /* First coefficient is 1.  */
  double poly1[LOG_POLY1_ORDER - 1];
  struct {double invc, logc;} tab[N];
} log_data = {
.ln2hi = 0x1.62e42fefa3800p-1,
.ln2lo = 0x1.ef35793c76730p-45,
.poly1 = {
-0x1p-1,
0x1.5555555555577p-2,
-0x1.ffffffffffdcbp-3,
0x1.999999995dd0cp-3,
-0x1.55555556745a7p-3,
0x1.24924a344de3p-3,
-0x1.fffffa4423d65p-4,
0x1.c7184282ad6cap-4,
-0x1.999eb43b068ffp-4,
0x1.78182f7afd085p-4,
-0x1.5521375d145cdp-4,
},
.poly = {
-0x1.0000000000001p-1,
0x1.555555551305bp-2,
-0x1.fffffffeb459p-3,
0x1.999b324f10111p-3,
-0x1.55575e506c89fp-3,
},
.tab = {
{0x1.734f0c3e0de9fp+0, -0x1.7cc7f79e69000p-2},
{0x1.713786a2ce91fp+0, -0x1.76feec20d0000p-2},
{0x1.6f26008fab5a0p+0, -0x1.713e31351e000p-2},
{0x1.6d1a61f138c7dp+0, -0x1.6b85b38287800p-2},
{0x1.6b1490bc5b4d1p+0, -0x1.65d5590807800p-2},
{0x1.69147332f0cbap+0, -0x1.602d076180000p-2},
{0x1.6719f18224223p+0, -0x1.5a8ca86909000p-2},
{0x1.6524f99a51ed9p+0, -0x1.54f4356035000p-2},
{0x1.63356aa8f24c4p+0, -0x1.4f637c36b4000p-2},
{0x1.614b36b9ddc14p+0, -0x1.49da7fda85000p-2},
{0x1.5f66452c65c4cp+0, -0x1.445923989a800p-2},
{0x1.5d867b5912c4fp+0, -0x1.3edf439b0b800p-2},
{0x1.5babccb5b90dep+0, -0x1.396ce448f7000p-2},
{0x1.59d61f2d91a78p+0, -0x1.3401e17bda000p-2},
{0x1.5805612465687p+0, -0x1.2e9e2ef468000p-2},
{0x1.56397cee76bd3p+0, -0x1.2941b3830e000p-2},
{0x1.54725e2a77f93p+0, -0x1.23ec58cda8800p-2},
{0x1.52aff42064583p+0, -0x1.1e9e129279000p-2},
{0x1.50f22dbb2bddfp+0, -0x1.1956d2b48f800p-2},
{0x1.4f38f4734ded7p+0, -0x1.141679ab9f800p-2},
{0x1.4d843cfde2840p+0, -0x1.0edd094ef9800p-2},
{0x1.4bd3ec078a3c8p+0, -0x1.09aa518db1000p-2},
{0x1.4a27fc3e0258ap+0, -0x1.047e65263b800p-2},
{0x1.4880524d48434p+0, -0x1.feb224586f000p-3},
{0x1.46dce1b192d0bp+0, -0x1.f474a7517b000p-3},
{0x1.453d9d3391854p+0, -0x1.ea4443d103000p-3},
{0x1.43a2744b4845ap+0, -0x1.e020d44e9b000p-3},
{0x1.420b54115f8fbp+0, -0x1.d60a22977f000p-3},
{0x1.40782da3ef4b1p+0, -0x1.cc00104959000p-3},
{0x1.3ee8f5d57fe8fp+0, -0x1.c202956891000p-3},
{0x1.3d5d9a00b4ce9p+0, -0x1.b81178d811000p-3},
{0x1.3bd60c010c12bp+0, -0x1.ae2c9ccd3d000p-3},
{0x1.3a5242b75dab8p+0, -0x1.a45402e129000p-3},
{0x1.38d22cd9fd002p+0, -0x1.9a877681df000p-3},
{0x1.3755bc5847a1cp+0, -0x1.90c6d69483000p-3},
{0x1.35dce49ad36e2p+0, -0x1.87120a645c000p-3},
{0x1.34679984dd440p+0, -0x1.7d68fb4143000p-3},
{0x1.32f5cceffcb24p+0, -0x1.73cb83c627000p-3},
{0x1.3187775a10d49p+0, -0x1.6a39a9b376000p-3},
{0x1.301c8373e3990p+0, -0x1.60b3154b7a000p-3},
{0x1.2eb4ebb95f841p+0, -0x1.5737d76243000p-3},
{0x1.2d50a0219a9d1p+0, -0x1.4dc7b8fc23000p-3},
{0x1.2bef9a8b7fd2ap+0, -0x1.4462c51d20000p-3},
{0x1.2a91c7a0c1babp+0, -0x1.3b08abc830000p-3},
{0x1.293726014b530p+0, -0x1.31b996b490000p-3},
{0x1.27dfa5757a1f5p+0, -0x1.2875490a44000p-3},
{0x1.268b39b1d3bbfp+0, -0x1.1f3b9f879a000p-3},
{0x1.2539d838ff5bdp+0, -0x1.160c8252ca000p-3},
{0x1.23eb7aac9083bp+0, -0x1.0ce7f57f72000p-3},
{0x1.22a012ba940b6p+0, -0x1.03cdc49fea000p-3},
{0x1.2157996cc4132p+0, -0x1.f57bdbc4b8000p-4},
{0x1.201201dd2fc9bp+0, -0x1.e370896404000p-4},
{0x1.1ecf4494d480bp+0, -0x1.d17983ef94000p-4},
{0x1.1d8f5528f6569p+0, -0x1.bf9674ed8a000p-4},
{0x1.1c52311577e7cp+0, -0x1.adc79202f6000p-4},
{0x1.1b17c74cb26e9p+0, -0x1.9c0c3e7288000p-4},
{0x1.19e010c2c1ab6p+0, -0x1.8a646b372c000p-4},
{0x1.18ab07bb670bdp+0, -0x1.78d01b3ac0000p-4},
{0x1.1778a25efbcb6p+0, -0x1.674f145380000p-4},
{0x1.1648d354c31dap+0, -0x1.55e0e6d878000p-4},
{0x1.151b990275fddp+0, -0x1.4485cdea1e000p-4},
{0x1.13f0ea432d24cp+0, -0x1.333d94d6aa000p-4},
{0x1.12c8b7210f9dap+0, -0x1.22079f8c56000p-4},
{0x1.11a3028ecb531p+0, -0x1.10e4698622000p-4},
{0x1.107fbda8434afp+0, -0x1.ffa6c6ad20000p-5},
{0x1.0f5ee0f4e6bb3p+0, -0x1.dda8d4a774000p-5},
{0x1.0e4065d2a9fcep+0, -0x1.bbcece4850000p-5},
{0x1.0d244632ca521p+0, -0x1.9a1894012c000p-5},
{0x1.0c0a77ce2981ap+0, -0x1.788583302c000p-5},
{0x1.0af2f83c636d1p+0, -0x1.5715e67d68000p-5},
{0x1.09ddb98a01339p+0, -0x1.35c8a49658000p-5},
{0x1.08cabaf52e7dfp+0, -0x1.149e364154000p-5},
{0x1.07b9f2f4e28fbp+0, -0x1.e72c082eb8000p-6},
{0x1.06ab58c358f19p+0, -0x1.a55f152528000p-6},
{0x1.059eea5ecf92cp+0, -0x1.63d62cf818000p-6},
{0x1.04949cdd12c90p+0, -0x1.228fb8caa0000p-6},
{0x1.038c6c6f0ada9p+0, -0x1.c317b20f90000p-7},
{0x1.02865137932a9p+0, -0x1.419355daa0000p-7},
{0x1.0182427ea7348p+0, -0x1.81203c2ec0000p-8},
{0x1.008040614b195p+0, -0x1.0040979240000p-9},
{0x1.fe01ff726fa1ap-1, 0x1.feff384900000p-9},
{0x1.fa11cc261ea74p-1, 0x1.7dc41353d0000p-7},
{0x1.f6310b081992ep-1, 0x1.3cea3c4c28000p-6},
{0x1.f25f63ceeadcdp-1, 0x1.b9fc114890000p-6},
{0x1.ee9c8039113e7p-1, 0x1.1b0d8ce110000p-5},
{0x1.eae8078cbb1abp-1, 0x1.58a5bd001c000p-5},
{0x1.e741aa29d0c9bp-1, 0x1.95c8340d88000p-5},
{0x1.e3a91830a99b5p-1, 0x1.d276aef578000p-5},
{0x1.e01e009609a56p-1, 0x1.07598e598c000p-4},
{0x1.dca01e577bb98p-1, 0x1.253f5e30d2000p-4},
{0x1.d92f20b7c9103p-1, 0x1.42edd8b380000p-4},
{0x1.d5cac66fb5ccep-1, 0x1.606598757c000p-4},
{0x1.d272caa5ede9dp-1, 0x1.7da76356a0000p-4},
{0x1.cf26e3e6b2ccdp-1, 0x1.9ab434e1c6000p-4},
{0x1.cbe6da2a77902p-1, 0x1.b78c7bb0d6000p-4},
{0x1.c8b266d37086dp-1, 0x1.d431332e72000p-4},
{0x1.c5894bd5d5804p-1, 0x1.f0a3171de6000p-4},
{0x1.c26b533bb9f8cp-1, 0x1.067152b914000p-3},
{0x1.bf583eeece73fp-1, 0x1.147858292b000p-3},
{0x1.bc4fd75db96c1p-1, 0x1.2266ecdca3000p-3},
{0x1.b951e0c864a28p-1, 0x1.303d7a6c55000p-3},
{0x1.b65e2c5ef3e2cp-1, 0x1.3dfc33c331000p-3},
{0x1.b374867c9888bp-1, 0x1.4ba366b7a8000p-3},
{0x1.b094b211d304ap-1, 0x1.5933928d1f000p-3},
{0x1.adbe885f2ef7ep-1, 0x1.66acd2418f000p-3},
{0x1.aaf1d31603da2p-1, 0x1.740f8ec669000p-3},
{0x1.a82e63fd358a7p-1, 0x1.815c0f51af000p-3},
{0x1.a5740ef09738bp-1, 0x1.8e92954f68000p-3},
{0x1.a2c2a90ab4b27p-1, 0x1.9bb3602f84000p-3},
{0x1.a01a01393f2d1p-1, 0x1.a8bed1c2c0000p-3},
{0x1.9d79f24db3c1bp-1, 0x1.b5b515c01d000p-3},
{0x1.9ae2505c7b190p-1, 0x1.c2967ccbcc000p-3},
{0x1.9852ef297ce2fp-1, 0x1.cf635d5486000p-3},
{0x1.95cbaeea44b75p-1, 0x1.dc1bd3446c000p-3},
{0x1.934c69de74838p-1, 0x1.e8c01b8cfe000p-3},
{0x1.90d4f2f6752e6p-1, 0x1.f5509c0179000p-3},
{0x1.8e6528effd79dp-1, 0x1.00e6c121fb800p-2},
{0x1.8bfce9fcc007cp-1, 0x1.071b80e93d000p-2},
{0x1.899c0dabec30ep-1, 0x1.0d46b9e867000p-2},
{0x1.87427aa2317fbp-1, 0x1.13687334bd000p-2},
{0x1.84f00acb39a08p-1, 0x1.1980d67234800p-2},
{0x1.82a49e8653e55p-1, 0x1.1f8ffe0cc8000p-2},
{0x1.8060195f40260p-1, 0x1.2595fd7636800p-2},
{0x1.7e22563e0a329p-1, 0x1.2b9300914a800p-2},
{0x1.7beb377dcb5adp-1, 0x1.3187210436000p-2},
{0x1.79baa679725c2p-1, 0x1.377266dec1800p-2},
{0x1.77907f2170657p-1, 0x1.3d54ffbaf3000p-2},
{0x1.756cadbd6130cp-1, 0x1.432eee32fe000p-2},
},
};

#define T log_data.tab
#define B log_data.poly1
#define A log_data.poly
#define Ln2hi log_data.ln2hi
#define Ln2lo log_data.ln2lo

/* Top 16 bits of a double.  */
static inline uint32_t
top16 (double x)
{
  return asuint64 (x) >> 48;
}

/* Worst-case error: 0.519 ULP (0.520 without fma).  The fma() calls are where GCC fuses the
   upstream expressions (quoted before each block) when glibc is built for x86-64 with FMA, which
   makes this glibc's log on such a CPU, and on any machine.  */
double
discpress_log (double x)
{
  double w, z, r, r2, r3, y, invc, logc, kd, hi, lo;
  uint64_t ix, iz, tmp;
  uint32_t top;
  int k, i;

  ix = asuint64 (x);
  top = top16 (x);
#define LO asuint64 (1.0 - 0x1p-4)
#define HI asuint64 (1.0 + 0x1.09p-4)
  if (ix - LO < HI - LO)
    {
      /* Handle close to 1.0 inputs separately.  */
      /* Fix sign of zero with downward rounding when x==1.  */
      if (ix == asuint64 (1.0))
	return 0;
      r = x - 1.0;
      r2 = r * r;
      r3 = r * r2;
      /* y = r3 * (B[1] + r * B[2] + r2 * B[3]
		+ r3 * (B[4] + r * B[5] + r2 * B[6]
			+ r3 * (B[7] + r * B[8] + r2 * B[9] + r3 * B[10])));  */
      double const c1 = fma (B[3], r2, fma (B[2], r, B[1]));
      double const c2 = fma (B[6], r2, fma (B[5], r, B[4]));
      double const c3 = fma (B[10], r3, fma (B[9], r2, fma (B[8], r, B[7])));
      double const c = fma (fma (c3, r3, c2), r3, c1);
      /* Worst-case error is around 0.507 ULP.
	 w = r * 0x1p27;
	 double rhi = r + w - w;
	 double rlo = r - rhi;
	 w = rhi * rhi * B[0];  (B[0] == -0.5)
	 hi = r + w;
	 lo = r - hi + w;
	 lo += B[0] * rlo * (rhi + r);
	 y += lo;
	 y += hi;  */
      double const rhi = fma (-r, 0x1p27, fma (r, 0x1p27, r));
      double const rlo = r - rhi;
      double const rhi2 = rhi * rhi;
      hi = fma (rhi2, B[0], r);
      lo = fma (rhi2, B[0], r - hi);
      lo = fma (B[0] * rlo, r + rhi, lo);
      y = fma (c, r3, lo);
      return hi + y;
    }
  if (top - 0x0010 >= 0x7ff0 - 0x0010)
    {
      /* x < 0x1p-1022 or inf or nan.  */
      if (ix * 2 == 0)
	return -1.0 / 0.0;
      if (ix == asuint64 (INFINITY)) /* log(inf) == inf.  */
	return x;
      if ((top & 0x8000) || (top & 0x7ff0) == 0x7ff0)
	return (x - x) / (x - x);
      /* x is subnormal, normalize it.  */
      ix = asuint64 (x * 0x1p52);
      ix -= 52ULL << 52;
    }

  /* x = 2^k z; where z is in range [OFF,2*OFF) and exact.
     The range is split into N subintervals.
     The ith subinterval contains z and c is near its center.  */
  tmp = ix - OFF;
  i = (tmp >> (52 - LOG_TABLE_BITS)) % N;
  k = (int64_t) tmp >> 52; /* arithmetic shift */
  iz = ix - (tmp & 0xfffULL << 52);
  invc = T[i].invc;
  logc = T[i].logc;
  z = asdouble (iz);

  /* log(x) = log1p(z/c-1) + log(c) + k*Ln2.  */
  /* r ~= z/c - 1, |r| < 1/(2*N).  */
  /* rounding error: 0x1p-55/N.  */
  r = fma (z, invc, -1.0);
  kd = (double) k;

  /* hi + lo = r + log(c) + k*Ln2.
     w = kd * Ln2hi + logc;
     hi = w + r;
     lo = w - hi + r + kd * Ln2lo;  */
  w = fma (Ln2hi, kd, logc);
  hi = w + r;
  lo = fma (Ln2lo, kd, w - hi + r);

  /* log(x) = lo + (log1p(r) - r) + hi.
     y = lo + r2 * A[0] + r * r2 * (A[1] + r * A[2] + r2 * (A[3] + r * A[4])) + hi;  */
  r2 = r * r; /* rounding error: 0x1p-54/N^2.  */
  y = fma (r * r2, fma (fma (A[4], r, A[3]), r2, fma (A[2], r, A[1])), fma (A[0], r2, lo));
  return y + hi;
}
