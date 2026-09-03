# -*- coding: utf-8 -*-
"""
한모아 로컬 백엔드.

브라우저만으로는 할 수 없는 일 - 한글(HWP)과 MS Office 문서를 PDF로 바꾸는 일 -
만 담당한다. 나머지 PDF 편집은 전부 프론트엔드가 브라우저 안에서 처리하므로
이 서버 없이도 앱의 대부분은 동작한다.

실행:  python main.py      →  http://localhost:8765
"""
from __future__ import annotations

import os
import sys
from typing import List, Optional

from fastapi import FastAPI, File, Form, HTTPException, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import exporters  # noqa: E402
from converter import SUPPORTED_EXTS  # noqa: E402
from worker import (  # noqa: E402
    STORE, make_export_job, make_html_job, make_merge_job, make_topdf_job,
)

WEB_DIR = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "web")
MAX_UPLOAD_MB = 200

app = FastAPI(title="Hanmoa Local Engine", docs_url=None, redoc_url=None)

# GitHub Pages 등 다른 출처에서 연 프론트엔드도 이 로컬 엔진에 붙을 수 있게 한다.
# 이 서버는 localhost 에만 바인딩되므로 외부에서 접근할 수 없다.
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)


def _probe_engines() -> dict:
    """어떤 변환 엔진을 실제로 쓸 수 있는지 확인해 프론트엔드에 알려준다."""
    import win32com.client as wc

    result = {}
    for key, prog_id in (
        ("hwp", "HWPFrame.HwpObject"),
        ("word", "Word.Application"),
        ("excel", "Excel.Application"),
        ("powerpoint", "PowerPoint.Application"),
    ):
        try:
            import winreg
            winreg.OpenKey(winreg.HKEY_CLASSES_ROOT, prog_id).Close()
            result[key] = True
        except Exception:
            result[key] = False
    return result


@app.get("/api/health")
def health():
    """프론트엔드가 로컬 엔진의 존재를 감지하는 데 쓰는 엔드포인트."""
    try:
        engines = _probe_engines()
    except Exception:
        engines = {"hwp": False, "word": False, "excel": False, "powerpoint": False}
    # 2차 도구가 기대는 외부 프로그램도 함께 알려준다.
    engines["browser"] = exporters.find_browser() is not None
    engines["ghostscript"] = exporters.find_ghostscript() is not None
    engines["export"] = True          # PDF -> Word/Excel/PPT 는 파이썬만으로 된다

    return {
        "ok": True,
        "name": "Hanmoa Local Engine",
        "version": "2.0",
        "platform": sys.platform,
        "engines": engines,
        "accepts": sorted(SUPPORTED_EXTS),
    }


def fix_encoding(text: str) -> str:
    """
    멀티파트 본문 안의 한글 파일명을 되살린다.

    브라우저는 파일명을 UTF-8 바이트로 보내지만 python-multipart 는 이를 latin-1 로
    디코딩한다. 그래서 '기안문.hwp' 가 '±â¾È¹®.hwp' 같은 모양으로 도착한다.
    바이트를 되돌린 뒤 UTF-8 -> CP949 순으로 다시 해석한다. curl 같은 일부 클라이언트는
    Windows 기본 코드페이지(CP949)로 파일명을 보내기 때문에 두 번째 시도가 필요하다.
    복구에 실패하면 원본을 그대로 둔다(이미 정상인 경우가 여기 해당).
    """
    if not text or text.isascii():
        return text
    try:
        raw = text.encode("latin-1")
    except UnicodeEncodeError:
        return text  # latin-1 로 표현 불가 -> 이미 제대로 디코딩된 문자열이다.
    for codec in ("utf-8", "cp949"):
        try:
            return raw.decode(codec)
        except UnicodeDecodeError:
            continue
    return text


async def _read_uploads(files: List[UploadFile]) -> List[tuple[str, bytes]]:
    out: List[tuple[str, bytes]] = []
    total = 0
    for f in files:
        data = await f.read()
        total += len(data)
        if total > MAX_UPLOAD_MB * 1024 * 1024:
            raise HTTPException(413, f"업로드 용량이 {MAX_UPLOAD_MB}MB를 넘습니다.")
        name = fix_encoding(f.filename or "") or "문서"
        ext = os.path.splitext(name)[1].lower()
        if ext not in SUPPORTED_EXTS:
            raise HTTPException(400, f"지원하지 않는 파일 형식입니다: {name}")
        out.append((name, data))
    return out


