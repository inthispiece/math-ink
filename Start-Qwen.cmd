@echo off
setlocal DisableDelayedExpansion
set "MATHINK_LOCAL_MODE=--serve"
if not "%~1"=="" (
    if /i not "%~1"=="--pull" (
        echo Usage: Start-Qwen.cmd [--pull]
        exit /b 2
    )
    set "MATHINK_LOCAL_MODE=--pull"
)
if not "%~2"=="" exit /b 2
set "MATHINK_NODE=node.exe"
where node.exe >nul 2>nul
if errorlevel 1 goto fallback
node.exe -e "process.exit(Number(process.versions.node.split('.')[0]) >= 24 ? 0 : 1)" >nul 2>nul
if errorlevel 1 goto fallback
goto launch
:fallback
set "MATHINK_NODE=%USERPROFILE%\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe"
if not exist "%MATHINK_NODE%" (
    echo Node.js 24 is required.
    exit /b 1
)
:launch
pushd "%~dp0"
if errorlevel 1 exit /b 1
"%MATHINK_NODE%" scripts/local-qwen.mjs %MATHINK_LOCAL_MODE%
set "MATHINK_EXIT=%ERRORLEVEL%"
popd
exit /b %MATHINK_EXIT%
