# -*- coding: utf-8 -*-
"""
변환 작업 큐.

COM 자동화는 스레드 친화적이지 않다. 한글이나 Word를 두 요청이 동시에 건드리면
프로세스가 통째로 죽는다. 그래서 작업은 전부 이 파일의 워커 스레드 하나를 거쳐
한 번에 하나씩만 실행된다. 웹 요청은 작업을 큐에 넣고 진행률만 폴링한다.
"""
from __future__ import annotations

import os
import queue
import shutil
import tempfile
import threading
import time
import traceback
import uuid
from dataclasses import dataclass, field
from typing import Any, Callable, Dict, List, Optional

import pythoncom

import exporters
from converter import ConversionError, any_to_pdf

# 완료된 작업을 이 시간(초)이 지나면 결과 파일까지 지운다.
JOB_TTL_SECONDS = 30 * 60


@dataclass
class Job:
    id: str
    kind: str
    total: int
    status: str = "queued"          # queued | running | done | error
    progress: int = 0               # 완료한 단계 수
    message: str = "대기 중"
    error: Optional[str] = None
    result_path: Optional[str] = None
    result_name: Optional[str] = None
    workdir: Optional[str] = None
    created: float = field(default_factory=time.time)
    finished: Optional[float] = None

    def as_dict(self) -> Dict[str, Any]:
        pct = 100 if self.status == "done" else int(self.progress * 100 / max(self.total, 1))
        return {
            "id": self.id,
            "status": self.status,
            "progress": pct,
            "step": self.progress,
            "total": self.total,
            "message": self.message,
            "error": self.error,
            "filename": self.result_name,
        }


class JobStore:
    def __init__(self) -> None:
        self._jobs: Dict[str, Job] = {}
        self._lock = threading.Lock()

    def add(self, job: Job) -> None:
        with self._lock:
            self._jobs[job.id] = job

    def get(self, job_id: str) -> Optional[Job]:
        with self._lock:
            return self._jobs.get(job_id)

    def sweep(self) -> None:
        """수명이 다한 작업의 임시 폴더를 지운다. 업로드본이 디스크에 남지 않게."""
        now = time.time()
        with self._lock:
            dead = [
                j for j in self._jobs.values()
                if j.finished and now - j.finished > JOB_TTL_SECONDS
            ]
            for j in dead:
                self._jobs.pop(j.id, None)
        for j in dead:
            if j.workdir and os.path.isdir(j.workdir):
                shutil.rmtree(j.workdir, ignore_errors=True)


STORE = JobStore()
_QUEUE: "queue.Queue[tuple[Job, Callable[[Job], None]]]" = queue.Queue()


def submit(job: Job, fn: Callable[[Job], None]) -> Job:
    STORE.add(job)
    _QUEUE.put((job, fn))
    return job


def _worker_loop() -> None:
    # 이 스레드가 COM 을 소유한다. 아파트를 여기서 한 번만 초기화한다.
    pythoncom.CoInitialize()
    try:
        while True:
            job, fn = _QUEUE.get()
            job.status = "running"
            job.message = "변환 준비 중"
            try:
                fn(job)
                job.status = "done"
                job.message = "완료"
                job.progress = job.total
            except ConversionError as e:
                job.status = "error"
                job.error = str(e)
                job.message = "실패"
            except Exception as e:
                job.status = "error"
                job.error = f"예상치 못한 오류가 발생했습니다: {e}"
                job.message = "실패"
                traceback.print_exc()
            finally:
                job.finished = time.time()
                # 프로세스 정리는 converter 안에서 우리가 띄운 것만 골라 처리한다.
                # 여기서 이름으로 싹 죽이면 사용자가 열어 둔 한글 창까지 닫힌다.
                STORE.sweep()
                _QUEUE.task_done()
    finally:
        pythoncom.CoUninitialize()


_thread = threading.Thread(target=_worker_loop, name="hanpdf-com-worker", daemon=True)
_thread.start()


# --------------------------------------------------------------------------
# 작업 구현
# --------------------------------------------------------------------------

def make_merge_job(files: List[tuple[str, bytes]], *, bookmarks: bool = True) -> Job:
    """
    문서 여러 개를 하나의 PDF로 병합하는 작업을 만든다.

    files 는 (표시용 파일명, 내용) 목록이며 순서가 곧 병합 순서다.
    각 문서를 개별 PDF로 변환한 뒤 이어붙이므로, 문서는 자연히 새 페이지에서 시작한다.
    """
    workdir = tempfile.mkdtemp(prefix="hanpdf_")
    job = Job(
        id=uuid.uuid4().hex,
        kind="merge-docs",
        total=len(files) + 1,   # 변환 N번 + 병합 1번
        workdir=workdir,
        result_name="병합문서.pdf",
    )

    # 업로드 내용을 즉시 디스크에 내려놓는다(메모리에 들고 있지 않는다).
    staged: List[tuple[str, str]] = []
    for idx, (name, data) in enumerate(files):
        safe = f"{idx:03d}{os.path.splitext(name)[1].lower()}"
        path = os.path.join(workdir, safe)
        with open(path, "wb") as fh:
            fh.write(data)
        staged.append((name, path))

    def run(j: Job) -> None:
        from pypdf import PdfReader, PdfWriter

        pdf_paths: List[tuple[str, str]] = []
        for i, (display, path) in enumerate(staged, start=1):
            j.message = f"({i}/{len(staged)}) {display} 변환 중"
            out = os.path.join(workdir, f"conv_{i:03d}.pdf")
            try:
                any_to_pdf(path, out)
            except ConversionError as e:
                # 변환기는 우리가 붙인 임시 이름(000.hwp)만 안다. 사용자가 올린
                # 원래 이름으로 바꿔 줘야 어느 파일이 문제인지 알 수 있다.
                raise ConversionError(
                    str(e).replace(os.path.basename(path), display)
                ) from e
            pdf_paths.append((display, out))
            j.progress = i

        j.message = "PDF 병합 중"
        writer = PdfWriter()
        for display, pdf in pdf_paths:
            start_page = len(writer.pages)
            reader = PdfReader(pdf)
            for page in reader.pages:
                writer.add_page(page)
            if bookmarks:
                title = os.path.splitext(display)[0]
                writer.add_outline_item(title, start_page)

        result = os.path.join(workdir, "merged.pdf")
        with open(result, "wb") as fh:
            writer.write(fh)
        j.result_path = result

    return submit(job, run)


