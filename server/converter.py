# -*- coding: utf-8 -*-
"""
한모아 로컬 변환 엔진.

한글(HWP)과 MS Office 문서를 PDF로 변환한다. 두 제품 모두 Windows COM 자동화로
제어하는데, COM 객체는 동시 호출에 매우 취약하다. 그래서 모든 변환 작업을
전용 워커 스레드 하나에서 직렬로 처리한다(ConversionWorker).

한컴 자동화의 함정 두 가지를 여기서 처리한다:
  1. 파일 접근 보안 경고창 - RegisterModule 로 보안 모듈을 등록해야 무인 실행된다.
  2. 좀비 프로세스   - Quit() 후에도 Hwp.exe 가 남는 경우가 있어 강제로 정리한다.
"""
from __future__ import annotations

import os
import queue
import subprocess
import tempfile
import time
import sys
import threading
import traceback
import uuid
from dataclasses import dataclass, field
from typing import Callable, Optional

HWP_EXTS = {".hwp", ".hwpx", ".hml"}
WORD_EXTS = {".doc", ".docx", ".rtf", ".odt", ".txt"}
EXCEL_EXTS = {".xls", ".xlsx", ".csv"}
PPT_EXTS = {".ppt", ".pptx"}
PDF_EXTS = {".pdf"}
IMAGE_EXTS = {".png", ".jpg", ".jpeg", ".bmp", ".gif", ".tif", ".tiff", ".webp"}

SUPPORTED_EXTS = HWP_EXTS | WORD_EXTS | EXCEL_EXTS | PPT_EXTS | PDF_EXTS | IMAGE_EXTS


class ConversionError(Exception):
    """변환 실패. message 는 사용자에게 그대로 보여줄 한국어 문장이다."""


# --------------------------------------------------------------------------
# 개별 변환기 (반드시 워커 스레드 안에서만 호출할 것)
# --------------------------------------------------------------------------

def _list_pids(image_name: str) -> set:
    """현재 실행 중인 해당 이름의 프로세스 PID 집합."""
    pids = set()
    try:
        out = subprocess.run(
            ["tasklist", "/FI", f"IMAGENAME eq {image_name}", "/FO", "CSV", "/NH"],
            capture_output=True, timeout=15,
        )
        text = out.stdout.decode("utf-8", errors="ignore")
        if not text.strip():
            text = out.stdout.decode("cp949", errors="ignore")
        for line in text.splitlines():
            parts = [c.strip().strip('"') for c in line.split('","')]
            if len(parts) >= 2 and parts[0].lower() == image_name.lower():
                try:
                    pids.add(int(parts[1]))
                except ValueError:
                    pass
    except Exception:
        pass
    return pids


def _kill_pids(pids) -> None:
    """지정한 PID만 정리한다. 실패는 무시한다."""
    for pid in pids:
        try:
            subprocess.run(["taskkill", "/F", "/PID", str(pid)],
                           capture_output=True, timeout=15)
        except Exception:
            pass


# 문서 하나를 바꾸는 데 허용할 시간(초).
#
# 한글을 처음 띄우는 데만 30초가 넘게 걸리기도 한다(실측). 느린 PC 나 백신이
# 검사 중인 PC 는 더 걸린다. 그래서 처음 한 번은 넉넉히 주고, 여러 건을 한
# 번에 맡길 때는 건수만큼 더해 준다.
HWP_TIMEOUT_SECONDS = 180
HWP_TIMEOUT_PER_FILE = 45


def security_module_registered() -> bool:
    """
    한글 자동화용 보안 모듈이 등록되어 있는지 본다.

    등록되어 있지 않으면 한글이 파일을 열 때마다 "파일 접근을 허용하시겠습니까"
    대화상자를 띄운다. 창을 숨겨 둔 채로는 그 상자가 화면에 보이지 않아
    사용자는 멈춘 줄도 모르고 기다리게 된다.
    """
    import winreg
    for path in (r"SOFTWARE\HNC\HwpCtrl\Modules",
                 r"SOFTWARE\HNC\HwpAutomation\Modules"):
        try:
            with winreg.OpenKey(winreg.HKEY_CURRENT_USER, path) as key:
                if winreg.QueryInfoKey(key)[1] > 0:      # 값이 하나라도 있으면 등록된 것
                    return True
        except OSError:
            continue
    return False


