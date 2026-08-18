# Run the integration tests inside a real VS Code, on Windows.
#
#   .\run.ps1 [C:\path\to\cc1.exe]
#
# The PowerShell twin of run.sh, for the machine that has neither sh nor
# bash - which is also the machine all of lib\windows.js exists for, so it is
# the machine where running the suite matters most. Written for Windows
# PowerShell 5.1: nothing here needs pwsh.
#
# The window that opens is the test host. It closes itself; the exit code is
# the result.

param(
    [string]$Cc1 = ""
)

$ErrorActionPreference = "Stop"
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$ext = Split-Path -Parent $here
$studio = Split-Path -Parent $ext

# The compiler under test: the argument, then the slot, then PATH. Named
# explicitly so a run can never be against a cc1 nobody chose.
if (-not $Cc1) {
    $slotFile = Join-Path $studio "cc\cc1.path"
    if (Test-Path $slotFile) {
        $Cc1 = (Get-Content $slotFile -Raw).Trim()
    }
}
if (-not $Cc1) {
    $onPath = Get-Command cc1.exe -ErrorAction SilentlyContinue
    if ($onPath) { $Cc1 = $onPath.Source }
}
if (-not $Cc1 -or -not (Test-Path $Cc1)) {
    Write-Error "no cc1 to test against; pass one as the first argument"
    exit 2
}

# The editor binary. Code.exe itself, not code.cmd: the wrapper does not
# propagate the exit code, and the exit code is the result.
$codeBin = $null
foreach ($candidate in @(
    "$env:LOCALAPPDATA\Programs\Microsoft VS Code\Code.exe",
    "$env:ProgramFiles\Microsoft VS Code\Code.exe",
    "${env:ProgramFiles(x86)}\Microsoft VS Code\Code.exe"
)) {
    if ($candidate -and (Test-Path $candidate)) { $codeBin = $candidate; break }
}
if (-not $codeBin) {
    $cmd = Get-Command code.cmd -ErrorAction SilentlyContinue
    if ($cmd) {
        # bin\code.cmd sits beside the install; walk up to Code.exe.
        $guess = Join-Path (Split-Path -Parent (Split-Path -Parent $cmd.Source)) "Code.exe"
        if (Test-Path $guess) { $codeBin = $guess }
    }
}
if (-not $codeBin) {
    Write-Error "VS Code was not found"
    exit 2
}

# A scratch profile, so the test cannot be coloured by the real one and
# cannot disturb it either.
$profile = Join-Path $env:TEMP "cc1-studio-test-profile"
if (Test-Path $profile) { Remove-Item -Recurse -Force $profile }
New-Item -ItemType Directory -Force -Path (Join-Path $profile "user") | Out-Null
New-Item -ItemType Directory -Force -Path (Join-Path $profile "extensions") | Out-Null

Write-Host "cc1 under test: $Cc1"
Write-Host "editor:         $codeBin"
Write-Host ""

$env:CC1_UNDER_TEST = $Cc1

# Code.exe is a GUI-subsystem binary, so the call operator would not wait for
# it and its console output goes nowhere; Start-Process -Wait does the
# waiting, -PassThru carries the exit code out, and the redirects catch what
# the test host prints - without them the checks run and say nothing.
$outLog = Join-Path $profile "stdout.log"
$errLog = Join-Path $profile "stderr.log"
$proc = Start-Process -FilePath $codeBin -Wait -PassThru `
    -RedirectStandardOutput $outLog -RedirectStandardError $errLog `
    -ArgumentList @(
    "--user-data-dir", (Join-Path $profile "user"),
    "--extensions-dir", (Join-Path $profile "extensions"),
    "--disable-extensions",
    "--disable-gpu",
    "--disable-workspace-trust",
    "--skip-release-notes",
    "--skip-welcome",
    "--extensionDevelopmentPath=$ext",
    "--extensionTestsPath=$here\index.js",
    (Join-Path $here "fixtures")
)
$status = $proc.ExitCode

foreach ($log in @($outLog, $errLog)) {
    if (Test-Path $log) { Get-Content $log | Write-Host }
}

Remove-Item -Recurse -Force $profile -ErrorAction SilentlyContinue
Write-Host ""
Write-Host "exit $status"
exit $status
