param([switch]$Release)
$ErrorActionPreference = 'Stop'
$mathInkRoot = Split-Path -Parent $PSScriptRoot
$mathInkKernel = Join-Path $mathInkRoot 'upstream/siyuan-harmony/entry/libs/arm64-v8a/libkernel.so'
if (-not (Test-Path -LiteralPath $mathInkKernel)) { throw 'Missing Harmony kernel. Build platforms/build-harmony-kernel.sh under WSL2/Linux first.' }
if (-not $env:HVIGOR) { throw 'Install DevEco Studio, configure own signing, and set HVIGOR to its hvigorw.js path.' }
& node (Join-Path $PSScriptRoot 'prepare-resources.mjs') harmony
if ($LASTEXITCODE -ne 0) { throw 'Harmony resource packaging failed.' }
& node (Join-Path $mathInkRoot 'scripts/upstream-verify-resources.mjs') harmony
if ($LASTEXITCODE -ne 0) { throw 'Harmony resource verification failed.' }
Push-Location (Join-Path $mathInkRoot 'upstream/siyuan-harmony')
try {
    $mathInkMode = if ($Release) { 'release' } else { 'debug' }
    & node $env:HVIGOR --mode module -p product=default -p module=entry@default -p buildMode=$mathInkMode assembleHap --no-daemon
    if ($LASTEXITCODE -ne 0) { throw 'Harmony Hvigor build failed.' }
} finally { Pop-Location }
