@echo off
setlocal DisableDelayedExpansion
set "MATHINK_LAN="
if /i "%~1"=="-Lan" set "MATHINK_LAN=--lan"
if /i "%~1"=="--lan" set "MATHINK_LAN=--lan"
if not "%~1"=="" if not defined MATHINK_LAN (
    echo Usage: Start-MathInk.cmd [-Lan]
    exit /b 2
)
if not "%~2"=="" (
    echo Usage: Start-MathInk.cmd [-Lan]
    exit /b 2
)
set "MATHINK_NODE=node.exe"
where node.exe >nul 2>nul
if errorlevel 1 goto fallback
node.exe -e "process.exit(Number(process.versions.node.split('.')[0]) >= 24 ? 0 : 1)" >nul 2>nul
if errorlevel 1 goto fallback
goto launch
:fallback
set "MATHINK_NODE=%USERPROFILE%\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe"
if not exist "%MATHINK_NODE%" goto missingnode
"%MATHINK_NODE%" -e "process.exit(Number(process.versions.node.split('.')[0]) >= 24 ? 0 : 1)" >nul 2>nul
if errorlevel 1 goto missingnode
:launch
pushd "%~dp0"
if errorlevel 1 exit /b 1
set "MATHINK_WEB="
if exist "web\index.html" set "MATHINK_WEB=--web-root web"
"%MATHINK_NODE%" --env-file-if-exists=.env scripts/serve-preview.mjs %MATHINK_WEB% %MATHINK_LAN%
set "MATHINK_EXIT=%ERRORLEVEL%"
popd
exit /b %MATHINK_EXIT%
:missingnode
echo Node.js 24 is required. Install it, then try again.
exit /b 1
