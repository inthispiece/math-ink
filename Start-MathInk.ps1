param([switch]$Lan)
$ErrorActionPreference = 'Stop'
$mathInkNode = (Get-Command node -ErrorAction SilentlyContinue).Source
if (-not $mathInkNode) {
    $mathInkNode = Join-Path $env:USERPROFILE '.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node.exe'
    if (-not (Test-Path -LiteralPath $mathInkNode)) { throw '请安装 Node.js 24，再运行此脚本。' }
}
Push-Location $PSScriptRoot
$mathInkPreviousHost = $env:GATEWAY_HOST
$mathInkPreviousToken = $env:GATEWAY_PAIRING_TOKEN
try {
    if ($Lan) {
        $env:GATEWAY_HOST = '0.0.0.0'
        if (-not $env:GATEWAY_PAIRING_TOKEN) { $env:GATEWAY_PAIRING_TOKEN = [guid]::NewGuid().ToString('N') }
        Write-Host "局域网配对令牌（填入应用设置）：$($env:GATEWAY_PAIRING_TOKEN)"
        Get-NetIPAddress -AddressFamily IPv4 -ErrorAction SilentlyContinue | Where-Object { $_.IPAddress -notmatch '^(127\.|169\.254\.)' } | ForEach-Object { Write-Host "平板地址：http://$($_.IPAddress):8787" }
    }
    & $mathInkNode --env-file-if-exists=.env scripts/serve-preview.mjs
    if ($LASTEXITCODE -ne 0) { throw 'MathInk 预览服务退出。' }
} finally {
    $env:GATEWAY_HOST = $mathInkPreviousHost
    $env:GATEWAY_PAIRING_TOKEN = $mathInkPreviousToken
    Pop-Location
}
