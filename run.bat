@echo off
setlocal enabledelayedexpansion
title Granads Sortir Foto
cd /d "%~dp0"

echo ========================================================
echo               GRANADS SORTIR FOTO
echo ========================================================
echo.

:: Cek apakah port 3000 sedang terpakai
netstat -ano | findstr /R /C:":3000 .*LISTENING" >nul 2>&1
if not errorlevel 1 (
    echo [INFO] Port 3000 sedang terpakai. Melepaskan port 3000...
    for /f "tokens=5" %%a in ('netstat -ano ^| findstr /R /C:":3000 .*LISTENING"') do (
        taskkill /F /PID %%a >nul 2>&1
    )
    timeout /t 1 /nobreak >nul
)

echo [1/2] Membuka web di browser...
start "" "http://localhost:3000/owner"

echo [2/2] Menjalankan server di CMD...
echo URL Owner: http://localhost:3000/owner
echo URL Client: http://localhost:3000/client.html
echo URL Portofolio: http://localhost:3000/portfolio
echo.
echo Log server akan tampil di bawah ini.
echo Tekan Ctrl+C untuk mematikan server.
echo ========================================================
echo.

npm start
pause
