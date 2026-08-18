# Install CC1 Studio into this machine's VS Code.
#
#   .\install.ps1 [-Cc1 C:\path\to\cc1.exe]
#
# The Windows counterpart of install.sh. It copies rather than links, because
# a symlink here wants an administrator and the editor does not care either
# way - the slot is a text file precisely so this difference costs nothing.

param(
    [string]$Cc1 = ""
)

$ErrorActionPreference = "Stop"
$studio = Split-Path -Parent $MyInvocation.MyCommand.Path

# ---- find this machine's cc1 ------------------------------------------------

if (-not $Cc1) {
    $guesses = @(
        (Join-Path $studio "..\Compiler-C\cc1.exe"),
        (Join-Path $studio "..\Compiler-C\msvc\cc1.exe"),
        "$env:USERPROFILE\ansicc\cc1.exe"
    )
    foreach ($g in $guesses) {
        if (Test-Path $g) { $Cc1 = (Resolve-Path $g).Path; break }
    }
    if (-not $Cc1) {
        $onPath = Get-Command cc1.exe -ErrorAction SilentlyContinue
        if ($onPath) { $Cc1 = $onPath.Source }
    }
}

if (-not $Cc1 -or -not (Test-Path $Cc1)) {
    Write-Error "cc1.exe was not found. Build it, then pass its path: .\install.ps1 -Cc1 C:\path\to\cc1.exe"
    exit 2
}
$Cc1 = (Resolve-Path $Cc1).Path

# It has to be a cc1 that can do what the extension asks of it. -S is the flag
# to look for: the diagnostics and the assembly pane are both built on it, and
# an older cc1 that lacks it still prints "arch picks the architecture" just
# like the current one - so a looser test accepts a compiler that cannot work.
#
# The preference is dropped around this one call on purpose. cc1 prints its
# usage to stderr, and under "Stop" PowerShell treats any stderr from a native
# program as a terminating error - so asking the compiler what it can do would
# abort the installer on the answer.
$previous = $ErrorActionPreference
$ErrorActionPreference = 'Continue'
$usage = (& $Cc1 2>&1 | Out-String)
$ErrorActionPreference = $previous

if ($usage -notmatch '-S') {
    Write-Error "$Cc1 does not support -S, so it is too old for this extension. Its usage says:`n$usage"
    exit 2
}

# ---- the toolchain slot -----------------------------------------------------

$slot = Join-Path $studio "cc"
New-Item -ItemType Directory -Force -Path $slot | Out-Null
# UTF-8 with no BOM: the extension reads these with a plain trim, so a BOM
# would ride along into the path - and ASCII would silently turn any
# character outside it into '?', which a profile named in another script
# would meet on its first path.
$noBom = New-Object System.Text.UTF8Encoding($false)
[System.IO.File]::WriteAllText((Join-Path $slot "cc1.path"), $Cc1, $noBom)
[System.IO.File]::WriteAllText((Join-Path $studio "extension\slot.txt"), $slot, $noBom)

Write-Host "cc\  -> $Cc1"

# Where the source is, for arch\x86_64-windows\build-cc1.ps1.
#
# It cannot be taken from the binary's own directory as the shell script does,
# because MSBuild buries its output: the compiler lands in
# msvc\x64\Release\cc1.exe, four levels below the checkout root. So walk up
# until something that is unmistakably the checkout appears. A copy of the
# source is never made; see source\README.md.
$sourceDir = $null
$probe = Split-Path -Parent $Cc1
while ($probe -and -not $sourceDir) {
    if ((Test-Path (Join-Path $probe "msvc\cc1.vcxproj")) -or
        ((Test-Path (Join-Path $probe "Makefile")) -and (Test-Path (Join-Path $probe "src")))) {
        $sourceDir = $probe
    }
    $parent = Split-Path -Parent $probe
    if ($parent -eq $probe) { break }
    $probe = $parent
}

New-Item -ItemType Directory -Force -Path (Join-Path $studio "source") | Out-Null
if ($sourceDir) {
    [System.IO.File]::WriteAllText((Join-Path $studio "source\source.path"), $sourceDir, $noBom)
    Write-Host "source\ -> $sourceDir"
} else {
    Write-Warning "No Compiler-C checkout found above $Cc1 - write its path into $studio\source\source.path by hand."
}

# ---- the extension ----------------------------------------------------------