def hwp_batch_to_pdf(pairs, timeout: int | None = None, on_progress=None) -> None:
    """
    한글 문서 여러 개를 한 번에 PDF 로 만든다.

    한글을 한 번만 띄워 전부 처리하므로, 파일마다 새로 띄우는 것보다 훨씬 빠르다.
    첫 문서에서 30초 넘게 걸리던 것이 두 번째부터는 몇 초로 줄어든다.

    pairs 는 [(원본, 결과), ...] 이고, on_progress(순번, 파일명) 이 있으면
    문서를 하나 시작할 때마다 불러 준다.
    """
    import json

    if not pairs:
        return
    if timeout is None:
        timeout = HWP_TIMEOUT_SECONDS + HWP_TIMEOUT_PER_FILE * (len(pairs) - 1)

    job_fd, job_path = tempfile.mkstemp(prefix="hwpjobs_", suffix=".json")
    with os.fdopen(job_fd, "w", encoding="utf-8") as fh:
        json.dump([[src, dst] for src, dst in pairs], fh, ensure_ascii=False)

    try:
        _run_helper(None, None, timeout=timeout,
                    visible=not security_module_registered(),
                    batch=job_path, exe="Hwp.exe", on_progress=on_progress)
    finally:
        try:
            os.remove(job_path)
        except OSError:
            pass


def hwp_to_pdf(src: str, dst: str, timeout: int = HWP_TIMEOUT_SECONDS) -> None:
    """
    한글 문서(.hwp/.hwpx/.hml)를 PDF 로 저장한다.

    실제 변환은 hwp_convert.py 를 별도 프로세스로 띄워 맡긴다. 한글 COM 은
    대화상자 하나에도 영영 멈출 수 있는데, 같은 프로세스 안에서는 그 멈춤을
    끊을 방법이 없기 때문이다. 프로세스를 나누면 시간을 재다가 끊을 수 있다.
    """
    # 사용자가 이미 한글을 켜 둔 채로 작업할 수 있다. 그 창을 건드리면 안 되므로
    # 우리가 새로 만든 프로세스만 골라서 정리한다.
    # 보안 모듈이 없으면 대화상자가 뜬다. 숨겨 두면 답할 수도 없으니 창을 보여준다.
    _run_helper(src, dst, timeout=timeout, visible=not security_module_registered())


# 파일 형식별로, 변환할 때 새로 뜨는 프로그램의 실행 파일 이름.
# 타임아웃으로 끊었을 때 이 프로세스들이 좀비로 남아 쌓이므로 함께 정리한다.
_SPAWNED_EXE = {
    **{e: "Hwp.exe" for e in HWP_EXTS},
    **{e: "WINWORD.EXE" for e in WORD_EXTS},
    **{e: "EXCEL.EXE" for e in EXCEL_EXTS},
    **{e: "POWERPNT.EXE" for e in PPT_EXTS},
}


def _last_step_of(log_path: str):
    """로그에 적힌 마지막 진행 단계를 (순번, 파일명) 으로 돌려준다."""
    try:
        with open(log_path, encoding="utf-8", errors="replace") as fh:
            steps = [ln.strip() for ln in fh if ln.startswith("PRG|")]
    except OSError:
        return None
    if not steps:
        return None
    parts = steps[-1].split("|")
    if len(parts) >= 3:
        try:
            return (int(parts[1]), parts[2])
        except ValueError:
            return None
    return None


