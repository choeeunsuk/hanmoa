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

# 이 프로세스의 출력은 부모가 파일로 받아 읽는다. 윈도우 파이썬은 화면이 아닌
# 곳으로 내보낼 때 시스템 코드페이지(한국어 윈도우면 CP949)를 쓰는데, 부모는
# UTF-8 로 읽으므로 한글 파일명이 깨진다. 양쪽을 UTF-8 로 맞춘다.
try:
    sys.stdout.reconfigure(encoding="utf-8")
    sys.stderr.reconfigure(encoding="utf-8")
except Exception:
    pass


def hide_window(hwp) -> None:
    """
    한글 창을 감춘다. 문서를 연 다음에 불러야 한다.

    문서를 열기 전에 감추면 판본에 따라 Open 이 응답을 멈춘다(한글 10 세대에서
    실측). 창을 만들어야 문서를 띄울 수 있는데 미리 감춰 버리면 그 자리에서
    굳는 것으로 보인다. 그래서 열고 나서 감춘다. 잠깐 창이 비쳤다 사라진다.
    """
    try:
        hwp.XHwpWindows.Item(0).Visible = False
    except Exception:
        pass


def save_as_pdf(hwp, dst: str) -> tuple[bool, str]:
    """
    한글 문서를 PDF 로 저장한다. 판본마다 되는 방법이 달라 차례로 시도한다.

    판본에 따라 SaveAs 의 "PDF" 형식을 받아 주지 않는 경우가 있다(한글 10 세대
    등). 그럴 때는 파일 저장 동작(FileSaveAsPdf)을 직접 실행하는 길이 남아 있다.
    어느 쪽이 통하는지는 미리 알 수 없으므로 되는 것이 나올 때까지 해 본다.
    """
    tried = []

    # 1) 가장 흔한 길. 최신 판본은 이것으로 끝난다.
    try:
        r = hwp.SaveAs(dst, "PDF", "")
        if r is not False and os.path.exists(dst):
            return True, ""
        tried.append(f"SaveAs(PDF)={r!r}")
    except Exception as e:
        tried.append(f"SaveAs(PDF) 예외: {e}")

    # 2) 파일 저장 동작을 직접 실행한다. 구버전에서 통하는 경우가 있다.
    try:
        act = "FileSaveAsPdf"
        pset = hwp.HParameterSet.HFileOpenSave
        hwp.HAction.GetDefault(act, pset.HSet)
        pset.filename = dst
        pset.Format = "PDF"
        r = hwp.HAction.Execute(act, pset.HSet)
        if r is not False and os.path.exists(dst):
            return True, ""
        tried.append(f"HAction(FileSaveAsPdf)={r!r}")
    except Exception as e:
        tried.append(f"HAction(FileSaveAsPdf) 예외: {e}")

    # 3) 형식 이름을 다르게 적어 본다. 판본에 따라 받는 이름이 다르다.
    for fmt in ("PDF", "pdf", "HWPPDF"):
        try:
            r = hwp.SaveAs(dst, fmt, "")
            if r is not False and os.path.exists(dst):
                return True, ""
        except Exception:
            pass

    return False, " / ".join(tried)


def _hwp_pids() -> set:
    """지금 떠 있는 Hwp.exe 의 PID 들. 우리가 새로 만든 것을 가려내는 데 쓴다."""
    import subprocess
    pids = set()
    try:
        out = subprocess.run(
            ["tasklist", "/FI", "IMAGENAME eq Hwp.exe", "/FO", "CSV", "/NH"],
            capture_output=True, timeout=15,
        )
        text = out.stdout.decode("utf-8", errors="ignore") or ""
        if not text.strip():
            text = out.stdout.decode("cp949", errors="ignore")
        for line in text.splitlines():
            cols = [c.strip().strip(chr(34)) for c in line.split(chr(34) + "," + chr(34))]
            if len(cols) >= 2 and cols[0].lower() == "hwp.exe":
                try:
                    pids.add(int(cols[1]))
                except ValueError:
                    pass
    except Exception:
        pass
    return pids


def _dialog_note(watcher) -> str:
    """감시 중 만난 대화상자를 오류 뒤에 덧붙일 문구로 만든다."""
    if watcher is None or not watcher.seen:
        return ""
    return " / 한글이 띄운 창: " + watcher.report()


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


