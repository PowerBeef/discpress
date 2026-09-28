/* cosf and log for libFLAC, identical in every Discpress build (see README.md) */
#ifndef DISCPRESS_FLAC_LIBM_H
#define DISCPRESS_FLAC_LIBM_H

#ifdef __cplusplus
extern "C" {
#endif

float discpress_cosf(float x);
double discpress_log(double x);

#ifdef __cplusplus
}
#endif

#endif
