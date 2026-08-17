#!/bin/sh
# Run the integration tests inside a real VS Code.
#
#   ./test/run.sh [/path/to/cc1]
#
# VS Code is its own Electron, so this needs no node and no npm - which is the
# point, since neither exists on the Mac this was written on nor on the EC2 box
# it has to run on.
#
# The window that opens is the test host. It closes itself; the exit code is
# the result.

set -eu

here=$(cd "$(dirname "$0")" && pwd)
ext=$(dirname "$here")

# The compiler under test: the argument, then the slot, then the sibling
# checkout, then PATH. Named explicitly so a run can never be against a cc1
# nobody chose - a green suite whose provenance is unknown proves nothing.
if [ $# -ge 1 ]; then
  cc1=$1
elif [ -r "$ext/../cc/cc1.path" ]; then
  cc1=$(cat "$ext/../cc/cc1.path")
elif [ -x "$ext/../../Compiler-C/cc1" ]; then
  cc1=$(cd "$ext/../../Compiler-C" && pwd)/cc1
else
  cc1=$(command -v cc1 || true)
fi

if [ -z "${cc1:-}" ] || [ ! -x "$cc1" ]; then
  echo "no cc1 to test against; pass one as the first argument" >&2
  exit 2
fi

# The editor binary, per platform.
for candidate in \
  "/Applications/Visual Studio Code.app/Contents/MacOS/Code" \
  "$HOME/Applications/Visual Studio Code.app/Contents/MacOS/Code" \
  "/usr/share/code/code" \
  "/snap/code/current/usr/share/code/code" \
  "/usr/bin/code"
do
  if [ -x "$candidate" ]; then code_bin=$candidate; break; fi
done
if [ -z "${code_bin:-}" ]; then
  code_bin=$(command -v code || true)
fi
if [ -z "${code_bin:-}" ]; then
  echo "VS Code was not found" >&2
  exit 2
fi

# A scratch profile, so the test cannot be coloured by the real one and cannot
# disturb it either.
profile=${TMPDIR:-/tmp}/cc1-studio-test-profile
rm -rf "$profile"
mkdir -p "$profile/user" "$profile/extensions"

echo "cc1 under test: $cc1"
echo "editor:         $code_bin"
echo

CC1_UNDER_TEST=$cc1 \
"$code_bin" \
  --user-data-dir "$profile/user" \
  --extensions-dir "$profile/extensions" \
  --disable-extensions \
  --disable-gpu \
  --disable-workspace-trust \
  --skip-release-notes \
  --skip-welcome \
  --no-sandbox \
  --extensionDevelopmentPath="$ext" \
  --extensionTestsPath="$here/index.js" \
  "$here/fixtures"
status=$?

rm -rf "$profile"
exit $status
