# -*- coding: utf-8 -*-
"""
한글 변환이 어느 단계에서 막히는지 짚어 주는 진단기.

변환이 멈출 때 "어디서" 멈추는지 모르면 고칠 수가 없다. 이 스크립트는 변환에
필요한 일을 순서대로 하나씩 해 보면서, 각 단계를 시작하기 전에 먼저 화면에
적는다. 그래서 도중에 멈추더라도 마지막으로 찍힌 줄이 곧 범인이 된다.

각 단계에 시간 제한을 따로 두지는 않는다. 대신 사용자가 창을 보고 어디서
멈췄는지 알 수 있게 하고, 오래 걸리면 그대로 두었다가 창을 닫으면 된다.

사용법:
    python hwp_probe.py [검사할한글파일.hwp]

파일을 주지 않으면 한글로 빈 문서를 만들어 검사한다.
"""
from __future__ import annotations

import os
import sys
import time

try:
    sys.stdout.reconfigure(encoding="utf-8")
except Exception:
    pass

_t0 = time.time()


def step(msg: str) -> None:
    """단계를 시작하기 전에 먼저 적는다. 멈추면 이 줄이 마지막으로 남는다."""
    print(f"  [{time.time() - _t0:6.1f}s] {msg}", flush=True)


def ok(msg: str) -> None:
    print(f"           -> {msg}", flush=True)


