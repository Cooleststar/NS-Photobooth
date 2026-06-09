@echo off
echo ================================
echo   NS Photobooth Launcher
echo ================================

echo.
echo [1/3] Starting Docker backend...
docker-compose up -d --build
if %errorlevel% neq 0 (
    echo ERROR: Docker failed to start. Make sure Docker Desktop is open.
    pause
    exit /b 1
)

echo.
echo [2/3] Waiting for backend to be ready...
timeout /t 8 /nobreak > nul

echo.
echo [3/3] Starting frontend...
cd client-ns-photobooth
call yarn dev