# Tell the extension where the compiler is, by writing the setting.
#
# The package deliberately carries no machine-specific path - a .vsix is copied
# between machines, and a baked-in path would be a second silent answer to
# "which cc1". So the installer writes cc1.path, which survives reinstalling
# the extension and is visible in the Settings UI.
# A settings file this cannot parse is a settings file this must not rewrite:
# the parse only recovers what it understood, so writing that back silently
# drops everything else. The old version did exactly that - and on Windows
# PowerShell 5.1 it did it every time, because ConvertFrom-Json has no
# -AsHashtable there and the resulting error was caught and turned into an
# empty object. This uses only what 5.1 has, and walks away rather than
# guessing.
function Write-Cc1Path($file, $value, $encoding) {
    New-Item -ItemType Directory -Force -Path (Split-Path $file) | Out-Null
    $conf = $null
    if (Test-Path $file) {
        $rawText = Get-Content $file -Raw
        if ($rawText -and $rawText.Trim()) {
            # settings.json is JSONC; drop whole-line comments and try.
            $stripped = ($rawText -split "`n" | Where-Object { $_ -notmatch '^\s*//' }) -join "`n"
            foreach ($candidate in @($rawText, $stripped)) {
                try { $conf = $candidate | ConvertFrom-Json; break } catch { $conf = $null }
            }
        } else {
            $conf = New-Object PSObject
        }
    } else {
        $conf = New-Object PSObject
    }

    if ($null -eq $conf) {
        Write-Warning "Could not parse $file safely - leaving it alone."
        Write-Warning "Add this line to it yourself:  `"cc1.path`": `"$($value -replace '\\', '\\\\')`""
        return
    }
    $conf | Add-Member -NotePropertyName "cc1.path" -NotePropertyValue $value -Force
    [System.IO.File]::WriteAllText($file, ($conf | ConvertTo-Json -Depth 10), $encoding)
    Write-Host "  cc1.path -> $value"
    Write-Host "  written to $file"
}

Write-Cc1Path "$env:APPDATA\Code\User\settings.json" $Cc1 $noBom

# A Remote-SSH window reads none of the above. It runs against the server in
# ~\.vscode-server, which has its own extension directory and its own settings
# file - and on this machine that is the only way the editor is ever seen,
# because nobody is logged in at the console to open a local window. Writing
# only the desktop settings left a remote window with the extension asking for
# a cc1.path nothing had set.
$machineSettings = "$env:USERPROFILE\.vscode-server\data\Machine\settings.json"
if (Test-Path (Split-Path (Split-Path $machineSettings))) {
    Write-Cc1Path $machineSettings $Cc1 $noBom
}

# Through the editor, from the package - never by copying the folder in.
#
# Copying looks like it works and does not: the editor lists the extension,
# `code --list-extensions` prints it, its entry appears in extensions.json, and
# it never loads. Only an installed .vsix runs. This script used to copy, and
# that is exactly the install that did nothing.
#
# There are two editors on this machine, not one. The desktop `code` installs
# into ~\.vscode\extensions, which is what a local window reads; a Remote-SSH
# window reads ~\.vscode-server\extensions and is served by its own CLI. Both
# get the package, because which one is in use is not this script's business -
# and on a box with nobody at the console, the remote one is the only one that
# matters.
$installers = @()

$code = (Get-Command code -ErrorAction SilentlyContinue).Source
if (-not $code) {
    $guess = "$env:USERPROFILE\AppData\Local\Programs\Microsoft VS Code\bin\code.cmd"
    if (Test-Path $guess) { $code = $guess }
}
if ($code) { $installers += @{ Name = "desktop"; Exe = $code } }

# Server layouts: the one Remote-SSH uses now, and the legacy one. Newest first,
# because a machine keeps the servers of every version it has connected with.
$serverGlobs = @(
    "$env:USERPROFILE\.vscode-server\cli\servers\Stable-*\server\bin\code-server.cmd",
    "$env:USERPROFILE\.vscode-server\bin\*\bin\code-server.cmd"
)
foreach ($glob in $serverGlobs) {
    $found = Get-ChildItem $glob -ErrorAction SilentlyContinue |
             Sort-Object LastWriteTime -Descending |
             Select-Object -First 1
    if ($found) {
        $installers += @{ Name = "remote (server)"; Exe = $found.FullName }
        break
    }
}

$vsix = Join-Path $studio "cc1-studio-1.0.0.vsix"
if (-not (Test-Path $vsix)) {
    Write-Warning "$vsix is missing. Build it on a machine with 'zip' (./package.sh) and copy it here - it is 36 KB of text."
    exit 0
}

if ($installers.Count -eq 0) {
    Write-Host ""
    Write-Warning "The slot is set, but no VS Code CLI was found, so the extension was not installed. Once VS Code is installed, run: code --install-extension `"$vsix`""
    exit 0
}

foreach ($installer in $installers) {
    Write-Host ""
    Write-Host "installing into the $($installer.Name) editor"
    # A previous hand-copied install leaves a directory the editor refuses to
    # install over, complaining it must be restarted first. Only this
    # extension's own folder is cleared, and never extensions.json: that file
    # is the registry for *every* extension on that side, and deleting it from
    # ~\.vscode-server\extensions is what emptied this box's remote install
    # while the desktop one was being replaced.
    foreach ($dir in @("$env:USERPROFILE\.vscode\extensions", "$env:USERPROFILE\.vscode-server\extensions")) {
        $stale = Join-Path $dir "compiler-c.cc1-studio-1.0.0"
        if ((Test-Path $stale) -and -not (Test-Path (Join-Path $stale ".vsixmanifest"))) {
            Remove-Item -Recurse -Force $stale -ErrorAction SilentlyContinue
        }
    }
    & $installer.Exe --install-extension $vsix --force
}

Write-Host ""
Write-Host "Done. Open a .c file and TRUST the folder when VS Code asks - an untrusted"
Write-Host "folder runs in Restricted Mode, where the extension is disabled and says nothing."
