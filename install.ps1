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
# ASCII with no BOM: the extension reads this with a plain trim, and a BOM
# would ride along into the path and make it unopenable.
[System.IO.File]::WriteAllText((Join-Path $slot "cc1.path"), $Cc1, [System.Text.Encoding]::ASCII)
[System.IO.File]::WriteAllText((Join-Path $studio "extension\slot.txt"), $slot, [System.Text.Encoding]::ASCII)

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
    [System.IO.File]::WriteAllText((Join-Path $studio "source\source.path"), $sourceDir, [System.Text.Encoding]::ASCII)
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
$userSettings = "$env:APPDATA\Code\User\settings.json"
New-Item -ItemType Directory -Force -Path (Split-Path $userSettings) | Out-Null
$conf = @{}
if (Test-Path $userSettings) {
    $raw = Get-Content $userSettings -Raw
    # settings.json is JSONC; drop line comments so it parses.
    $raw = ($raw -split "`n" | Where-Object { $_ -notmatch '^\s*//' }) -join "`n"
    try { $conf = $raw | ConvertFrom-Json -AsHashtable } catch { $conf = @{} }
}
if (-not $conf) { $conf = @{} }
$conf["cc1.path"] = $Cc1
[System.IO.File]::WriteAllText($userSettings, ($conf | ConvertTo-Json -Depth 10), [System.Text.Encoding]::UTF8)
Write-Host "  cc1.path -> $Cc1"
Write-Host "  written to $userSettings"

# Through the editor, from the package - never by copying the folder in.
#
# Copying looks like it works and does not: the editor lists the extension,
# `code --list-extensions` prints it, its entry appears in extensions.json, and
# it never loads. Only an installed .vsix runs. This script used to copy, and
# that is exactly the install that did nothing.
$code = (Get-Command code -ErrorAction SilentlyContinue).Source
if (-not $code) {
    $guess = "$env:USERPROFILE\AppData\Local\Programs\Microsoft VS Code\bin\code.cmd"
    if (Test-Path $guess) { $code = $guess }
}

$vsix = Join-Path $studio "cc1-studio-1.0.0.vsix"
if (-not (Test-Path $vsix)) {
    Write-Warning "$vsix is missing. Build it on a machine with 'zip' (./package.sh) and copy it here - it is 27 KB of text."
    exit 0
}

if (-not $code) {
    Write-Host ""
    Write-Warning "The slot is set, but VS Code's 'code' command was not found, so the extension was not installed. Once VS Code is installed, run: code --install-extension `"$vsix`""
    exit 0
}

# A previous hand-copied install leaves a directory the editor refuses to
# install over, complaining it must be restarted first. Clearing the stale
# entry is what makes this repeatable.
foreach ($dir in @("$env:USERPROFILE\.vscode\extensions", "$env:USERPROFILE\.vscode-server\extensions")) {
    if (-not (Test-Path $dir)) { continue }
    foreach ($stale in @("compiler-c.cc1-studio-1.0.0", ".obsolete", "extensions.json")) {
        $p = Join-Path $dir $stale
        if (Test-Path $p) { Remove-Item -Recurse -Force $p -ErrorAction SilentlyContinue }
    }
}

& $code --install-extension $vsix

Write-Host ""
Write-Host "Done. Open a .c file and TRUST the folder when VS Code asks - an untrusted"
Write-Host "folder runs in Restricted Mode, where the extension is disabled and says nothing."
