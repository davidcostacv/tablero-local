@echo off
setlocal
set "DEST=%USERPROFILE%\.claude\skills\dashboard"
if not exist "%DEST%" mkdir "%DEST%"
copy /Y "%~dp0skills\dashboard\SKILL.md" "%DEST%\SKILL.md" >nul || (echo No se pudo copiar SKILL.md & pause & exit /b 1)
echo %~dp0> "%DEST%\repo-path.txt"
echo Skill instalada en %DEST%
echo Repo: %~dp0
pause
