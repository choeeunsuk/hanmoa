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

REM 이미 켜져 있으면 Python 여부와 상관없이 브라우저만 연다.
netstat -ano | findstr ":%PORT%" | findstr "LISTENING" >nul 2>&1
if not errorlevel 1 goto ALREADY_RUNNING

:CHECK_PYTHON
REM PC마다 Python 이 "python" 또는 "py" 명령으로 다르게 깔려 있어 둘 다 확인한다.
set PYEXE=
where python >nul 2>&1
if not errorlevel 1 set PYEXE=python
if not defined PYEXE (
    where py >nul 2>&1
    if not errorlevel 1 set PYEXE=py
)
if not defined PYEXE goto NEED_PYTHON

REM 필요한 구성요소가 없을 때만 설치한다.
%PYEXE% -c "import fastapi, uvicorn, pypdf, pymupdf, pdf2docx, openpyxl, pptx, multipart" >nul 2>&1
if errorlevel 1 goto INSTALL_DEPS

:RUN
echo   준비되었습니다. 브라우저가 곧 열립니다.
echo.
echo     http://localhost:%PORT%
echo.
echo   브라우저가 안 열리면 위 주소를 직접 입력하세요.
echo   ------------------------------------------
echo.

set HANMOA_PORT=%PORT%
%PYEXE% server/main.py

echo.
echo   엔진이 종료되었습니다.
pause
exit /b 0


:ALREADY_RUNNING
echo   이미 실행 중입니다. 브라우저를 엽니다.
echo.
echo     http://localhost:%PORT%
echo.
start "" "http://localhost:%PORT%"
echo   이 창은 닫으셔도 됩니다.
pause
exit /b 0


REM 안내문은 반드시 if 블록 바깥에 둔다.
REM 괄호가 든 문장을 if ( ) 안에서 echo 하면 cmd 가 블록을 잘못 끊어
REM 문장 일부를 명령으로 실행하려 든다. 실제로 그렇게 깨졌었다.
:NEED_PYTHON
echo   [처음 실행] 이 컴퓨터에는 Python 이 설치되어 있지 않습니다.
echo   한모아를 돌리려면 한 번만 설치하면 됩니다.
echo.
echo   1. 지금 열리는 페이지에서 노란색 Download Python 버튼을 누르세요.
echo   2. 내려받은 설치 파일을 실행하세요.
echo   3. 설치 첫 화면 맨 아래의
echo         Add python.exe to PATH
echo      를 반드시 체크한 뒤 Install Now 를 누르세요.
echo      ^<^< 이 체크를 놓치면 처음부터 다시 설치해야 합니다 ^>^>
echo   4. 설치가 끝나면 이 창으로 돌아와 아무 키나 누르세요.
echo      이 창은 닫지 않아도 됩니다.
echo.
start "" "https://www.python.org/downloads/"
pause >nul
echo.
echo   다시 확인합니다...
echo.
goto CHECK_PYTHON


:INSTALL_DEPS
echo   처음 실행이라 필요한 구성요소를 설치합니다. 2~3분 걸립니다...
echo   이때만 인터넷이 필요합니다.
echo.
%PYEXE% -m pip install --disable-pip-version-check -q -r server/requirements.txt
if errorlevel 1 goto INSTALL_FAILED
echo   설치가 끝났습니다.
echo.
goto RUN


:INSTALL_FAILED
echo.
echo   [문제] 설치에 실패했습니다.
echo.
echo   - 인터넷 연결을 확인해 주세요.
echo   - 학교나 회사 네트워크라면 보안 프로그램이 파이썬 패키지 서버
echo     pypi.org 접속을 막고 있을 수 있습니다.
echo     그럴 때는 휴대폰 핫스팟에 연결해 이 설치 한 번만 해 보세요.
echo     한 번 설치하고 나면 그다음부터는 인터넷이 필요 없습니다.
echo.
pause
exit /b 1
