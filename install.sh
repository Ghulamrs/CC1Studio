#!/bin/sh
# Install CC1 Studio into this machine's VS Code.
#
#   ./install.sh [/path/to/cc1] [--server]
#
# Two things happen. The toolchain slot cc/ is pointed at this machine's cc1,
# and the extension is linked into whichever VS Code extension directories
# exist here - the desktop one, the Remote-SSH server one, or both.
#
# --server installs into ~/.vscode-server/extensions whether or not it already
# exists, which is what a headless machine needs: it has no desktop VS Code and
# no server either until the first Remote-SSH connection creates one. Seeding
# the directory beforehand means the extension is already in place when that
# connection lands, rather than needing a second pass afterwards.
#
# No copy of cc1 is made, ever. See cc/README.md for why that would be worse
# than useless.

set -eu

studio=$(cd "$(dirname "$0")" && pwd)

# ---- find this machine's cc1 ------------------------------------------------

force_server=no
cc1_arg=""
for arg in "$@"; do
  case $arg in
    --server) force_server=yes ;;
    *) cc1_arg=$arg ;;
  esac
done

if [ -n "$cc1_arg" ]; then
  cc1=$cc1_arg
elif [ -x "$studio/../Compiler-C/cc1" ]; then
  cc1=$(cd "$studio/../Compiler-C" && pwd)/cc1
elif [ -x "$HOME/ansicc/cc1" ]; then
  cc1=$HOME/ansicc/cc1
else
  cc1=$(command -v cc1 || true)
fi

if [ -z "${cc1:-}" ] || [ ! -x "$cc1" ]; then
  echo "cc1 was not found. Build it, then pass its path:" >&2
  echo "    $0 /path/to/cc1" >&2
  exit 2
fi
cc1=$(cd "$(dirname "$cc1")" && pwd)/$(basename "$cc1")

# It has to be a cc1 that can do what the extension asks of it, not merely a
# file of that name. The usage text it prints when given no input is the
# signature, and -S is the flag to look for: the diagnostics and the assembly
# pane are both built on it.
#
# Checking for -S rather than something more obvious is deliberate. A cc1 built
# on 2026-08-15 was found in the home directory of the machine this was written
# on, and it prints "arch picks the architecture" exactly like the current one
# while having no -S, no -c and no -D at all. A looser test accepts it.
if ! "$cc1" 2>&1 | grep -q -- '-S'; then
  echo "$cc1 does not support -S, so it is too old for this extension." >&2
  echo "Its usage says:" >&2
  "$cc1" 2>&1 | sed 's/^/    /' >&2
  exit 2
fi

# ---- the toolchain slot -----------------------------------------------------

mkdir -p "$studio/cc" "$studio/source"
printf '%s\n' "$cc1" > "$studio/cc/cc1.path"

# Where the compiler's source lives, for the build-cc1 scripts under arch/.
# Derived from the binary rather than guessed: cc1 sits at the root of its
# checkout, so its directory is the checkout - confirmed by the Makefile being
# there. A copy of the source is never made; see source/README.md.
candidate=$(dirname "$cc1")
if [ -f "$candidate/Makefile" ] || [ -d "$candidate/src" ]; then
  printf '%s\n' "$candidate" > "$studio/source/source.path"
  echo "source/ -> $candidate"
else
  echo "note: $candidate does not look like the Compiler-C checkout;" >&2
  echo "      write its path into $studio/source/source.path by hand." >&2
fi
# A symlink as well, where they are free, so the directory is usable from a
# shell too. The extension reads cc1.path and does not depend on this.
ln -sfn "$cc1" "$studio/cc/cc1" 2>/dev/null || true
printf '%s\n' "$studio/cc" > "$studio/extension/slot.txt"

echo "cc/  -> $cc1"

# ---- the extension ----------------------------------------------------------

# Which VS Code is on this machine decides where the extension goes, and the
# two answers are independent - a desktop machine that is also SSH'd into wants
# both. A directory that does not exist yet is not evidence of absence: VS Code
# only creates ~/.vscode/extensions the first time it installs something, so a
# freshly installed editor has none.
targets=""

desktop=no
for candidate in \
  "/Applications/Visual Studio Code.app" \
  "$HOME/Applications/Visual Studio Code.app" \
  "/usr/share/code" \
  "/snap/code"
do
  [ -e "$candidate" ] && desktop=yes && break
done
[ "$desktop" = no ] && command -v code >/dev/null 2>&1 && desktop=yes
[ -d "$HOME/.vscode/extensions" ] && desktop=yes

