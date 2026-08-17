#!/bin/sh
# Apply an architecture's configuration to a workspace.
#
#   ./use.sh arm64-darwin ~/Documents/Claude/CC1Studio/demo
#   ./use.sh                       # lists the three, and says which suits here
#
# It copies that architecture's settings.json and tasks.json into the folder's
# .vscode/. Nothing else is installed and no binary is touched.

set -eu

studio=$(cd "$(dirname "$0")" && pwd)

host=unknown
case "$(uname -s 2>/dev/null)/$(uname -m 2>/dev/null)" in
  Darwin/arm64) host=arm64-darwin ;;
  Linux/x86_64) host=x86_64-linux ;;
  *NT*|MINGW*|MSYS*|CYGWIN*) host=x86_64-windows ;;
esac

if [ $# -lt 1 ]; then
  echo "usage: $0 <architecture> [folder]"
  echo
  echo "  arm64-darwin      the Mac"
  echo "  x86_64-linux      the EC2 box"
  echo "  x86_64-windows    the LAN machine"
  echo
  [ "$host" != unknown ] && echo "This machine is $host." \
    || echo "This machine is not one of cc1's three targets."
  exit 1
fi

arch=$1
folder=${2:-$PWD}

[ -d "$studio/arch/$arch" ] || { echo "no such architecture: $arch" >&2; exit 2; }
[ -d "$folder" ] || { echo "no such folder: $folder" >&2; exit 2; }

mkdir -p "$folder/.vscode"
cp "$studio/arch/$arch/settings.json" "$folder/.vscode/settings.json"
cp "$studio/arch/$arch/tasks.json" "$folder/.vscode/tasks.json"

echo "applied $arch to $folder/.vscode/"

# Configuration for a machine you are not sitting at is a legitimate thing to
# want - it is how a cross-compile is set up - but saying so beats letting it
# be discovered when the Run command refuses.
if [ "$host" != unknown ] && [ "$arch" != "$host" ]; then
  echo
  echo "note: this machine is $host, so $arch is a cross target here."
  echo "      cc1 will write assembly and stop, which is its own rule."
fi

echo
echo "Open the folder in VS Code and trust it when asked - an untrusted folder"
echo "runs in Restricted Mode, where the extension is disabled and says nothing."
