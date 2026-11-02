@echo off
chcp 65001 >nul
cd /d "%~dp0"

if not exist node_modules (
  echo [TokenPanel] 首次运行，正在安装依赖，请稍候...
  call npm install
  if errorlevel 1 goto :error
)

echo [TokenPanel] 启动看板...
call npm start
if errorlevel 1 goto :error
exit /b 0

:error
echo.
echo [TokenPanel] 启动失败，请查看上方错误信息。
pause
exit /b 1
