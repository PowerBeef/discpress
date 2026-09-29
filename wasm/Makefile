include sources.mk
T ?= wasm
SIMD ?= -msimd128
# EXTRA: additional compiler flags for experiments (e.g. EXTRA=-flto)
EXTRA ?=
ifeq ($(T),wasm)
CC := emcc
CXX := em++
OPT := -O3 -fwasm-exceptions $(SIMD) $(EXTRA)
PLAT := -DSDLMAME_EMSCRIPTEN
else
CC := gcc
CXX := g++
OPT := -O2 -g0
PLAT := -DSDLMAME_LINUX
endif
O ?= obj-$(T)
COMMON := $(OPT) -DNDEBUG -DLSB_FIRST -DCRLF=2 -DSDLMAME_UNIX -DOSD_SDL -D_FILE_OFFSET_BITS=64 -D_LARGEFILE_SOURCE $(if $(UPSTREAM),-DUTF8PROC_STATIC '-DBARE_VCS_REVISION="mame0289"')
INC := -I$(M)/src/osd -I$(M)/src/lib/util -I$(M)/3rdparty -I$(M)/3rdparty/zlib -I$(M)/3rdparty/zstd/lib -I$(M)/3rdparty/flac/include $(if $(UPSTREAM),-I$(M)/3rdparty/utf8proc) -I$(M)/src/lib -Ishim $(if $(UPSTREAM),,-I$(M)/../libdeflate)
CXXFLAGS := $(COMMON) $(PLAT) -std=c++20 $(INC) -Wno-deprecated-declarations
FLACDEF := -DHAVE_CONFIG_H -DENABLE_64_BIT_WORDS=1 -DOGG_FOUND=0 -DFLAC__HAS_OGG=0 -DHAVE_LROUND=1 -DHAVE_INTTYPES_H -DHAVE_STDBOOL_H -DHAVE_STDINT_H -DHAVE_STDIO_H -DHAVE_STDLIB_H -DHAVE_STRING_H -DCPU_IS_BIG_ENDIAN=0 -DCPU_IS_LITTLE_ENDIAN=1 -DWORDS_BIGENDIAN=0 -DHAVE_BSWAP16 -DHAVE_BSWAP32 -DFLAC__NO_ASM -I$(M)/3rdparty/flac/src/libFLAC/include -I$(M)/3rdparty/flac/include $(if $(UPSTREAM),,-I$(M)/../libm)
ZSTDDEF := -DXXH_NAMESPACE=ZSTD_ -DDEBUGLEVEL=0 -DZSTD_DISABLE_ASM -DZSTD_MULTITHREAD=0
LZMADEF := -DZ7_PPMD_SUPPORT -DZ7_ST

# wasm_helper.cpp and ecm.cpp are browser-only (helper workers, identification probes, ECM input)
ifeq ($(T),wasm)
CPP_SRC := $(UTIL_SRC) $(OSD_SRC) $(TOOL_SRC)
else
CPP_SRC := $(UTIL_SRC) $(OSD_SRC) $(filter-out wasm_helper.cpp ecm.cpp,$(TOOL_SRC))
endif
obj = $(O)/$(subst /,_,$(subst ../,,$(subst $(M)/,,$(basename $(1))))).o

# -MMD -MP: each object also gets a .d file listing the headers it includes, so changing a
# header recompiles everything that uses it (a stale object could disagree on a class layout)
define cxxrule
$(call obj,$(1)): $(1) | $(O)
	$$(CXX) $$(CXXFLAGS) -MMD -MP -c $$< -o $$@
endef
define crule
$(call obj,$(1)): $(1) | $(O)
	$$(CC) $$(COMMON) $(2) -std=gnu11 -MMD -MP -c $$< -o $$@
endef
$(foreach s,$(CPP_SRC),$(eval $(call cxxrule,$(s))))
$(foreach s,$(ZLIB_SRC),$(eval $(call crule,$(s),-I$(M)/3rdparty/zlib)))
$(foreach s,$(ZSTD_SRC),$(eval $(call crule,$(s),$(ZSTDDEF))))
$(foreach s,$(FLAC_SRC),$(eval $(call crule,$(s),$(FLACDEF))))
$(foreach s,$(LZMA_SRC),$(eval $(call crule,$(s),$(LZMADEF))))
$(foreach s,$(UTF8_SRC),$(eval $(call crule,$(s),)))
$(foreach s,$(DEFLATE_SRC),$(eval $(call crule,$(s),)))
# -ffp-contract=off: no fused multiply-adds but the explicit fma() calls, on any CPU
$(foreach s,$(LIBM_SRC),$(eval $(call crule,$(s),-ffp-contract=off)))

ALL_SRC := $(CPP_SRC) $(ZLIB_SRC) $(ZSTD_SRC) $(FLAC_SRC) $(LZMA_SRC) $(UTF8_SRC) $(LIBM_SRC) $(DEFLATE_SRC)
OBJS := $(foreach s,$(ALL_SRC),$(call obj,$(s)))
-include $(OBJS:.o=.d)
# and a change to the flags or the source list recompiles everything
$(OBJS): Makefile sources.mk

$(O):
	mkdir -p $(O)

# the link list: only these objects (stale ones in $(O) are ignored), sorted so the order doesn't depend on the locale
$(O)/objs.rsp: $(OBJS) | $(O)
	printf '%s\n' $(sort $(OBJS)) > $@

objs: $(OBJS) $(O)/objs.rsp

NATIVE ?= $(O)/../chdman-native
native: $(OBJS)
	$(CXX) -O2 $(OBJS) -o $(NATIVE) -lpthread

# a test tool (tests/support/cdprobe.cpp): the engine's CD reads as the page's identification makes them
CDPROBE ?= $(O)/../cdprobe-native
cdprobe: $(OBJS) ../tests/support/cdprobe.cpp
	$(CXX) $(CXXFLAGS) -O2 ../tests/support/cdprobe.cpp $(filter-out $(call obj,$(M)/src/tools/chdman.cpp),$(OBJS)) -o $(CDPROBE) -lpthread

.PHONY: cdprobe

.PHONY: objs native
