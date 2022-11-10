#!/bin/sh -eux

cd /tmp
curl https://tukaani.org/xz/xz-embedded-20210201.tar.gz | tar -xz
curl https://sourceware.org/pub/bzip2/bzip2-1.0.8.tar.gz | tar -xz
curl -L https://github.com/WebAssembly/wasi-sdk/releases/download/wasi-sdk-12/wasi-sdk_12.0_amd64.deb | dpkg -x - unpack

cd /tmp/xz-embedded-20210201
/tmp/unpack/opt/wasi-sdk/bin/clang \
  --sysroot=/tmp/unpack/opt/wasi-sdk/share/wasi-sysroot \
  --target=wasm32-wasi \
  -Wl,--export-all,--no-entry \
  -Ilinux/include/linux \
  -Iuserspace \
  -DXZ_USE_CRC64 \
  -O2 \
  linux/lib/xz/xz_crc32.c \
  linux/lib/xz/xz_crc64.c \
  linux/lib/xz/xz_dec_stream.c \
  linux/lib/xz/xz_dec_lzma2.c \
  linux/lib/xz/xz_dec_bcj.c \
  ~/dummy_main.c \
  -o ~/xz-embedded.wasm

cd /tmp/bzip2-1.0.8
/tmp/unpack/opt/wasi-sdk/bin/clang \
  --sysroot=/tmp/unpack/opt/wasi-sdk/share/wasi-sysroot \
  --target=wasm32-wasi \
  -Wl,--export-all,--no-entry \
  -DBZ_NO_STDIO \
  -O2 \
  blocksort.c \
  huffman.c \
  crctable.c \
  randtable.c \
  compress.c \
  decompress.c \
  bzlib.c \
  ~/dummy_main.c \
  ~/bzip2_impls.c \
  -o ~/bzip2.wasm