def _pump_progress(log_path: str, reported: int, on_progress) -> int:
    """로그에 새로 생긴 PRG| 줄을 읽어 진행 상황을 알린다."""
    try:
        with open(log_path, encoding="utf-8", errors="replace") as fh:
            steps = [ln.strip() for ln in fh if ln.startswith("PRG|")]
    except OSError:
        return reported
    for line in steps[reported:]:
        parts = line.split("|")
        if len(parts) >= 3:
            try:
                on_progress(int(parts[1]), parts[2])
            except Exception:
                pass
    return len(steps)


def _dialogs_from_log(log_path: str) -> str:
    """도우미가 남긴 로그에서 대화상자 기록만 뽑아 온다."""
    try:
        with open(log_path, encoding="utf-8", errors="replace") as fh:
            found = [ln[4:].strip() for ln in fh if ln.startswith("DLG|")]
    except OSError:
        return ""
    # 같은 창이 여러 번 잡혔을 수 있으니 순서를 지키며 중복만 걷어낸다.
    seen, out = set(), []
    for item in found:
        if item not in seen:
            seen.add(item)
            out.append(item)
    return " / ".join(out)


def _run_helper(src, dst, *, timeout: int, visible: bool,
                batch: str | None = None, exe: str | None = None,
                on_progress=None) -> None:
    """변환 도우미 프로세스를 띄우고, 시간을 재다가 넘기면 끊는다."""
    # 이 문서를 열 때 뜨는 프로그램만 정리 대상으로 삼는다. 이름으로 싸잡아
    # 죽이면 사용자가 편집 중이던 문서까지 닫히므로, 작업 전후 PID 를 견줘
    # 우리가 새로 만든 것만 고른다.
    if exe is None:
        exe = _SPAWNED_EXE.get(os.path.splitext(src)[1].lower(), "Hwp.exe")
    before = _list_pids(exe)

    helper = os.path.join(os.path.dirname(os.path.abspath(__file__)), "hwp_convert.py")
    cmd = [sys.executable, helper] + (["--batch", batch] if batch else [src, dst])
    if visible:
        cmd.append("--visible")

    # 자식의 출력을 파이프가 아니라 임시 파일로 받는다.
    #
    # capture_output=True 로 파이프를 쓰면 타임아웃 때 파이썬이 자식을 죽인 뒤
    # 파이프를 비우려고 기다리는데, 자식이 띄운 Hwp.exe 가 그 파이프를 물고 있으면
    # 영영 끝나지 않는다. 타임아웃을 걸어 둔 의미가 사라진다(실측).
    # 파일로 받으면 비울 파이프 자체가 없어 이 교착이 생기지 않는다.
    log_fd, log_path = tempfile.mkstemp(prefix="hwpconv_", suffix=".log")
    os.close(log_fd)

    try:
        with open(log_path, "wb") as sink:
            proc = subprocess.Popen(cmd, stdout=sink, stderr=subprocess.STDOUT,
                                    stdin=subprocess.DEVNULL)
            # 도우미가 로그에 흘리는 PRG| 줄을 읽어 진행 상황을 알린다.
            # 파이프를 쓰면 타임아웃 때 교착이 생기므로 파일을 훔쳐본다.
            deadline = time.monotonic() + timeout
            reported = 0
            last_step = None
            while proc.poll() is None:
                if time.monotonic() > deadline:
                    proc.kill()
                    raise subprocess.TimeoutExpired(cmd, timeout)
                if on_progress:
                    new_count = _pump_progress(log_path, reported, on_progress)
                    if new_count == reported and last_step:
                        # 새 소식이 없어도 같은 단계를 다시 알려 경과 시간이
                        # 화면에서 계속 올라가게 한다.
                        try:
                            on_progress(*last_step)
                        except Exception:
                            pass
                    elif new_count > reported:
                        last_step = _last_step_of(log_path)
                    reported = new_count
                time.sleep(0.4)
            if on_progress:
                _pump_progress(log_path, reported, on_progress)
        returncode = proc.returncode
    except subprocess.TimeoutExpired:
        _kill_pids(_list_pids(exe) - before)
        # 일괄 처리 중이면 마지막으로 손대던 파일 이름을 쓴다.
        # "한글 문서" 라고만 하면 어느 파일이 문제인지 알 수 없다.
        last = _last_step_of(log_path)
        name = os.path.basename(src) if src else (last[1] if last else "한글 문서")
        # 도우미가 남긴 기록에서 어떤 창이 막았는지 건져낸다.
        blocking = _dialogs_from_log(log_path)
        if visible:
            # 보안 모듈이 없어 창을 띄운 경우다. 대화상자에 막혔을 가능성이 크다.
            msg = [
                f"'{name}' 변환이 {timeout}초를 넘겨 중단했습니다.",
                "한글 창에 확인 대화상자가 떠 있었을 수 있습니다.",
                "화면에 한글 창이 보이면 그 상자에 답한 뒤 다시 시도해 주세요.",
            ]
        else:
            msg = [
                f"'{name}' 변환이 {timeout}초를 넘겨 중단했습니다.",
                "프로그램이 응답하지 않는 상태이거나 문서가 너무 큽니다.",
            ]
        if blocking:
            msg.append("")
            msg.append("한글이 띄운 창: " + blocking)
        msg.append("사용설명서의 '변환이 멈출 때' 항목을 봐 주세요.")
        raise ConversionError(chr(10).join(msg))
    finally:
        # 성공하든 실패하든 우리가 띄운 프로그램은 반드시 정리한다.
        _kill_pids(_list_pids(exe) - before)

    try:
        out = open(log_path, encoding="utf-8", errors="replace").read().strip()
    except OSError:
        out = ""
    finally:
        try:
            os.remove(log_path)
        except OSError:
            pass

    last = out.splitlines()[-1] if out else ""

    if returncode != 0 or not last.startswith("OK|"):
        reason = last.split("|", 1)[1] if "|" in last else ""
        if not reason:
            reason = "알 수 없는 오류"
        raise ConversionError(reason)

    if dst and not os.path.exists(dst):
        raise ConversionError(f"'{os.path.basename(src)}' 의 PDF 결과가 만들어지지 않았습니다.")