[ "$desktop" = yes ] && targets="$HOME/.vscode/extensions"
if [ -d "$HOME/.vscode-server" ] || [ "$force_server" = yes ]; then
  targets="$targets $HOME/.vscode-server/extensions"
fi
[ -d "$HOME/.vscode-insiders" ] && targets="$targets $HOME/.vscode-insiders/extensions"

if [ -z "$targets" ]; then
  echo "No VS Code found here - neither a desktop install nor a Remote-SSH server." >&2
  echo "Install VS Code and re-run, or pass --server to seed the Remote-SSH" >&2
  echo "server directory before the first connection to this machine." >&2
  exit 2
fi

# Tell the extension where the compiler is, by writing the setting.
#
# The package deliberately carries no machine-specific path: a .vsix is copied
# between machines, and a baked-in path would be a second, silent answer to
# "which cc1" - the very thing cc/ exists to prevent. The slot file cannot help
# an installed copy either, because the extension is unpacked into VS Code's
# own directory, far from this one.
#
# So the installer writes cc1.path. It is explicit, it survives reinstalling
# the extension, and it is visible in the Settings UI where it can be changed.
settings=""
case "$(uname -s)" in
  Darwin) settings="$HOME/Library/Application Support/Code/User/settings.json" ;;
  Linux)  settings="$HOME/.config/Code/User/settings.json" ;;
esac
# A Remote-SSH machine has no desktop settings; its equivalent is machine scope.
[ -d "$HOME/.vscode-server" ] && settings="$HOME/.vscode-server/data/Machine/settings.json"

if [ -n "$settings" ] && command -v python3 >/dev/null 2>&1; then
  mkdir -p "$(dirname "$settings")"
  CC1_PATH="$cc1" SETTINGS="$settings" python3 - <<'PY'
import json, os, re
p, cc1 = os.environ["SETTINGS"], os.environ["CC1_PATH"]
try:
    raw = open(p).read()
except OSError:
    raw = "{}"
# settings.json is JSONC; strip line comments so it parses, then rewrite plain.
try:
    d = json.loads(re.sub(r'^\s*//.*$', '', raw, flags=re.M) or "{}")
except ValueError:
    d = {}
d["cc1.path"] = cc1
json.dump(d, open(p, "w"), indent=2)
open(p, "a").write("\n")
print("  cc1.path -> " + cc1)
print("  written to " + p)
PY
else
  echo "  (could not write cc1.path automatically; set it in Settings)" >&2
fi

# Through the editor, from a package - never by copying the folder in.
#
# Copying looks like it works and does not: the editor lists the extension,
# `code --list-extensions` prints it, its entry appears in extensions.json, and
# it never loads. Only an installed .vsix runs.
#
# The command that installs one is not always called `code`, and there are two
# server layouts to look in. A headless machine reached over Remote-SSH has no
# desktop VS Code at all - what it has is the server, whose CLI is
# code-server, under either the older bin/<commit>/ or the one Remote-SSH uses
# now, cli/servers/Stable-<commit>/server/. Searching for only one of the three
# reports the extension uninstalled while a working server sits ready to take
# it.
cli=$(command -v code 2>/dev/null || true)
if [ -z "$cli" ]; then
  for candidate in \
    "$HOME"/.vscode-server/cli/servers/*/server/bin/code-server \
    "$HOME"/.vscode-server/bin/*/bin/code-server
  do
    [ -x "$candidate" ] && cli=$candidate && break
  done
fi

if [ -z "$cli" ]; then
  echo
  echo "The slot is set, but no VS Code command was found, so the extension was" >&2
  echo "not installed. Looked for 'code' on PATH and for a Remote-SSH server at" >&2
  echo "$HOME/.vscode-server/bin/*/bin/code-server. Once VS Code is here:" >&2
  echo "    $studio/package.sh" >&2
  echo "    code --install-extension $studio/cc1-studio-1.0.0.vsix" >&2
  exit 0
fi
echo "installing through $cli"

vsix=$studio/cc1-studio-1.0.0.vsix
if [ ! -f "$vsix" ] || [ "$studio/extension/package.json" -nt "$vsix" ]; then
  "$studio/package.sh" >/dev/null
fi

# A previous hand-copied install leaves a directory the editor refuses to
# install over, complaining that it must be restarted first. Clearing the stale
# entry is what makes this repeatable.
for dir in $targets; do
  rm -rf "$dir/compiler-c.cc1-studio-1.0.0" "$dir/.obsolete" "$dir/extensions.json" 2>/dev/null || true
done

"$cli" --install-extension "$vsix" 2>&1 | grep -iE "success|error" || true


echo
echo "Done. Restart VS Code, open a .c file, and the status bar will name the target."
