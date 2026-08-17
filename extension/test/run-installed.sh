#!/bin/sh
# Run the same tests against the *installed* extension rather than the source
# directory, using this machine's real extension folder.
#
#   ./test/run-installed.sh [/path/to/cc1]
#
# run.sh loads the source directory; this loads the files install.sh actually
# put in place, and with them the slot.txt written beside them - which is what
# proves the toolchain slot resolves with no setting configured.
#
# It still goes through --extensionDevelopmentPath, pointed at the installed
# copy rather than the source. Passing --extensionTestsPath without it looks
# like it should work and does not: the editor starts, the extension host comes
# up, and the tests are simply never run, with nothing printed to say so.
# Discovery of the installed extension is worth checking separately, and
# cheaply:
#
#     code --list-extensions --extensions-dir ~/.vscode/extensions

set -eu

here=$(cd "$(dirname "$0")" && pwd)
ext=$(dirname "$here")

if [ $# -ge 1 ]; then
  cc1=$1
elif [ -r "$ext/../cc/cc1.path" ]; then
  cc1=$(cat "$ext/../cc/cc1.path")
else
  cc1=$(command -v cc1 || true)
fi
if [ -z "${cc1:-}" ] || [ ! -x "$cc1" ]; then
  echo "no cc1 to test against; pass one as the first argument" >&2
  exit 2
fi

for candidate in \
  "/Applications/Visual Studio Code.app/Contents/MacOS/Code" \
  "$HOME/Applications/Visual Studio Code.app/Contents/MacOS/Code" \
  "/usr/share/code/code" \
  "/snap/code/current/usr/share/code/code" \
  "/usr/bin/code"
do
  if [ -x "$candidate" ]; then code_bin=$candidate; break; fi
done
[ -z "${code_bin:-}" ] && code_bin=$(command -v code || true)
if [ -z "${code_bin:-}" ]; then echo "VS Code was not found" >&2; exit 2; fi

installed=$HOME/.vscode/extensions/compiler-c.cc1-studio-1.0.0
if [ ! -e "$installed" ]; then
  echo "the extension is not installed; run ./install.sh first" >&2
  exit 2
fi

# Discovery is checked separately and by hand, not from here:
#
#     code --list-extensions --extensions-dir ~/.vscode/extensions
#
# It belongs outside this script because it needs the real extensions
# directory, and loading that means loading the editor's built-in GitHub and
# agent extensions too - which open a browser asking to be signed into. Every
# launch below therefore passes --disable-extensions, and nothing in this file
# may remove it.

# The real extensions directory, so the installed copy is what loads. A scratch
# user-data-dir all the same, so the run cannot disturb the editor's settings.
profile=${TMPDIR:-/tmp}/cc1-studio-installed-profile
rm -rf "$profile"
mkdir -p "$profile/User" "$profile/extensions"

# A fresh profile opening a folder full of .c files makes VS Code offer, and
# then install, the C/C++ extension pack - which took several minutes and made
# the first run of this script look like a hang. The test has no opinion about
# those extensions; it just must not wait on a download.
cat > "$profile/User/settings.json" <<'JSON'
{
  "extensions.ignoreRecommendations": true,
  "extensions.autoUpdate": false,
  "extensions.autoCheckUpdates": false,
  "update.mode": "none",
  "telemetry.telemetryLevel": "off",
  "workbench.startupEditor": "none",
  "window.restoreWindows": "none",
  "workbench.welcomePage.walkthroughs.openOnInstall": false,
  "chat.commandCenter.enabled": false,
  "github.copilot.enable": { "*": false }
}
JSON

echo "cc1 under test: $cc1"
echo "extension:      $installed"
echo

CC1_UNDER_TEST=$cc1 \
"$code_bin" \
  --user-data-dir "$profile" \
  --extensions-dir "$profile/extensions" \
  --disable-extensions \
  --disable-gpu \
  --disable-workspace-trust \
  --skip-release-notes \
  --skip-welcome \
  --no-sandbox \
  --extensionDevelopmentPath="$installed" \
  --extensionTestsPath="$installed/test/index.js" \
  "$installed/test/fixtures"
status=$?

rm -rf "$profile"
exit $status
