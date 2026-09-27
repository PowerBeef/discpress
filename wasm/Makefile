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
COMMON := $(OPT) -DNDEBUG -DLSB_FIRST -DCRLF=2 -DSDLMAME_UNIX -DOSD_SDL -DUTF8PROC_STATIC -D_FILE_OFFSET_BITS=64 -D_LARGEFILE_SOURCE
INC := -I$(M)/src/osd -I$(M)/src/lib/util -I$(M)/3rdparty -I$(M)/3rdparty/zlib -I$(M)/3rdparty/zstd/lib -I$(M)/3rdparty/flac/include -I$(M)/3rdparty/utf8proc -I$(M)/3rdparty/expat/lib -I$(M)/src/lib -Ishim
CXXFLAGS := $(COMMON) $(PLAT) -std=c++20 $(INC) -Wno-deprecated-declarations
FLACDEF := -DHAVE_CONFIG_H -DENABLE_64_BIT_WORDS=1 -DOGG_FOUND=0 -DFLAC__HAS_OGG=0 -DHAVE_LROUND=1 -DHAVE_INTTYPES_H -DHAVE_STDBOOL_H -DHAVE_STDINT_H -DHAVE_STDIO_H -DHAVE_STDLIB_H -DHAVE_STRING_H -DCPU_IS_BIG_ENDIAN=0 -DCPU_IS_LITTLE_ENDIAN=1 -DWORDS_BIGENDIAN=0 -DHAVE_BSWAP16 -DHAVE_BSWAP32 -DFLAC__NO_ASM -I$(M)/3rdparty/flac/src/libFLAC/include -I$(M)/3rdparty/flac/include
EXPATDEF := -DHAVE_CXX11 -DHAVE_MEMMOVE -DHAVE_STDINT_H -DHAVE_STDIO_H -DHAVE_STDLIB_H -DHAVE_STRING_H '-DPACKAGE="expat"' -DSTDC_HEADERS -DXML_CONTEXT_BYTES=1024 -DXML_DTD -DXML_GE=1 -DXML_NS -DBYTEORDER=1234 -DXML_POOR_ENTROPY
ZSTDDEF := -DXXH_NAMESPACE=ZSTD_ -DDEBUGLEVEL=0 -DZSTD_DISABLE_ASM -DZSTD_MULTITHREAD=0
LZMADEF := -DZ7_PPMD_SUPPORT -DZ7_ST

# wasm_helper.cpp is browser-only (helper workers and identification probes)
ifeq ($(T),wasm)
CPP_SRC := $(UTIL_SRC) $(OSD_SRC) $(TOOL_SRC)
else
CPP_SRC := $(UTIL_SRC) $(OSD_SRC) $(filter-out wasm_helper.cpp,$(TOOL_SRC))
endif
obj = $(O)/$(subst /,_,$(subst $(M)/,,$(basename $(1)))).o

define cxxrule
$(call obj,$(1)): $(1) | $(O)
	$$(CXX) $$(CXXFLAGS) -c $$< -o $$@
endef
define crule
$(call obj,$(1)): $(1) | $(O)
	$$(CC) $$(COMMON) $(2) -std=gnu11 -c $$< -o $$@
endef
$(foreach s,$(CPP_SRC),$(eval $(call cxxrule,$(s))))
$(foreach s,$(ZLIB_SRC),$(eval $(call crule,$(s),-I$(M)/3rdparty/zlib)))
$(foreach s,$(ZSTD_SRC),$(eval $(call crule,$(s),$(ZSTDDEF))))
$(foreach s,$(FLAC_SRC),$(eval $(call crule,$(s),$(FLACDEF))))
$(foreach s,$(LZMA_SRC),$(eval $(call crule,$(s),$(LZMADEF))))
$(foreach s,$(UTF8_SRC),$(eval $(call crule,$(s),)))
$(foreach s,$(EXPAT_SRC),$(eval $(call crule,$(s),$(EXPATDEF))))

ALL_SRC := $(CPP_SRC) $(ZLIB_SRC) $(ZSTD_SRC) $(FLAC_SRC) $(LZMA_SRC) $(UTF8_SRC) $(EXPAT_SRC)
OBJS := $(foreach s,$(ALL_SRC),$(call obj,$(s)))

$(O):
	mkdir -p $(O)

objs: $(OBJS)

native: $(OBJS)
	$(CXX) -O2 $(OBJS) -o $(O)/../chdman-native -lpthread

.PHONY: objs native