def office_to_pdf(src: str, dst: str, timeout: int = HWP_TIMEOUT_SECONDS) -> None:
    """
    Word/Excel/PowerPoint 문서를 PDF 로 저장한다.

    한글과 마찬가지로 별도 프로세스에 맡긴다. Office COM 도 복구 대화상자나
    글꼴 경고에 막혀 멈출 수 있고, 창을 숨겨 둔 상태에서는 그 상자가 보이지
    않아 사용자는 끝없이 기다리게 된다.
    """
    _run_helper(src, dst, timeout=timeout, visible=False)


def image_to_pdf(src: str, dst: str) -> None:
    """이미지 한 장을 페이지 한 장짜리 PDF로 만든다."""
    import pymupdf

    doc = pymupdf.open()
    try:
        img = pymupdf.open(src)
        pdf_bytes = img.convert_to_pdf()
        img.close()
        src_pdf = pymupdf.open("pdf", pdf_bytes)
        doc.insert_pdf(src_pdf)
        src_pdf.close()
        doc.save(dst)
    finally:
        doc.close()


def any_to_pdf(src: str, dst: str) -> None:
    """확장자를 보고 알맞은 변환기로 넘긴다. 이미 PDF면 그대로 복사한다."""
    ext = os.path.splitext(src)[1].lower()
    if ext in PDF_EXTS:
        import shutil
        shutil.copyfile(src, dst)
    elif ext in HWP_EXTS:
        hwp_to_pdf(src, dst)
    elif ext in WORD_EXTS | EXCEL_EXTS | PPT_EXTS:
        office_to_pdf(src, dst)
    elif ext in IMAGE_EXTS:
        image_to_pdf(src, dst)
    else:
        raise ConversionError(f"지원하지 않는 파일 형식입니다: {ext}")
