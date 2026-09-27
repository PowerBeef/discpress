#!/usr/bin/env bash
# CHD codec lab: reproduces the measurements in docs/chd/measurements.md.
#
#   docs/chd/lab/lab.sh fetch      # corpora (Freedoom, CC/CC0 music) + zopfli, libdeflate, libchdr sources
#   docs/chd/lab/lab.sh corpus     # build the test discs from them
#   docs/chd/lab/lab.sh build      # harness, variant chdman, libchdr reader (needs build/obj-native)
#   docs/chd/lab/lab.sh harness    # per-hunk codec economics -> *.csv/*.json + analysis
#   docs/chd/lab/lab.sh variants   # encoder variants, each verified by MAME and libchdr
#   docs/chd/lab/lab.sh hunks      # hunk size vs size / decode cost
#
# Everything is written to tests/.cache/chd-lab (gitignored). The downloaded material
# is freely licensed but is used for local measurement only; never commit it.
# build/obj-native comes from ./scripts/build-native.sh. Python needs numpy, soundfile, scipy.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/../../.." && pwd)"
LAB="${LAB:-$ROOT/tests/.cache/chd-lab}"
M="${MAME_DIR:-$ROOT/third_party/mame}"
export LAB
mkdir -p "$LAB"/{corpus,src,out,bin}

CXXFLAGS="-O2 -std=c++20 -DNDEBUG -DLSB_FIRST -DCRLF=2 -DSDLMAME_UNIX -DOSD_SDL -DSDLMAME_LINUX -DUTF8PROC_STATIC -D_FILE_OFFSET_BITS=64 \
 -I$M/src/osd -I$M/src/lib/util -I$M/3rdparty -I$M/3rdparty/zlib -I$M/3rdparty/zstd/lib -I$M/3rdparty/flac/include -I$M/src/lib -I$ROOT/wasm/shim -Wno-deprecated-declarations"

clone() { [ -d "$LAB/src/$2" ] || git clone -q --depth 1 "https://github.com/$1" "$LAB/src/$2"; }

case "${1:-}" in
fetch)
	cd "$LAB/corpus"
	[ -f freedoom.zip ] || curl -sSL -o freedoom.zip https://github.com/freedoom/freedoom/releases/download/v0.13.0/freedoom-0.13.0.zip
	# NIN "The Slip" (CC BY-NC-SA 4.0) and Musopen Chopin (CC0), 24-bit sources resampled to CD format by build_corpus.py
	[ -f nin_01.flac ] || curl -sSL -o nin_01.flac "https://archive.org/download/nine-inch-nails-the-slip_202607/01%20-%20CD%20%28Album%29/01%20-%20999%2C999.flac"
	[ -f nin_07.flac ] || curl -sSL -o nin_07.flac "https://archive.org/download/nine-inch-nails-the-slip_202607/01%20-%20CD%20%28Album%29/07%20-%20Lights%20in%20the%20Sky.flac"
	[ -f chopin_albumleaf.flac ] || curl -sSL -o chopin_albumleaf.flac "https://archive.org/download/musopen-chopin-complete-works-flac/Albumleaf%20in%20E%20major.flac"
	[ -f chopin_berceuse.flac ] || curl -sSL -o chopin_berceuse.flac "https://archive.org/download/musopen-chopin-complete-works-flac/Berceuse%20in%20D-flat%20major%2C%20Op.%2057%20.flac"
	clone google/zopfli zopfli; clone ebiggers/libdeflate libdeflate; clone rtissera/libchdr libchdr
	;;
corpus)
	python3 "$HERE/build_corpus.py" "$LAB/corpus"
	;;