def main() -> int:
    print()
    print("=" * 58)
    print("  한글 변환 진단 - 어디서 막히는지 찾습니다")
    print("=" * 58)
    print()

    # ── 1. 파이썬과 pywin32 ────────────────────────────
    step("파이썬 확인")
    ok(f"{sys.version.split()[0]}  ({sys.executable})")

    step("pywin32 불러오기")
    try:
        import win32com.client as wc
        import pythoncom
        ok("정상")
    except Exception as e:
        ok(f"실패: {e}")
        print()
        print("  [원인] pywin32 가 제대로 설치되지 않았습니다.")
        print("         start.bat 을 관리자 권한으로 다시 실행해 보세요.")
        return 1

    step("pywin32 부가 설치 상태 확인")
    try:
        import win32api
        dll = getattr(pythoncom, "__file__", "?")
        ok(f"pythoncom: {os.path.basename(dll)}")
    except Exception as e:
        ok(f"경고: {e}")

    # ── 2. 한글 COM ────────────────────────────────────
    step("한글 COM 개체 만들기 (여기서 멈추면 한글 자체 문제)")
    try:
        hwp = wc.DispatchEx("HWPFrame.HwpObject")
        ok("성공")
    except Exception as e:
        ok(f"실패: {e}")
        print()
        print("  [원인] 한글을 COM 으로 부를 수 없습니다.")
        print("         - 한컴오피스가 설치되어 있는지 확인하세요.")
        print("         - '한글 뷰어'만 설치된 경우 자동 변환이 되지 않습니다.")
        print("         - 컴퓨터를 다시 시작하면 풀리는 경우가 많습니다.")
        return 1

    step("한글 판본 확인")
    try:
        ver = str(hwp.Version)
        major = ver.split(",")[0].strip()
        names = {"7": "한글 2007", "8": "한글 2010", "9": "한글 2014",
                 "10": "한글 NEO / 2018", "11": "한글 2020", "12": "한컴오피스 2022"}
        ok(f"{ver}   ({names.get(major, '알 수 없는 판본')})")
    except Exception as e:
        ok(f"읽지 못함: {e}")

    step("설치 종류 확인 (뷰어인지 정식판인지)")
    try:
        import winreg
        path = None
        for root, key in ((winreg.HKEY_CURRENT_USER, r"SOFTWARE\HNC\Hwp\120\Path"),
                          (winreg.HKEY_LOCAL_MACHINE, r"SOFTWARE\WOW6432Node\HNC\Hwp")):
            try:
                with winreg.OpenKey(root, key) as k:
                    path = winreg.QueryValueEx(k, "")[0]
                    break
            except OSError:
                continue
        ok(path or "경로를 찾지 못함 (문제는 아닙니다)")
    except Exception as e:
        ok(f"확인 못함: {e}")

    # ── 3. 보안 모듈 ───────────────────────────────────
    step("보안 모듈 등록 (없으면 파일 열 때 확인창이 뜹니다)")
    try:
        r = hwp.RegisterModule("FilePathCheckDLL", "FilePathCheckerModule")
        ok(f"반환값 {r!r}")
    except Exception as e:
        ok(f"실패: {e}")

    step("등록된 보안 모듈 목록")
    try:
        import winreg
        found = []
        for key in (r"SOFTWARE\HNC\HwpCtrl\Modules", r"SOFTWARE\HNC\HwpAutomation\Modules"):
            try:
                with winreg.OpenKey(winreg.HKEY_CURRENT_USER, key) as k:
                    n = winreg.QueryInfoKey(k)[1]
                    for i in range(n):
                        name, val, _ = winreg.EnumValue(k, i)
                        found.append(f"{name}={val}")
            except OSError:
                continue
        ok(", ".join(found) if found else "없음  <- 확인창이 뜰 수 있습니다")
    except Exception as e:
        ok(f"확인 못함: {e}")

    # ── 4. 창 감시 시작 ────────────────────────────────
    watcher = None
    hwp_pid = None
    _windows_of = None
    step("한글 창 감시 시작")
    try:
        sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
        from dialog_watch import DialogWatcher
        from dialog_watch import _windows_of as _wo
        _windows_of = _wo
        import subprocess
        # 우리가 띄운 한글 PID 를 찾는다
        out = subprocess.run(["tasklist", "/FI", "IMAGENAME eq Hwp.exe", "/FO", "CSV", "/NH"],
                             capture_output=True, timeout=15)
        text = out.stdout.decode("utf-8", errors="ignore") or out.stdout.decode("cp949", errors="ignore")
        pids = []
        for line in text.splitlines():
            cols = [c.strip().strip('"') for c in line.split('","')]
            if len(cols) >= 2 and cols[0].lower() == "hwp.exe":
                try:
                    pids.append(int(cols[1]))
                except ValueError:
                    pass
        if pids:
            hwp_pid = pids[-1]
            watcher = DialogWatcher(hwp_pid)
            watcher.__enter__()
            ok(f"Hwp.exe PID {hwp_pid} 감시 중")
        else:
            ok("Hwp.exe 를 찾지 못함 (창 없이 도는 중일 수 있습니다)")
    except Exception as e:
        ok(f"감시 실패: {e}")

    # ── 5. 실제 변환 ───────────────────────────────────
    src = sys.argv[1] if len(sys.argv) > 1 else None
    made_temp = False

    if not src:
        # 문서를 새로 만드는 길은 판본마다 쓰는 명령이 달라 여기서 막힐 수 있다.
        # 진짜로 알고 싶은 것은 "사용자의 그 파일이 변환되는가" 이므로 파일을 받는다.
        print()
        print("  검사할 한글 파일을 지정해 주세요.")
        print("  한글진단.bat 위로 .hwp 파일을 끌어다 놓으면 그 파일로 검사합니다.")
        print()
        step("파일 없이 할 수 있는 확인만 마칩니다")
        ok("위 항목이 모두 정상이면 한글 연결 자체는 문제가 없습니다")

    if src and os.path.exists(src):
        ok("창은 문서를 연 뒤에 감춥니다 (미리 감추면 구버전에서 멈춥니다)")

        step(f"문서 열기: {os.path.basename(src)}")
        ok("확인창이 뜨면 감시자가 «DLG|» 로 알리고 대신 눌러 줍니다")
        # COM 개체는 만든 실에서만 쓸 수 있다. 다른 실로 넘기면
        # "다른 스레드를 위해 배열된 인터페이스" 오류가 난다(실측).
        # 그래서 여기서 그대로 열고, 창 감시는 감시자 실에 맡긴다.
        t_open = time.time()
        try:
            r = hwp.Open(src, "", "forceopen:true")
            ok(f"반환값 {r!r}  ({time.time() - t_open:.1f}초)")
        except Exception as e:
            ok(f"실패: {e}")
            r = False

        if r is not False:
            step("창 숨기기 (연 다음이라 안전합니다)")
            try:
                from hwp_convert import hide_window
                hide_window(hwp)
                ok("숨김")
            except Exception as e:
                ok(f"실패(무시 가능): {e}")

            dst = os.path.splitext(src)[0] + "_진단결과.pdf"
            step("PDF 로 저장 (판본마다 다른 방법을 차례로 시도합니다)")
            try:
                from hwp_convert import save_as_pdf
                saved, why = save_as_pdf(hwp, dst)
                if saved:
                    ok(f"성공 · {os.path.getsize(dst):,} bytes")
                    print()
                    print("  ===== 변환 성공 =====")
                    print(f"  결과: {dst}")
                else:
                    ok("모든 방법 실패")
                    print(f"             시도 결과: {why}")
                    print()
                    print("  [원인] 이 한글 판본이 자동 PDF 저장을 받지 않습니다.")
                    print("         한글에서 파일을 열어 «PDF로 저장하기» 가 되는지 확인해 보세요.")
                    print("         메뉴에 그 항목이 없다면 판본을 올려야 합니다.")
            except Exception as e:
                ok(f"실패: {e}")
    else:
        print()
        print("  검사할 한글 파일이 없어 변환 단계를 건너뜁니다.")
        print("  사용법: hwp_probe.py \"C:\\경로\\문서.hwp\"")

    # ── 정리 ───────────────────────────────────────────
    if watcher is not None:
        try:
            watcher.__exit__(None, None, None)
            if watcher.seen:
                print()
                print("  한글이 띄운 창:")
                for s in watcher.seen:
                    print(f"    - {s}")
            else:
                print()
                print("  한글이 띄운 창: 없음")
        except Exception:
            pass

    try:
        hwp.Clear(1)
        hwp.Quit()
    except Exception:
        pass
    if made_temp and src and os.path.exists(src):
        try:
            os.remove(src)
        except OSError:
            pass

    print()
    print(f"  총 {time.time() - _t0:.1f}초")
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except KeyboardInterrupt:
        print("\n  중단됨")
        sys.exit(1)
