#!/usr/bin/env bash
set -euo pipefail
mathink_root="$(cd "$(dirname "$0")/.." && pwd)"
: "${GOROOT_HARMONY:?Set GOROOT_HARMONY to a separate patched Go 1.26.5 installation}"
: "${OHOS_NDK_HOME:?Set OHOS_NDK_HOME to the Linux Harmony SDK directory containing native/}"
: "${LOG_ADAPTOR_HOME:?Set LOG_ADAPTOR_HOME to the documented SiYuan Harmony log adaptor}"
export GOROOT="$GOROOT_HARMONY"
export PATH="$GOROOT/bin:$PATH"
export CC="$OHOS_NDK_HOME/native/llvm/bin/clang"
export CXX="$OHOS_NDK_HOME/native/llvm/bin/clang++"
for mathink_tool in AR:llvm-ar AS:llvm-as LD:ld.lld STRIP:llvm-strip RANLIB:llvm-ranlib OBJDUMP:llvm-objdump OBJCOPY:llvm-objcopy NM:llvm-nm; do
  export "${mathink_tool%%:*}=$OHOS_NDK_HOME/native/llvm/bin/${mathink_tool#*:}"
done
export LLVMCONFIG="$OHOS_NDK_HOME/native/llvm/bin/llvm-config"
export CFLAGS="-target aarch64-linux-ohos --sysroot=${OHOS_NDK_HOME}/native/sysroot -D__MUSL__"
export CXXFLAGS="$CFLAGS"
if [[ "$(go env GOVERSION)" != 'go1.26.5' ]]; then
  echo 'The isolated Harmony toolchain must be Go 1.26.5.' >&2
  exit 1
fi
export CGO_ENABLED=1 GOOS=android GOARCH=arm64
export CGO_CFLAGS="-I${LOG_ADAPTOR_HOME}/include -g -O2 $("$LLVMCONFIG" --cflags) --target=aarch64-linux-ohos --sysroot=${OHOS_NDK_HOME}/native/sysroot"
export CGO_LDFLAGS="--target=aarch64-linux-ohos -fuse-ld=lld -L${LOG_ADAPTOR_HOME}/dist/arm64-v8a"
mathink_out="$mathink_root/upstream/siyuan-harmony/entry/libs/arm64-v8a"
mkdir -p "$mathink_out"
cd "$mathink_root/upstream/siyuan/kernel/harmony"
go build -tags 'fts5 sqlcipher' -ldflags '-s -w -X github.com/siyuan-note/siyuan/kernel/util.FixedPort=6817' -buildmode=c-shared -o "$mathink_out/libkernel.so" .
cp "$mathink_out/libkernel.h" "$mathink_root/upstream/siyuan-harmony/entry/src/main/cpp/include/libkernel.h"
echo 'Built MathInk Harmony kernel for arm64-v8a on isolated port 6817.'
