#!/bin/sh
# Build cc1 on this Mac, with this Mac's own compiler.
#
# Nothing is downloaded and nothing is copied from another machine: the source
# is the Compiler-C checkout named in ../../source/source.path, the compiler is
# whatever `make` finds here (Apple clang), and the binary it produces never
# leaves this machine.

set -eu

here=$(cd "$(dirname "$0")" && pwd)
studio=$(cd "$here/../.." && pwd)

if [ ! -r "$studio/source/source.path" ]; then
  echo "source/source.path is missing - run $studio/install.sh first" >&2
  exit 2
fi
src=$(cat "$studio/source/source.path")

if [ ! -f "$src/Makefile" ]; then
  echo "no Makefile in $src - is that really the Compiler-C checkout?" >&2
  exit 2
fi

jobs=$(sysctl -n hw.ncpu 2>/dev/null || echo 2)
echo "building cc1 in $src with make -j$jobs"
cd "$src"
make -j"$jobs"

built=$src/cc1
[ -x "$built" ] || { echo "make finished but $built is not there" >&2; exit 1; }

# The same check install.sh makes: a cc1 without -S is too old for the
# extension, whatever the build said.
if ! "$built" 2>&1 | grep -q -- '-S'; then
  echo "$built does not support -S - refusing to point the slot at it" >&2
  exit 1
fi

mkdir -p "$studio/cc"
printf '%s\n' "$built" > "$studio/cc/cc1.path"
ln -sfn "$built" "$studio/cc/cc1" 2>/dev/null || true

echo
echo "cc/ -> $built"
"$built" 2>&1 | head -1