def run_batch(jobs, visible: bool) -> int:
    """
    한글을 한 번만 띄워 여러 문서를 차례로 PDF 로 만든다.

    jobs 는 [[원본, 결과], ...] 형태다. 한 건이라도 실패하면 그 자리에서
    멈추고 사유를 알린다. 병합에서는 한 장이 빠지면 결과가 틀리기 때문이다.
    """
    import win32com.client as wc

    before = _hwp_pids()
    try:
        hwp = wc.DispatchEx("HWPFrame.HwpObject")
    except Exception as e:
        print(f"ERR|한컴오피스(한글)를 불러오지 못했습니다. 한글이 설치되어 있는지 확인해 주세요. ({e})")
        return 1

    mine = _hwp_pids() - before
    watcher = None
    if mine:
        try:
            from dialog_watch import DialogWatcher
            watcher = DialogWatcher(next(iter(mine)))
            watcher.__enter__()
        except Exception:
            watcher = None

    try:
        try:
            hwp.RegisterModule("FilePathCheckDLL", "FilePathCheckerModule")
        except Exception:
            pass
        for i, pair in enumerate(jobs, start=1):
            src, dst = pair[0], pair[1]
            # 진행 상황을 흘려 둔다. 부모가 이걸 읽어 화면에 보여준다.
            print(f"PRG|{i}|{os.path.basename(src)}", flush=True)

            if hwp.Open(src, "", "forceopen:true") is False:
                print(f"ERR|'{os.path.basename(src)}' 을(를) 열 수 없습니다. "
                      "손상되었거나 DRM(문서 보안)이 걸린 파일일 수 있습니다."
                      + _dialog_note(watcher))
                return 1

            # 문서를 연 다음에 감춘다. 미리 감추면 구버전에서 Open 이 멈춘다.
            if not visible:
                hide_window(hwp)

            saved, why = save_as_pdf(hwp, dst)
            if not saved:
                print(f"ERR|'{os.path.basename(src)}' 을(를) PDF 로 저장하지 못했습니다. "
                      f"한글 판본이 이 방식을 받지 않는 것 같습니다. ({why})"
                      + _dialog_note(watcher))
                return 1

            # 다음 문서를 열기 전에 현재 문서를 비운다. 저장하지 않음(1).
            try:
                hwp.Clear(1)
            except Exception:
                pass

        print("OK|")
        return 0

    except Exception as e:
        print(f"ERR|변환 중 오류가 났습니다: {e}{_dialog_note(watcher)}")
        return 1

    finally:
        if watcher is not None:
            try:
                watcher.__exit__(None, None, None)
            except Exception:
                pass
        try:
            hwp.Clear(1)
        except Exception:
            pass
        try:
            hwp.Quit()
        except Exception:
            pass


def main() -> int:
    """
    인자 형태 두 가지:
        hwp_convert.py <원본> <결과> [--visible]        한 건
        hwp_convert.py --batch <목록.json> [--visible]  여러 건

    여러 건을 한 번에 받는 이유: 한글을 처음 띄우는 데만 30초가 걸리기도 한다.
    파일마다 새로 띄우면 그 값을 매번 치른다. 한 번 띄워 두고 여러 문서를
    연달아 처리하면 두 번째부터는 몇 초면 끝난다.
    """
    if len(sys.argv) < 3:
        print("ERR|사용법: hwp_convert.py <원본> <결과> [--visible]")
        return 2

    visible = "--visible" in sys.argv

    if sys.argv[1] == "--batch":
        import json
        try:
            with open(sys.argv[2], encoding="utf-8") as fh:
                jobs = json.load(fh)
        except Exception as e:
            print(f"ERR|변환 목록을 읽지 못했습니다: {e}")
            return 1
        return run_batch(jobs, visible)

    src, dst = sys.argv[1], sys.argv[2]

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

    before = _hwp_pids()
    try:
        hwp = wc.DispatchEx("HWPFrame.HwpObject")
    except Exception as e:
        print(f"ERR|한컴오피스(한글)를 불러오지 못했습니다. 한글이 설치되어 있는지 확인해 주세요. ({e})")
        return 1

    # 우리가 방금 띄운 한글 프로세스를 찾아 그 창만 감시한다.
    mine = _hwp_pids() - before
    watcher = None
    if mine:
        try:
            from dialog_watch import DialogWatcher
            watcher = DialogWatcher(next(iter(mine)))
            watcher.__enter__()
        except Exception:
            watcher = None

    try:
        # 파일 접근 보안 대화상자를 없애는 모듈. 등록되어 있지 않은 PC 도 있어서
        # 실패해도 진행하되, 그때는 창을 띄워 사용자가 직접 답할 수 있게 한다.
        try:
            hwp.RegisterModule("FilePathCheckDLL", "FilePathCheckerModule")
        except Exception:
            pass

        # 반드시 3-인자 형식으로 부른다. 한 인자짜리 Open(path) 은 응답 없이 멈추고,
        # arg 문자열에 versionwarning 같은 미지원 옵션을 넣어도 똑같이 멈춘다.
        opened = hwp.Open(src, "", "forceopen:true")
        if opened is False:
            print(f"ERR|'{os.path.basename(src)}' 을(를) 열 수 없습니다. "
                  "손상되었거나 DRM(문서 보안)이 걸린 파일일 수 있습니다."
                  + _dialog_note(watcher))
            return 1

        # 문서를 연 다음에 감춘다. 미리 감추면 구버전에서 Open 이 멈춘다.
        if not visible:
            hide_window(hwp)

        saved, why = save_as_pdf(hwp, dst)
        if not saved:
            print(f"ERR|'{os.path.basename(src)}' 을(를) PDF 로 저장하지 못했습니다. "
                  f"한글 판본이 이 방식을 받지 않는 것 같습니다. ({why})"
                  + _dialog_note(watcher))
            return 1

        print("OK|")
        return 0

    except Exception as e:
        print(f"ERR|변환 중 오류가 났습니다: {e}{_dialog_note(watcher)}")
        return 1

    finally:
        if watcher is not None:
            try:
                watcher.__exit__(None, None, None)
                # 무슨 창을 만났는지는 성공했더라도 기록으로 남긴다.
                if watcher.seen:
                    print(f"DLG|{watcher.report()}")
            except Exception:
                pass
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