@app.post("/api/merge")
async def merge(
    files: List[UploadFile] = File(...),
    bookmarks: str = Form("true"),
    filename: str = Form("병합문서.pdf"),
):
    """
    한글/워드/PDF/이미지를 업로드 순서대로 이어붙여 하나의 PDF로 만든다.
    파일 순서는 프론트엔드가 정한 순서를 그대로 따른다.
    """
    if not files:
        raise HTTPException(400, "병합할 파일이 없습니다.")
    payload = await _read_uploads(files)
    job = make_merge_job(payload, bookmarks=bookmarks.lower() == "true")
    name = fix_encoding(filename).strip()
    if name:
        job.result_name = name if name.lower().endswith(".pdf") else name + ".pdf"
    return JSONResponse(job.as_dict())


@app.post("/api/convert")
async def convert(file: UploadFile = File(...)):
    """문서 한 개를 PDF로 변환한다."""
    payload = await _read_uploads([file])
    name, data = payload[0]
    return JSONResponse(make_topdf_job(name, data).as_dict())


@app.get("/api/job/{job_id}")
def job_status(job_id: str):
    job = STORE.get(job_id)
    if job is None:
        raise HTTPException(404, "작업을 찾을 수 없습니다. 시간이 지나 정리되었을 수 있습니다.")
    return job.as_dict()


@app.get("/api/download/{job_id}")
def download(job_id: str):
    job = STORE.get(job_id)
    if job is None or job.status != "done" or not job.result_path:
        raise HTTPException(404, "아직 결과가 준비되지 않았습니다.")
    return FileResponse(
        job.result_path,
        media_type="application/pdf",
        filename=job.result_name or "result.pdf",
    )


@app.post("/api/export")
async def export(file: UploadFile = File(...), target: str = Form(...)):
    """PDF 를 Word/Excel/PowerPoint/PDF-A 로 바꾸거나 손상된 PDF 를 복구한다."""
    name = fix_encoding(file.filename or "") or "문서.pdf"
    if os.path.splitext(name)[1].lower() != ".pdf":
        raise HTTPException(400, "PDF 파일만 넣을 수 있습니다.")
    data = await file.read()
    if len(data) > MAX_UPLOAD_MB * 1024 * 1024:
        raise HTTPException(413, f"업로드 용량이 {MAX_UPLOAD_MB}MB를 넘습니다.")
    try:
        job = make_export_job(name, data, target)
    except Exception as e:
        raise HTTPException(400, str(e))
    return JSONResponse(job.as_dict())


@app.post("/api/html")
async def html(
    url: str = Form(""),
    paper: str = Form("A4"),
    landscape: str = Form("false"),
    margin_mm: str = Form("12"),
    file: Optional[UploadFile] = File(None),
):
    """웹페이지 주소 또는 HTML 파일을 PDF 로 만든다."""
    data = b""
    filename = ""
    if file is not None:
        filename = fix_encoding(file.filename or "") or "page.html"
        if os.path.splitext(filename)[1].lower() not in (".html", ".htm"):
            raise HTTPException(400, "HTML 파일만 넣을 수 있습니다.")
        data = await file.read()

    url = (url or "").strip()
    if not data and not url:
        raise HTTPException(400, "웹페이지 주소를 넣거나 HTML 파일을 올려 주세요.")
    if url and not data:
        if not url.startswith(("http://", "https://")):
            url = "https://" + url
    try:
        margin = max(0, min(50, int(float(margin_mm))))
    except ValueError:
        margin = 12

    job = make_html_job(url=url, filename=filename, data=data, paper=paper,
                        landscape=landscape.lower() == "true", margin_mm=margin)
    return JSONResponse(job.as_dict())


# 프론트엔드를 같은 서버에서 제공한다 -> http://localhost:8765 하나로 전부 동작.
if os.path.isdir(WEB_DIR):
    app.mount("/", StaticFiles(directory=WEB_DIR, html=True), name="web")


if __name__ == "__main__":
    import uvicorn
    import webbrowser
    import threading

    port = int(os.environ.get("HANMOA_PORT", os.environ.get("HANPDF_PORT", "8765")))
    threading.Timer(1.5, lambda: webbrowser.open(f"http://localhost:{port}")).start()
    # 127.0.0.1 에만 바인딩한다 - 같은 네트워크의 다른 PC는 접근할 수 없다.
    uvicorn.run(app, host="127.0.0.1", port=port, log_level="warning")