def make_topdf_job(name: str, data: bytes) -> Job:
    """문서 한 개를 PDF로 변환하는 작업."""
    workdir = tempfile.mkdtemp(prefix="hanpdf_")
    job = Job(
        id=uuid.uuid4().hex,
        kind="to-pdf",
        total=1,
        workdir=workdir,
        result_name=os.path.splitext(name)[0] + ".pdf",
    )
    src = os.path.join(workdir, "src" + os.path.splitext(name)[1].lower())
    with open(src, "wb") as fh:
        fh.write(data)

    def run(j: Job) -> None:
        j.message = f"{name} 변환 중"
        out = os.path.join(workdir, "out.pdf")
        try:
            any_to_pdf(src, out)
        except ConversionError as e:
            raise ConversionError(str(e).replace(os.path.basename(src), name)) from e
        j.result_path = out
        j.progress = 1

    return submit(job, run)


# --- 2차: 내보내기 / 웹페이지 변환 -----------------------------------------

# 목표 형식 -> (확장자, 사람이 읽을 이름, 변환 함수)
EXPORT_TARGETS = {
    "docx":   (".docx", "Word 문서",       lambda s, d, prog: exporters.pdf_to_docx(s, d, prog)),
    "xlsx":   (".xlsx", "Excel 통합문서",  lambda s, d, prog: exporters.pdf_to_xlsx(s, d, prog)),
    "pptx":   (".pptx", "PowerPoint 문서", lambda s, d, prog: exporters.pdf_to_pptx(s, d, progress=prog)),
    "pdfa":   (".pdf",  "PDF/A 문서",      lambda s, d, prog: exporters.pdf_to_pdfa(s, d)),
    "repair": (".pdf",  "복구된 PDF",      lambda s, d, prog: exporters.repair_pdf(s, d)),
}


def make_export_job(name: str, data: bytes, target: str) -> Job:
    """PDF 를 다른 형식으로 내보내는 작업."""
    if target not in EXPORT_TARGETS:
        raise ConversionError(f"알 수 없는 변환 대상입니다: {target}")
    ext, label, fn = EXPORT_TARGETS[target]

    workdir = tempfile.mkdtemp(prefix="hanmoa_")
    stem = os.path.splitext(name)[0]
    suffix = {"pdfa": "_PDFA", "repair": "_복구"}.get(target, "")
    job = Job(
        id=uuid.uuid4().hex,
        kind="export",
        total=1,
        workdir=workdir,
        result_name=stem + suffix + ext,
    )
    src = os.path.join(workdir, "src.pdf")
    with open(src, "wb") as fh:
        fh.write(data)

    def run(j: Job) -> None:
        j.message = f"{label}(으)로 변환 중"

        def prog(i, n, msg):
            j.total = max(n, 1)
            j.progress = i
            j.message = msg

        out = os.path.join(workdir, "out" + ext)
        fn(src, out, prog)
        j.result_path = out
        j.total = max(j.total, 1)
        j.progress = j.total

    return submit(job, run)


def make_html_job(*, url: str = "", filename: str = "", data: bytes = b"",
                  paper: str = "A4", landscape: bool = False,
                  margin_mm: int = 12) -> Job:
    """웹페이지 주소 또는 HTML 파일을 PDF 로 만드는 작업."""
    workdir = tempfile.mkdtemp(prefix="hanmoa_")
    stem = os.path.splitext(filename)[0] if filename else _name_from_url(url)
    job = Job(
        id=uuid.uuid4().hex,
        kind="html",
        total=1,
        workdir=workdir,
        result_name=(stem or "웹페이지") + ".pdf",
    )

    src = ""
    if data:
        src = os.path.join(workdir, filename or "page.html")
        with open(src, "wb") as fh:
            fh.write(data)

    def run(j: Job) -> None:
        out = os.path.join(workdir, "out.pdf")
        if src:
            j.message = f"{filename} 변환 중"
            exporters.html_file_to_pdf(src, out, paper=paper,
                                       landscape=landscape, margin_mm=margin_mm)
        else:
            j.message = "페이지를 불러오는 중"
            exporters.html_to_pdf(url, out)
        j.result_path = out
        j.progress = 1

    return submit(job, run)


def _name_from_url(url: str) -> str:
    """주소에서 파일 이름으로 쓸 만한 조각을 뽑는다."""
    from urllib.parse import urlparse
    try:
        parsed = urlparse(url)
        stem = (parsed.path.rsplit("/", 1)[-1] or parsed.netloc or "웹페이지")
        stem = os.path.splitext(stem)[0]
        # 파일 이름에 못 쓰는 글자를 걸러낸다.
        return "".join(c for c in stem if c not in r'\/:*?"<>|').strip() or "웹페이지"
    except Exception:
        return "웹페이지"
