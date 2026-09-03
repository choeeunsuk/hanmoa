# -*- coding: utf-8 -*-
"""
한글이 띄우는 대화상자를 감시하고 대신 눌러 주는 파수꾼.

왜 필요한가:

한글을 자동으로 부리다 보면 사람에게 물어보는 창이 뜬다. 처음 실행할 때 나오는
등록 안내, 파일 접근을 허락하라는 보안 확인, 예전 판으로 만든 문서라는 알림
같은 것들이다. 그 창이 답을 기다리는 동안 COM 호출은 그대로 멈춘다.

더 나쁜 것은 그 창이 화면에 보이지 않을 때가 있다는 점이다. 사용자는 무엇이
기다리는지도 모른 채 진행 막대만 쳐다보게 된다.

그래서 변환이 도는 동안 이 파수꾼을 옆에 세워 둔다. 우리가 띄운 한글 프로세스의
창만 살펴보다가, 대화상자가 나타나면 무슨 창인지 적어 두고 기본 단추를 눌러 준다.
사람이 옆에 앉아 «확인»을 눌러 주는 셈이다.

우리가 만든 프로세스의 창만 건드린다. 사용자가 따로 열어 둔 한글 문서는
손대지 않는다.
"""
from __future__ import annotations

import threading
import time

import win32api
import win32con
import win32gui
import win32process

# 표준 Windows 대화상자의 창 클래스 이름.
DIALOG_CLASS = "#32770"

# 눌러도 되는 단추. 문서를 열고 저장하는 쪽으로 진행시키는 것들이다.
# «취소»나 «아니오»는 누르지 않는다. 변환을 스스로 포기해 버리기 때문이다.
SAFE_BUTTONS = ("확인", "예", "닫기", "계속", "무시", "OK", "Yes", "Close", "Continue")


def _windows_of(pid: int):
    """해당 프로세스가 가진 창들을 (핸들, 클래스, 제목) 으로 훑는다."""
    found = []

    def visit(hwnd, _):
        try:
            _, wpid = win32process.GetWindowThreadProcessId(hwnd)
            if wpid != pid:
                return True
            cls = win32gui.GetClassName(hwnd)
            title = win32gui.GetWindowText(hwnd)
            found.append((hwnd, cls, title))
        except Exception:
            pass
        return True

    try:
        win32gui.EnumWindows(visit, None)
    except Exception:
        pass
    return found


def _buttons_of(hwnd):
    """대화상자 안의 단추들을 (핸들, 글자) 로 모은다."""
    out = []

    def visit(child, _):
        try:
            if win32gui.GetClassName(child) == "Button":
                out.append((child, win32gui.GetWindowText(child)))
        except Exception:
            pass
        return True

    try:
        win32gui.EnumChildWindows(hwnd, visit, None)
    except Exception:
        pass
    return out


def _press(hwnd, button) -> None:
    """단추를 누른다. 창을 활성화하지 않고 메시지만 보낸다."""
    try:
        win32gui.SendMessage(button, win32con.BM_CLICK, 0, 0)
    except Exception:
        # 단추를 직접 못 누르면 대화상자에 확인 명령을 보낸다.
        try:
            win32gui.PostMessage(hwnd, win32con.WM_COMMAND, win32con.IDOK, 0)
        except Exception:
            pass


class DialogWatcher:
    """
    변환이 도는 동안 옆에서 대화상자를 지켜본다.

    with 문으로 감싸 쓰면 시작과 정리가 알아서 된다. 무엇을 눌렀는지는
    seen 에 쌓이므로, 변환이 실패했을 때 그 목록을 오류에 실어 보내면
    사용자가 원인을 바로 알 수 있다.
    """

    def __init__(self, pid: int, interval: float = 0.7, auto_click: bool = True):
        self.pid = pid
        self.interval = interval
        self.auto_click = auto_click
        self.seen: list[str] = []          # 사람이 읽을 기록
        self._stop = threading.Event()
        self._thread: threading.Thread | None = None

    def __enter__(self):
        self._thread = threading.Thread(target=self._loop, daemon=True)
        self._thread.start()
        return self

    def __exit__(self, *exc):
        self._stop.set()
        if self._thread:
            self._thread.join(timeout=3)
        return False

    def _loop(self) -> None:
        handled = set()
        while not self._stop.is_set():
            for hwnd, cls, title in _windows_of(self.pid):
                if cls != DIALOG_CLASS or hwnd in handled:
                    continue
                handled.add(hwnd)

                buttons = _buttons_of(hwnd)
                labels = [t for _, t in buttons if t.strip()]
                note = f"{title or '(제목 없음)'} [{', '.join(labels) or '단추 없음'}]"
                self.seen.append(note)
                # 발견하는 즉시 흘려 둔다. 타임아웃으로 이 프로세스가 끊겨도
                # 부모가 로그에서 무엇이 막았는지 읽어 갈 수 있어야 한다.
                try:
                    print(f"DLG|{note}", flush=True)
                except Exception:
                    pass

                if not self.auto_click:
                    continue
                for btn, text in buttons:
                    clean = text.replace("&", "").strip()
                    if any(clean.startswith(s) for s in SAFE_BUTTONS):
                        _press(hwnd, btn)
                        break
            self._stop.wait(self.interval)

    def report(self) -> str:
        """무엇을 만났는지 한 줄로 요약한다. 없으면 빈 문자열."""
        return " / ".join(self.seen)
