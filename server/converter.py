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


def hwp_to_pdf(src: str, dst: str) -> None:
    """한글 문서(.hwp/.hwpx/.hml)를 PDF로 저장한다."""
    import win32com.client as wc

    # 사용자가 이미 한글을 켜 둔 채로 작업할 수 있다. 그 창을 건드리면 안 되므로
    # 우리 몫의 인스턴스를 따로 띄우고(DispatchEx), 정리할 때도 우리가 만든
    # 프로세스만 골라서 닫는다.
    before = _list_pids("Hwp.exe")

    hwp = None
    try:
        hwp = wc.DispatchEx("HWPFrame.HwpObject")
    except Exception as e:
        raise ConversionError(
            "한컴오피스(한글)를 찾을 수 없습니다. 한글이 설치된 Windows PC에서 실행해 주세요."
        ) from e

    try:
        # 파일 접근 보안 경고창을 없앤다. 이게 없으면 변환이 대화상자에서 멈춘다.
        try:
            hwp.RegisterModule("FilePathCheckDLL", "FilePathCheckerModule")
        except Exception:
            pass  # 모듈이 없어도 열리는 환경이 있으므로 계속 진행한다.

        try:
            hwp.XHwpWindows.Item(0).Visible = False
        except Exception:
            pass

        # 반드시 3-인자 형식으로 부른다. hwp.Open(path) 한 인자짜리는 응답 없이 멈추고,
        # arg 문자열에 versionwarning 같은 미지원 옵션을 넣어도 똑같이 멈춘다.
        # 형식 인자는 빈 문자열로 두어 .hwp/.hwpx/.hml 을 자동 판별하게 한다.
        opened = hwp.Open(src, "", "forceopen:true")
        if opened is False:
            raise ConversionError(
                f"'{os.path.basename(src)}' 파일을 열 수 없습니다. "
                "손상되었거나 DRM(문서 보안)이 걸린 파일일 수 있습니다."
            )

        if hwp.SaveAs(dst, "PDF", "") is False or not os.path.exists(dst):
            raise ConversionError(f"'{os.path.basename(src)}' 을(를) PDF로 변환하지 못했습니다.")
    finally:
        if hwp is not None:
            try:
                hwp.Clear(1)  # 저장 안 함 - 변경사항 확인 대화상자를 막는다.
            except Exception:
                pass
            try:
                hwp.Quit()
            except Exception:
                pass
        # Quit() 후에도 남는 경우가 있다. 이번에 새로 생긴 것만 정리한다.
        _kill_pids(_list_pids("Hwp.exe") - before)


def office_to_pdf(src: str, dst: str) -> None:
    """Word/Excel/PowerPoint 문서를 PDF로 저장한다."""
    import win32com.client as wc

    ext = os.path.splitext(src)[1].lower()
    app = doc = None

    # Dispatch 는 이미 떠 있는 Office 에 붙는다. 그 상태에서 Quit() 하면 사용자가
    # 편집 중이던 문서까지 닫히므로, 반드시 DispatchEx 로 별도 인스턴스를 쓴다.

    try:
        if ext in WORD_EXTS:
            app = wc.DispatchEx("Word.Application")
            app.Visible = False
            app.DisplayAlerts = 0
            doc = app.Documents.Open(src, ReadOnly=True, AddToRecentFiles=False)
            doc.ExportAsFixedFormat(dst, 17)  # 17 = wdExportFormatPDF
        elif ext in EXCEL_EXTS:
            app = wc.DispatchEx("Excel.Application")
            app.Visible = False
            app.DisplayAlerts = False
            doc = app.Workbooks.Open(src, ReadOnly=True, UpdateLinks=0)
            doc.ExportAsFixedFormat(0, dst)  # 0 = xlTypePDF
        elif ext in PPT_EXTS:
            app = wc.DispatchEx("PowerPoint.Application")
            doc = app.Presentations.Open(src, ReadOnly=True, WithWindow=False)
            doc.SaveAs(dst, 32)  # 32 = ppSaveAsPDF
        else:
            raise ConversionError(f"지원하지 않는 형식입니다: {ext}")
    except ConversionError:
        raise
    except Exception as e:
        raise ConversionError(
            f"'{os.path.basename(src)}' 변환에 실패했습니다. "
            "Microsoft Office가 설치되어 있는지 확인해 주세요."
        ) from e
    finally:
        try:
            if doc is not None:
                doc.Close(0) if ext not in PPT_EXTS else doc.Close()
        except Exception:
            pass
        try:
            if app is not None:
                app.Quit()
        except Exception:
            pass

    if not os.path.exists(dst):
        raise ConversionError(f"'{os.path.basename(src)}' 의 PDF 결과가 생성되지 않았습니다.")


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
