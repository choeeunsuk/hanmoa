# -*- coding: utf-8 -*-
"""사용설명서.html 을 PDF 로 굽는다.

설명서를 고칠 때마다 손으로 인쇄해 저장하면 언젠가는 HTML 과 PDF 가 어긋난다.
그래서 굽는 방법을 여기 적어 둔다. 고친 뒤에는 이 파일만 실행하면 된다.

    python tools/build_manual.py

새 라이브러리를 깔게 하지 않으려고 이미 깔려 있는 브라우저를 쓴다.
Windows 라면 Edge 가 반드시 있고, 없으면 Chrome 을 찾는다.
"""
from __future__ import annotations

import os
import shutil
import subprocess
import sys
import tempfile
import time

HERE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SRC = os.path.join(HERE, "docs", "사용설명서.html")
DST = os.path.join(HERE, "docs", "한모아_사용설명서.pdf")

BROWSERS = (
    r"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe",
    r"C:\Program Files\Microsoft\Edge\Application\msedge.exe",
    r"C:\Program Files\Google\Chrome\Application\chrome.exe",
    r"C:\Program Files (x86)\Google\Chrome\Application\chrome.exe",
)


def ascii_base() -> str:
    """영문 이름만으로 된 작업 폴더 자리를 고른다.

    보통 쓰는 임시 폴더는 사용자 이름을 품고 있어서, 한글 이름을 쓰는 PC 에서는
    그 자체가 한글 경로가 된다. 브라우저가 조용히 실패하는 원인이 이것이다.
    """
    for base in (os.environ.get("TEMP", ""), HERE, "C:/"):
        if base and base.isascii() and os.path.isdir(base):
            return base
    os.makedirs("C:/HanmoaBuild", exist_ok=True)
    return "C:/HanmoaBuild"


def find_browser() -> str | None:
    for path in BROWSERS:
        if os.path.exists(path):
            return path
    return None


def main() -> int:
    if not os.path.exists(SRC):
        print(f"원본이 없습니다: {SRC}")
        return 1

    browser = find_browser()
    if not browser:
        print("Edge 나 Chrome 을 찾지 못했습니다.")
        return 1

    # 한글이 든 경로를 그대로 주면 브라우저가 조용히 아무것도 안 만든다(실측).
    # 그래서 영문 이름의 임시 폴더에서 굽고, 다 된 것을 제자리에 가져다 놓는다.
    work = tempfile.mkdtemp(prefix="hanmoa_manual_", dir=ascii_base())
    try:
        src_copy = os.path.join(work, "manual.html")
        out_pdf = os.path.join(work, "manual.pdf")
        shutil.copyfile(SRC, src_copy)

        # 종이 크기와 여백은 HTML 안의 @page 규칙을 따른다. 머리말/꼬리말은 끈다.
        # 사용자 프로필을 건드리지 않도록 임시 프로필을 쓴다.
        cmd = [
            browser,
            "--headless",
            "--disable-gpu",
            "--user-data-dir=" + os.path.join(work, "profile"),
            "--no-pdf-header-footer",
            "--print-to-pdf=" + out_pdf,
            "--virtual-time-budget=10000",
            "file:///" + src_copy.replace(chr(92), "/"),
        ]
        t0 = time.time()
        r = subprocess.run(cmd, capture_output=True, timeout=180)

        # 브라우저 명령은 그림을 다 그리기 전에 먼저 돌아온다. 실제 작업은
        # 뒤에 남은 프로세스가 마저 한다. 그래서 되돌아온 값이 아니라
        # 파일이 생겼는지를 보고, 크기가 더 늘지 않을 때까지 기다린다.
        size = -1
        for _ in range(120):
            time.sleep(0.5)
            if os.path.exists(out_pdf):
                now = os.path.getsize(out_pdf)
                if now > 0 and now == size:
                    break
                size = now

        if not os.path.exists(out_pdf) or os.path.getsize(out_pdf) == 0:
            sys.stderr.write(r.stderr.decode("utf-8", "ignore"))
            print("PDF 가 만들어지지 않았습니다.")
            return 1

        shutil.copyfile(out_pdf, DST)
        print(f"만들었습니다: {DST}")
        print(f"  {os.path.getsize(DST):,} bytes · {time.time() - t0:.1f}초")
        return 0
    finally:
        shutil.rmtree(work, ignore_errors=True)


if __name__ == "__main__":
    sys.exit(main())
