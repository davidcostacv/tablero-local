@echo off
cd /d "%~dp0"
if "%PORT%"=="" set PORT=4747
where node >nul 2>nul || (echo Falta Node.js 20+: https://nodejs.org & pause & exit /b 1)
set OPEN_BROWSER=1
echo Iniciando el tablero en http://localhost:%PORT% ...
rem Si el puerto ya lo ocupa este mismo tablero, server.mjs solo abre el navegador y termina sin error.
rem Si lo ocupa otra cosa, imprime los comandos de PowerShell para liberarlo o cambiar de puerto.
node server.mjs
if errorlevel 1 pause