build)
	OBJ="$ROOT/build/obj-native"
	[ -d "$OBJ" ] || { echo "run ./scripts/build-native.sh first" >&2; exit 1; }
	ALL=$(ls "$OBJ"/*.o | grep -v src_tools_chdman.o)
	# 1. per-hunk harness against MAME's own codecs
	g++ $CXXFLAGS "$HERE/harness.cpp" $ALL -o "$LAB/bin/harness" -lpthread
	# 2. chdman with environment-selectable encoder variants (defaults are stock and byte-identical)
	V="$LAB/variant"; mkdir -p "$V/obj"
	cp "$M/src/lib/util/chdcodec.cpp" "$V/chdcodec.cpp"; patch -s "$V/chdcodec.cpp" < "$HERE/chdcodec-variants.diff"
	cp "$M/src/lib/util/flac.cpp" "$V/flac.cpp"; patch -s "$V/flac.cpp" < "$HERE/flac-variants.diff"
	for f in "$LAB"/src/zopfli/src/zopfli/{blocksplitter,cache,deflate,gzip_container,hash,katajainen,lz77,squeeze,tree,util,zlib_container,zopfli_lib}.c; do gcc -O2 -c "$f" -o "$V/obj/zopfli_$(basename "$f" .c).o"; done
	for f in "$LAB"/src/libdeflate/lib/*.c "$LAB"/src/libdeflate/lib/x86/*.c; do gcc -O2 -I"$LAB/src/libdeflate" -c "$f" -o "$V/obj/ldf_$(basename "$f" .c).o"; done
	g++ $CXXFLAGS -I"$LAB/src/libdeflate" -I"$LAB/src/zopfli/src" -c "$V/chdcodec.cpp" -o "$V/obj/chdcodec_variant.o"
	g++ $CXXFLAGS -c "$V/flac.cpp" -o "$V/obj/flac_variant.o"
	g++ -O2 $(ls "$OBJ"/*.o | grep -v -E "src_lib_util_chdcodec.o|src_lib_util_flac.o") "$V"/obj/*.o -o "$LAB/bin/chdman-variant" -lpthread
	# 3. libchdr reader (writes the logical data of a CHD to stdout)
	L="$LAB/src/libchdr"
	cmake -S "$L" -B "$L/build" -DBUILD_SHARED_LIBS=OFF -DCHDR_WANT_TESTS=OFF -DCMAKE_BUILD_TYPE=Release >/dev/null
	cmake --build "$L/build" -j"$(nproc)" >/dev/null
	gcc -O2 -I"$L/include" "$HERE/chdread.c" "$L/build/libchdr-static.a" "$L"/build/deps/*/lib*.a -lm -lstdc++ -o "$LAB/bin/chdread"
	# sanity: without CHDV_* variables the variant build must match stock chdman byte for byte
	"$ROOT/build/chdman-native" createcd -i "$ROOT/tests/.cache/fixtures/mgs disc1.cue" -o "$LAB/out/stock.chd" -f >/dev/null 2>&1
	"$LAB/bin/chdman-variant" createcd -i "$ROOT/tests/.cache/fixtures/mgs disc1.cue" -o "$LAB/out/var0.chd" -f >/dev/null 2>&1
	cmp "$LAB/out/stock.chd" "$LAB/out/var0.chd" && echo "variant build (no CHDV_*) is byte-identical to stock"
	;;
harness)
	C="$LAB/corpus"; O="$LAB/out"
	"$LAB/bin/harness" cd "$C/data_m2.bin" --codecs cdlz,cdzl,cdfl,cdzs --dump "$O/data_m2.csv" > "$O/data_m2.json" &
	"$LAB/bin/harness" cd "$C/audio.bin" --audio --codecs cdlz,cdzl,cdfl,cdzs --dump "$O/audio.csv" > "$O/audio.json" &
	"$LAB/bin/harness" dvd "$C/payload.iso" --codecs lzma,zlib,huff,flac,zstd --dump "$O/dvd.csv" > "$O/dvd.json" &
	wait
	python3 "$HERE/analyze.py" "$O"
	;;
variants) python3 "$HERE/run_variants.py" "${@:2}" ;;
hunks) python3 "$HERE/run_hunks.py" ;;
*) sed -n '2,15p' "$0"; exit 1 ;;
esac
