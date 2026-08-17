#!/bin/sh
# Build cc1 on the Linux box, with that box's own gcc.
#
# Same shape as the Mac's script, and different in one way that matters: this
# machine has 419 MB of memory and runs httpd, mysqld and php-fpm beside the
# build. An unbounded parallel make has wedged it before, so the job count is
# capped rather than taken from the core count.

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

# Two cores, but memory is the scarce thing here, not CPU. One g++ of this
# translation unit is comfortable; two are not always.
jobs=${CC1_BUILD_JOBS:-1}
available=$(awk '/MemAvailable/ {print int($2/1024)}' /proc/meminfo 2>/dev/null || echo 0)
echo "building cc1 in $src with make -j$jobs   (${available} MB available)"
if [ "$available" -gt 0 ] && [ "$available" -lt 200 ]; then
  echo "warning: under 200 MB free - close what you can, or the build may be killed" >&2
fi

cd "$src"
make -j"$jobs"

built=$src/cc1
[ -x "$built" ] || { echo "make finished but $built is not there" >&2; exit 1; }

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
