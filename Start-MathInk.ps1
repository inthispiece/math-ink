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
    $mathInkArguments = @()
    if ($Lan) {
        $env:GATEWAY_HOST = '0.0.0.0'
        $mathInkArguments += '--lan'
        $mathInkAddresses = [System.Net.NetworkInformation.NetworkInterface]::GetAllNetworkInterfaces() |
            Where-Object { $_.OperationalStatus -eq [System.Net.NetworkInformation.OperationalStatus]::Up } |
            ForEach-Object { $_.GetIPProperties().UnicastAddresses } |
            Where-Object { $_.Address.AddressFamily -eq [System.Net.Sockets.AddressFamily]::InterNetwork -and $_.Address.IPAddressToString -notmatch '^(127\.|169\.254\.)' } |
            ForEach-Object { $_.Address.IPAddressToString }
        foreach ($mathInkAddress in $mathInkAddresses) { $mathInkArguments += @('--lan-address', $mathInkAddress) }
    }
    & $mathInkNode --env-file-if-exists=.env scripts/serve-preview.mjs @mathInkArguments
    if ($LASTEXITCODE -ne 0) { throw 'MathInk 预览服务退出。' }
} finally {
    $env:GATEWAY_HOST = $mathInkPreviousHost
    $env:GATEWAY_PAIRING_TOKEN = $mathInkPreviousToken
    Pop-Location
}
