@echo off
setlocal
cd /d "%~dp0"
if not exist node_modules (
  call npm install
  if errorlevel 1 goto failed
)
call npm run build
if errorlevel 1 goto failed
call npm start
if errorlevel 1 goto failed
exit /b 0
:failed
echo Startup failed. Check the error above.
pause
exit /b 1
