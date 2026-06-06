@echo off
title Sunny Capitals
where node >nul 2>nul
if %errorlevel% neq 0 (
    echo.
    echo  Node.js is not installed.
    echo  Please download it from https://nodejs.org ^(LTS version^)
    echo  Then run this file again.
    echo.
    pause
    exit /b
)
:start
echo Starting Sunny Capitals...
node server.js
if %errorlevel% equ 0 (
    echo Restarting with new config...
    timeout /t 1 /nobreak >nul
    goto start
)
pause
