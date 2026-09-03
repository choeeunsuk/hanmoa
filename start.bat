@echo off
chcp 65001 >nul
title 한모아 (Hanmoa) 로컬 엔진
cd /d "%~dp0"

set PORT=8765

echo.
echo   ============================================
echo     한모아 로컬 엔진
echo   ============================================
echo.
echo   이 창은 켜 두세요. 창을 닫으면 엔진이 꺼집니다.
echo   인터넷 연결은 필요하지 않습니다. 내 컴퓨터 안에서만 돕니다.
echo.

where python >nul 2>&1
if errorlevel 1 (
    echo   [문제] Python을 찾을 수 없습니다.
    echo.
    echo   https://www.python.org/downloads/ 에서 설치한 뒤
    echo   설치 화면의 "Add Python to PATH" 를 반드시 체크해 주세요.
    echo.
    pause
    exit /b 1
)

REM 이미 켜져 있으면 두 번 띄우지 않는다.
netstat -ano | findstr ":%PORT%" | findstr "LISTENING" >nul 2>&1
if not errorlevel 1 (
    echo   이미 실행 중입니다. 브라우저를 엽니다.
    echo.
    echo     http://localhost:%PORT%
    echo.
    start "" "http://localhost:%PORT%"
    echo   이 창은 닫으셔도 됩니다.
    pause
    exit /b 0
)

REM 필요한 구성요소가 없을 때만 설치한다.
python -c "import fastapi, uvicorn, pypdf, pymupdf, pdf2docx, openpyxl, pptx, multipart" >nul 2>&1
if errorlevel 1 (
    echo   처음 실행이라 필요한 구성요소를 설치합니다. 2~3분 걸립니다...
    echo   - 이때만 인터넷이 필요합니다
    echo.
    python -m pip install --disable-pip-version-check -q -r server/requirements.txt
    if errorlevel 1 (
        echo.
        echo   [문제] 설치에 실패했습니다. 인터넷 연결을 확인해 주세요.
        echo.
        pause
        exit /b 1
    )
    echo   설치가 끝났습니다.
    echo.
)

echo   준비되었습니다. 브라우저가 곧 열립니다.
echo.
echo     http://localhost:%PORT%
echo.
echo   브라우저가 안 열리면 위 주소를 직접 입력하세요.
echo   ------------------------------------------
echo.

set HANMOA_PORT=%PORT%
python server/main.py

echo.
echo   엔진이 종료되었습니다.
pause
