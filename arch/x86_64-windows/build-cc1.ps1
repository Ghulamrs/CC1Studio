# Build cc1 on the Windows machine, with that machine's own cl.
#
# The checkout carries msvc\cc1.vcxproj for exactly this, so MSBuild is given
# the project rather than a command line reconstructed here. Nothing is copied
# from another machine: the source is the checkout named in
# ..\..\source\source.path, and the cc1.exe this produces stays here.

$ErrorActionPreference = "Stop"

$here   = Split-Path -Parent $MyInvocation.MyCommand.Path
$studio = (Resolve-Path (Join-Path $here "..\..")).Path

$pointer = Join-Path $studio "source\source.path"
if (-not (Test-Path $pointer)) {
    Write-Error "source\source.path is missing - run install.ps1 first"
    exit 2
}
$src = (Get-Content $pointer -Raw).Trim()

$project = Join-Path $src "msvc\cc1.vcxproj"
if (-not (Test-Path $project)) {
    Write-Error "no msvc\cc1.vcxproj under $src - is that really the Compiler-C checkout?"
    exit 2
}

# MSBuild comes from the Visual Studio install, which vswhere locates. The same
# lookup the extension does for vcvars64.bat, and for the same reason: hard
# coding a version is how this breaks the next time VS updates.
$vswhere = "${env:ProgramFiles(x86)}\Microsoft Visual Studio\Installer\vswhere.exe"
$msbuild = $null
if (Test-Path $vswhere) {
    $msbuild = & $vswhere -latest -requires Microsoft.Component.MSBuild `
                          -find "MSBuild\**\Bin\MSBuild.exe" | Select-Object -First 1
}
if (-not $msbuild) { $msbuild = (Get-Command MSBuild.exe -ErrorAction SilentlyContinue).Source }
if (-not $msbuild) {
    Write-Error "MSBuild was not found. Install the Visual Studio C++ build tools."
    exit 2
}

Write-Host "building cc1 from $project"
Write-Host "with $msbuild"
& $msbuild $project /nologo /p:Configuration=Release /p:Platform=x64 /m
if ($LASTEXITCODE -ne 0) { Write-Error "MSBuild failed"; exit 1 }

# Wherever the project put it - the layout has moved between checkouts, so it
# is found rather than assumed.
$built = Get-ChildItem -Path $src -Filter cc1.exe -Recurse -ErrorAction SilentlyContinue |
         Sort-Object LastWriteTime -Descending | Select-Object -First 1
if (-not $built) { Write-Error "MSBuild finished but no cc1.exe was found under $src"; exit 1 }

# The same check install.ps1 makes. A cc1 without -S is too old for the
# extension, whatever the build said - and this machine has had three cc1.exe
# on it at once, so "the newest one that exists" is not proof of anything.
$previous = $ErrorActionPreference
$ErrorActionPreference = 'Continue'
$usage = (& $built.FullName 2>&1 | Out-String)
$ErrorActionPreference = $previous
if ($usage -notmatch '-S') {
    Write-Error "$($built.FullName) does not support -S - refusing to point the slot at it"
    exit 1
}

$slot = Join-Path $studio "cc"
New-Item -ItemType Directory -Force -Path $slot | Out-Null
[System.IO.File]::WriteAllText((Join-Path $slot "cc1.path"), $built.FullName, [System.Text.Encoding]::ASCII)

Write-Host ""
Write-Host "cc\ -> $($built.FullName)"
Write-Host ($usage -split "`n")[0]
