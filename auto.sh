cd /tmp
wget https://tukaani.org/xz/xz-embedded-20210201.tar.gz
cd ~
tar -xf /tmp/xz-embedded-*.tar.gz

# from userspace dir:
# https://github.com/WebAssembly/wasi-sdk/releases/download/wasi-sdk-16/wasi-sdk_16.0_amd64.deb
# /opt/wasi-sdk/bin/clang -Wl,--export-all,--no-entry -mexec-model=reactor -I../linux/include/linux -I. -DXZ_USE_CRC64 -O2 -v ../linux/lib/xz/xz_dec_stream.c ../linux/lib/xz/xz_crc32.c ../linux/lib/xz/xz_crc64.c ../linux/lib/xz/xz_dec_lzma2.c
