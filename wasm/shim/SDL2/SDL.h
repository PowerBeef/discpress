#pragma once
#include <stdlib.h>
typedef enum { SDL_FALSE = 0, SDL_TRUE = 1 } SDL_bool;
static inline SDL_bool SDL_HasClipboardText(void) { return SDL_FALSE; }
static inline char *SDL_GetClipboardText(void) { return (char *)calloc(1, 1); }
static inline int SDL_SetClipboardText(const char *t) { (void)t; return -1; }
static inline void SDL_free(void *p) { free(p); }
static inline const char *SDL_GetError(void) { return "unsupported"; }
