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

REM Windows 에는 진짜 Python 이 없어도 python.exe 라는 껍데기가 있다.
REM 실행하면 Microsoft Store 를 열 뿐이라 where 로는 구분이 안 된다.
REM 실제로 버전을 물어봐서 대답하는지로 판별한다.
%PYEXE% -c "import sys" >nul 2>&1
if errorlevel 1 goto FAKE_PYTHON

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
if errorlevel 1 goto SHOW_REAL_ERROR
echo   설치가 끝났습니다.
echo.
goto RUN


REM 조용한 설치가 실패하면 무엇이 문제인지 알 수 없다.
REM 같은 명령을 조용하지 않게 한 번 더 돌려 진짜 오류를 화면에 남긴다.
:SHOW_REAL_ERROR
echo   ------------------------------------------
echo   설치가 실패했습니다. 원인을 확인합니다...
echo   ------------------------------------------
echo.
%PYEXE% -m pip install --disable-pip-version-check -r server/requirements.txt
echo.
goto INSTALL_FAILED


:INSTALL_FAILED
echo   ==========================================
echo     설치에 실패했습니다
echo   ==========================================
echo.
echo   바로 위에 영어로 나온 줄이 진짜 원인입니다.
echo   그 내용에 따라 아래를 확인해 보세요.
echo.
echo   [1] ProxyError, SSLError, timed out, Network is unreachable
echo       학교 네트워크가 파이썬 패키지 서버 pypi.org 를 막고 있습니다.
echo       휴대폰 핫스팟에 연결해 이 설치 한 번만 해 보세요.
echo       한 번 설치하면 그다음부터는 인터넷이 필요 없습니다.
echo.
echo   [2] Permission denied, Access is denied, WinError 5
echo       설치 권한이 없습니다. 이 파일에 마우스 오른쪽을 눌러
echo       관리자 권한으로 실행 을 골라 다시 해 보세요.
echo.
echo   [3] No module named pip
echo       Python 은 있는데 pip 가 빠져 있습니다.
echo       Python 을 다시 설치하되 설치 화면에서 pip 항목을 켜 주세요.
echo.
echo   ------------------------------------------
echo   설치가 계속 안 되면, 설치 없이 웹으로 쓰셔도 됩니다.
echo.
echo       https://choeeunsuk.github.io/hanmoa/
echo.
echo   PDF 병합 분할 압축 글자인식 등 대부분의 도구를
echo   그냥 브라우저에서 쓸 수 있습니다.
echo   한글 HWP 병합만 이 프로그램이 필요합니다.
echo   ------------------------------------------
echo.
pause
exit /b 1


:FAKE_PYTHON
echo   [문제] 진짜 Python 이 아니라 Windows 의 껍데기가 잡혔습니다.
echo.
echo   python 이라는 이름은 있지만 실행하면 Microsoft Store 만 열립니다.
echo   해결 방법은 둘 중 하나입니다.
echo.
echo   방법 1. python.org 에서 정식으로 설치하기  ^<권장^>
echo      곧 열리는 페이지에서 내려받아 설치하세요.
echo      설치 첫 화면 맨 아래
echo          Add python.exe to PATH
echo      를 반드시 체크해야 합니다.
echo.
echo   방법 2. 껍데기 끄기
echo      설정 을 열고 앱 실행 별칭 을 검색한 뒤
echo      python.exe 와 python3.exe 를 끄세요.
echo      그다음 방법 1 을 하시면 됩니다.
echo.
echo   설치가 끝나면 이 창으로 돌아와 아무 키나 누르세요.
echo.
start "" "https://www.python.org/downloads/"
pause >nul
echo.
echo   다시 확인합니다...
echo.
goto CHECK_PYTHON
