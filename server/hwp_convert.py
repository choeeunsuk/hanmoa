# -*- coding: utf-8 -*-
"""
문서 하나를 PDF 로 바꾸는 독립 실행 스크립트. (한글 / MS Office 공용)

converter.py 가 이 파일을 별도 프로세스로 띄운다. 왜 굳이 프로세스를 나누는가:

한글 COM 은 종종 응답을 멈춘다. 보안 대화상자가 뜨거나, 글꼴 경고가 뜨거나,
문서가 손상됐을 때 그렇다. 창을 숨겨 두면 그 대화상자가 화면에 보이지도 않아
사용자는 영문도 모른 채 기다리게 된다. 같은 프로세스 안에서 COM 을 호출하면
그 멈춤을 밖에서 끊을 방법이 없다.

프로세스를 나누면 부모가 시간을 재다가 끊어 버릴 수 있다. 한글이 어떤 상태로
굳어 있든 확실하게 정리된다.

사용법:
    python hwp_convert.py <원본> <결과> [--visible]

성공하면 0, 실패하면 1 을 돌려주고 표준출력 마지막 줄에 사유를 적는다.
"""
from __future__ import annotations

import os
import sys


def convert_office(src: str, dst: str) -> tuple[bool, str]:
    """Word/Excel/PowerPoint 문서를 PDF 로 저장한다."""
    import win32com.client as wc

    ext = os.path.splitext(src)[1].lower()
    app = doc = None
    is_ppt = ext in (".ppt", ".pptx")

    # DispatchEx 로 우리 몫의 인스턴스를 띄운다. Dispatch 는 사용자가 열어 둔
    # Office 에 붙어 버려서, Quit() 할 때 남의 문서까지 닫힌다.
    try:
        if ext in (".doc", ".docx", ".rtf", ".odt", ".txt"):
            app = wc.DispatchEx("Word.Application")
            app.Visible = False
            app.DisplayAlerts = 0
            doc = app.Documents.Open(src, ReadOnly=True, AddToRecentFiles=False)
            doc.ExportAsFixedFormat(dst, 17)          # 17 = wdExportFormatPDF
        elif ext in (".xls", ".xlsx", ".csv"):
            app = wc.DispatchEx("Excel.Application")
            app.Visible = False
            app.DisplayAlerts = False
            doc = app.Workbooks.Open(src, ReadOnly=True, UpdateLinks=0)
            doc.ExportAsFixedFormat(0, dst)           # 0 = xlTypePDF
        elif is_ppt:
            app = wc.DispatchEx("PowerPoint.Application")
            doc = app.Presentations.Open(src, ReadOnly=True, WithWindow=False)
            doc.SaveAs(dst, 32)                       # 32 = ppSaveAsPDF
        else:
            return False, f"지원하지 않는 형식입니다: {ext}"
    except Exception as e:
        return False, (f"'{os.path.basename(src)}' 변환에 실패했습니다. "
                       f"Microsoft Office 가 설치되어 있는지 확인해 주세요. ({e})")
    finally:
        try:
            if doc is not None:
                doc.Close() if is_ppt else doc.Close(0)
        except Exception:
            pass
        try:
            if app is not None:
                app.Quit()
        except Exception:
            pass

    if not os.path.exists(dst):
        return False, f"'{os.path.basename(src)}' 의 PDF 결과가 만들어지지 않았습니다."
    return True, ""


def main() -> int:
    if len(sys.argv) < 3:
        print("ERR|사용법: hwp_convert.py <원본> <결과> [--visible]")
        return 2

    src, dst = sys.argv[1], sys.argv[2]
    visible = "--visible" in sys.argv[3:]

    # 오피스 문서는 한글을 거치지 않는다.
    if os.path.splitext(src)[1].lower() in (".doc", ".docx", ".rtf", ".odt", ".txt",
                                            ".xls", ".xlsx", ".csv", ".ppt", ".pptx"):
        ok, reason = convert_office(src, dst)
        print("OK|" if ok else f"ERR|{reason}")
        return 0 if ok else 1

    try:
        import win32com.client as wc
    except ImportError:
        print("ERR|파이썬용 Windows 연결 구성요소(pywin32)가 없습니다. start.bat 을 다시 실행해 주세요.")
        return 1

    try:
        hwp = wc.DispatchEx("HWPFrame.HwpObject")
    except Exception as e:
        print(f"ERR|한컴오피스(한글)를 불러오지 못했습니다. 한글이 설치되어 있는지 확인해 주세요. ({e})")
        return 1

    try:
        # 파일 접근 보안 대화상자를 없애는 모듈. 등록되어 있지 않은 PC 도 있어서
        # 실패해도 진행하되, 그때는 창을 띄워 사용자가 직접 답할 수 있게 한다.
        try:
            hwp.RegisterModule("FilePathCheckDLL", "FilePathCheckerModule")
        except Exception:
            pass

        if not visible:
            try:
                hwp.XHwpWindows.Item(0).Visible = False
            except Exception:
                pass

        # 반드시 3-인자 형식으로 부른다. 한 인자짜리 Open(path) 은 응답 없이 멈추고,
        # arg 문자열에 versionwarning 같은 미지원 옵션을 넣어도 똑같이 멈춘다.
        opened = hwp.Open(src, "", "forceopen:true")
        if opened is False:
            print(f"ERR|'{os.path.basename(src)}' 을(를) 열 수 없습니다. "
                  "손상되었거나 DRM(문서 보안)이 걸린 파일일 수 있습니다.")
            return 1

        if hwp.SaveAs(dst, "PDF", "") is False or not os.path.exists(dst):
            print(f"ERR|'{os.path.basename(src)}' 을(를) PDF 로 저장하지 못했습니다.")
            return 1

        print("OK|")
        return 0

    except Exception as e:
        print(f"ERR|변환 중 오류가 났습니다: {e}")
        return 1

    finally:
        try:
            hwp.Clear(1)          # 저장하지 않음 - 변경사항 확인 대화상자를 막는다
        except Exception:
            pass
        try:
            hwp.Quit()
        except Exception:
            pass


if __name__ == "__main__":
    sys.exit(main())
