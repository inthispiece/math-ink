param([switch]$Kernel, [switch]$Release)
$ErrorActionPreference = 'Stop'
$mathInkRoot = Split-Path -Parent $PSScriptRoot
if (-not $env:JAVA_HOME) { throw 'Install Android Studio JDK, set JAVA_HOME, and follow docs/UPSTREAM-BUILD.md.' }
if (-not ($env:ANDROID_HOME -or $env:ANDROID_SDK_ROOT)) { throw 'Set ANDROID_HOME to the Android SDK with API 36.' }
if ($Kernel) {
    if (-not (Get-Command gomobile -ErrorAction SilentlyContinue)) { throw 'Install Go 1.26.5 and gomobile first.' }
    Push-Location (Join-Path $mathInkRoot 'upstream/siyuan/kernel')
    try {
        & gomobile bind -tags 'fts5 sqlcipher' -ldflags '-s -w -X github.com/siyuan-note/siyuan/kernel/util.FixedPort=6817' -o (Join-Path $mathInkRoot 'upstream/siyuan-android/app/libs/kernel.aar') -target android/arm64 -androidapi 29 ./mobile/
        if ($LASTEXITCODE -ne 0) { throw 'Android Go kernel build failed.' }
    } finally { Pop-Location }
}
$mathInkKernel = Join-Path $mathInkRoot 'upstream/siyuan-android/app/libs/kernel.aar'
if (-not (Test-Path -LiteralPath $mathInkKernel)) { throw 'Missing kernel.aar. Re-run with -Kernel after installing the toolchain.' }
& node (Join-Path $PSScriptRoot 'prepare-resources.mjs') android
if ($LASTEXITCODE -ne 0) { throw 'Android resource packaging failed.' }
& node (Join-Path $mathInkRoot 'scripts/upstream-verify-resources.mjs') android
if ($LASTEXITCODE -ne 0) { throw 'Android resource verification failed.' }
$mathInkAndroid = Join-Path $mathInkRoot 'upstream/siyuan-android'
$mathInkSigning = Join-Path $mathInkAndroid 'signings.gradle'
if (-not (Test-Path -LiteralPath $mathInkSigning)) {
    @'
android {
    signingConfigs {
        siyuanConfig {
            // Release signing must be supplied locally; never use a debug key.
            if (System.getenv('MATHINK_KEYSTORE')) {
                storeFile file(System.getenv('MATHINK_KEYSTORE'))
                storePassword System.getenv('MATHINK_STORE_PASSWORD')
                keyAlias System.getenv('MATHINK_KEY_ALIAS')
                keyPassword System.getenv('MATHINK_KEY_PASSWORD')
            }
        }
    }
}
'@ | Set-Content -LiteralPath $mathInkSigning -Encoding utf8
}
if ($Release -and -not $env:MATHINK_KEYSTORE) { throw 'Release requires your MathInk keystore and signing environment variables.' }
Push-Location $mathInkAndroid
try {
    $mathInkTask = if ($Release) { 'assembleHuaweiRelease' } else { 'assembleHuaweiDebug' }
    & .\gradlew.bat $mathInkTask
    if ($LASTEXITCODE -ne 0) { throw 'Android Gradle build failed.' }
} finally { Pop-Location }
