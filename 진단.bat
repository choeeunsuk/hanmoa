@echo off
chcp 949 >nul
title 한모아 진단
cd /d "%~dp0"

echo.
echo   ============================================
echo     한모아 진단 - 무엇이 막혔는지 알아봅니다
echo   ============================================
echo.

echo   [1] Python 위치
where python 2>nul
where py 2>nul
echo.

echo   [2] Python 이 실제로 대답하는지
REM 파이썬이 파일로 출력할 때는 UTF-8 을 쓰므로, 콘솔 코드페이지와 어긋나
REM 한글이 깨진다. 여기 라벨만 영문으로 두면 어떤 환경에서도 읽을 수 있다.
python -c "import sys; print('   exe :', sys.executable); print('   ver :', sys.version)" 2>&1
echo.

echo   [3] pip 상태
python -m pip --version 2>&1
echo.

echo   [4] 패키지 서버 접속 시험
echo   ------------------------------------------
python -m pip download fastapi --no-deps --dest "%TEMP%\hanmoa_netcheck" 2>&1
echo   ------------------------------------------
echo.

echo   위 [4] 결과를 확인하세요.
echo.
echo   Saved 또는 Downloading 이 보이면  ^-^> 네트워크는 정상입니다.
echo   ProxyError SSLError timed out 이 보이면  ^-^> 학교 방화벽이 막고 있습니다.
echo                                              휴대폰 핫스팟으로 시도하세요.
echo   Permission denied 가 보이면  ^-^> 관리자 권한으로 다시 실행하세요.
echo.
echo   이 화면을 캡처해서 보여주시면 정확히 짚어 드릴 수 있습니다.
echo.
pause
