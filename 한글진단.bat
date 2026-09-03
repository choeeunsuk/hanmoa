@echo off
chcp 949 >nul
title 한모아 - 한글 변환 진단
cd /d "%~dp0"

echo.
echo   한글 변환이 어디서 막히는지 찾습니다.
echo   진행 중 한글 창이 뜨면 그대로 두고 지켜보세요.
echo.

set PYEXE=
where python >nul 2>&1
if errorlevel 1 goto TRY_PY
python -c "import sys" >nul 2>&1
if errorlevel 1 goto TRY_PY
set PYEXE=python
goto RUN

:TRY_PY
where py >nul 2>&1
if errorlevel 1 goto NOPY
set PYEXE=py
goto RUN

:NOPY
echo   [문제] 쓸 수 있는 Python 을 찾지 못했습니다.
echo          먼저 start.bat 을 실행해 Python 을 설치하세요.
echo.
pause
exit /b 1

:RUN
REM 검사할 한글 파일을 이 배치에 끌어다 놓으면 그 파일로 검사한다.
%PYEXE% server\hwp_probe.py %1

echo.
echo   ------------------------------------------
echo   위 내용을 캡처해서 보내주시면 원인을 짚어 드립니다.
echo   마지막으로 찍힌 줄이 멈춘 자리입니다.
echo.
pause
