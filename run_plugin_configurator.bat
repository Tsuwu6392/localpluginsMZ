@echo off
setlocal
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
    echo Node.js was not found on your PATH.
    echo Install it from https://nodejs.org and try again.
    echo.
    pause
    exit /b 1
)

node plugin_configurator.js
if errorlevel 1 (
    echo.
    echo Plugin Configurator exited with an error - see above.
    pause
)
