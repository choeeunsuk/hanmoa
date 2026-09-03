/*
 * core.js — PDF 작업의 실제 구현.
 *
 * 여기 있는 함수는 전부 브라우저 안에서 돌아간다. 파일은 네트워크로 나가지 않는다.
 * pdf-lib(@cantoo 포크, 암호화 지원)로 문서를 조립하고, pdf.js 로 화면에 그린다.
 */
'use strict';

const { PDFDocument, degrees, rgb, StandardFonts } = PDFLib;

pdfjsLib.GlobalWorkerOptions.workerSrc = 'vendor/pdf.worker.min.js';

const Core = (() => {

  /* ── 유틸 ─────────────────────────────────────────── */

  function formatBytes(n) {
    if (n < 1024) return n + ' B';
    if (n < 1024 * 1024) return (n / 1024).toFixed(0) + ' KB';
    return (n / 1024 / 1024).toFixed(1) + ' MB';
  }

  function baseName(name) {
    return name.replace(/\.[^.]+$/, '');
  }

  function extOf(name) {
    const m = /\.[^.]+$/.exec(name || '');
    return m ? m[0].toLowerCase() : '';
  }

  /**
   * "1-3, 5, 9-" 같은 사람이 쓴 페이지 표기를 0-기반 인덱스 배열로 바꾼다.
   * 범위를 벗어나거나 해석할 수 없는 조각은 조용히 버린다.
   */
  function parsePageRanges(spec, pageCount) {
    const out = [];
    const seen = new Set();
    for (let part of String(spec || '').split(',')) {
      part = part.trim();
      if (!part) continue;
      const m = /^(\d+)?\s*-\s*(\d+)?$/.exec(part);
      let from, to;
      if (m) {
        from = m[1] ? parseInt(m[1], 10) : 1;
        to = m[2] ? parseInt(m[2], 10) : pageCount;
      } else if (/^\d+$/.test(part)) {
        from = to = parseInt(part, 10);
      } else {
        continue;
      }
      if (from > to) [from, to] = [to, from];
      for (let p = Math.max(1, from); p <= Math.min(pageCount, to); p++) {
        if (!seen.has(p)) { seen.add(p); out.push(p - 1); }
      }
    }
    return out;
  }

  function download(blob, filename) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    // 브라우저가 저장을 시작할 시간을 준 뒤 정리한다.
    setTimeout(() => URL.revokeObjectURL(url), 60000);
  }

  /* ── 문서 열기 ─────────────────────────────────────── */

  /**
   * PDF 를 연다. 암호가 걸려 있으면 EncryptedPDFError 가 나므로 호출부에서
   * 사용자에게 암호를 받아 password 로 다시 부른다.
   */
  async function loadDoc(file, password) {
    const bytes = await file.arrayBuffer();
    const opts = { ignoreEncryption: false };
    if (password) opts.password = password;
    return PDFDocument.load(bytes, opts);
  }

  async function saveDoc(doc) {
    return new Blob([await doc.save()], { type: 'application/pdf' });
  }

  /* ── 텍스트 스탬프 ─────────────────────────────────
   * pdf-lib 의 기본 폰트에는 한글 글리프가 없다. 한글 폰트 파일을 함께
   * 배포하면 앱이 몇 MB 무거워지므로, 대신 캔버스에 글자를 그려 PNG 로
   * 넣는다. 브라우저에 설치된 한글 폰트를 그대로 쓸 수 있다.
   * ASCII 만 있는 문자열은 진짜 폰트로 그려 벡터 텍스트를 유지한다.
   * ------------------------------------------------ */

  function isAscii(s) {
    return /^[\x20-\x7E]*$/.test(s);
  }

  const stampCache = new Map();

  /** 글자를 투명 배경 PNG 로 렌더링한다. 크기는 실제 픽셀 크기를 함께 돌려준다. */
  function renderTextToPng(text, { fontSize = 64, color = '#000000', bold = true } = {}) {
    const key = [text, fontSize, color, bold].join('|');
    if (stampCache.has(key)) return stampCache.get(key);

    const scale = 3;  // 확대 렌더링 후 축소 배치 -> 인쇄 품질 확보
    const font = `${bold ? '700 ' : ''}${fontSize * scale}px "Malgun Gothic", "Apple SD Gothic Neo", sans-serif`;
    const measure = document.createElement('canvas').getContext('2d');
    measure.font = font;
    const m = measure.measureText(text);
    const w = Math.ceil(m.width) + 8;
    const h = Math.ceil(fontSize * scale * 1.35);

    const cv = document.createElement('canvas');
    cv.width = Math.max(w, 1);
    cv.height = Math.max(h, 1);
    const ctx = cv.getContext('2d');
    ctx.font = font;
    ctx.fillStyle = color;
    ctx.textBaseline = 'middle';
    ctx.fillText(text, 4, h / 2);

    const result = { dataUrl: cv.toDataURL('image/png'), width: w / scale, height: h / scale };
    stampCache.set(key, result);
    return result;
  }

  function hexToRgb(hex) {
    const m = /^#?([0-9a-f]{6})$/i.exec(hex || '#000000');
    const n = m ? parseInt(m[1], 16) : 0;
    return rgb(((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255);
  }

  /* ── 도구 구현 ─────────────────────────────────────── */

  /** 여러 PDF 를 순서대로 이어붙인다. 파일명으로 목차(북마크)를 만든다. */
  async function mergePdfs(files, { bookmarks = true, password, onProgress } = {}) {
    const out = await PDFDocument.create();
    const marks = [];
    for (let i = 0; i < files.length; i++) {
      onProgress?.(i, files.length, files[i].name);
      const src = await loadDoc(files[i], password);
      const start = out.getPageCount();
      const pages = await out.copyPages(src, src.getPageIndices());
      pages.forEach(p => out.addPage(p));
      marks.push({ title: baseName(files[i].name), page: start });
    }
    if (bookmarks && marks.length > 1) addOutline(out, marks);
    onProgress?.(files.length, files.length, '');
    return saveDoc(out);
  }

  /**
   * 목차(북마크)를 직접 만든다. pdf-lib 에는 아웃라인 API가 없어서
   * PDF 객체 그래프를 손으로 엮는다.
   */
  function addOutline(doc, marks) {
    const { PDFName, PDFArray, PDFNumber, PDFString } = PDFLib;
    const ctx = doc.context;
    const rootRef = ctx.nextRef();
    const items = marks.map(m => {
      const pageRef = doc.getPage(m.page).ref;
      const dest = PDFArray.withContext(ctx);
      dest.push(pageRef);
      dest.push(PDFName.of('Fit'));
      const dict = ctx.obj({ Title: PDFString.of(m.title), Parent: rootRef, Dest: dest });
      return { ref: ctx.register(dict), dict };
    });
    items.forEach((it, i) => {
      if (i > 0) it.dict.set(PDFName.of('Prev'), items[i - 1].ref);
      if (i < items.length - 1) it.dict.set(PDFName.of('Next'), items[i + 1].ref);
    });
    ctx.assign(rootRef, ctx.obj({
      Type: PDFName.of('Outlines'),
      First: items[0].ref,
      Last: items[items.length - 1].ref,
      Count: PDFNumber.of(items.length),
    }));
    doc.catalog.set(PDFName.of('Outlines'), rootRef);
    doc.catalog.set(PDFName.of('PageMode'), PDFName.of('UseOutlines'));
  }

  /** 지정한 페이지들만 남긴 새 PDF 를 만든다. */
  async function pickPages(file, indices, password) {
    const src = await loadDoc(file, password);
    const out = await PDFDocument.create();
    const pages = await out.copyPages(src, indices);
    pages.forEach(p => out.addPage(p));
    return saveDoc(out);
  }

  /** 분할. mode: 'every'(N장씩) | 'ranges'(지정 구간) | 'single'(1장씩) */
  async function splitPdf(file, { mode, size = 1, ranges = '', password } = {}) {
    const src = await loadDoc(file, password);
    const total = src.getPageCount();
    const groups = [];

    if (mode === 'ranges') {
      for (const chunk of String(ranges).split(',')) {
        const idx = parsePageRanges(chunk, total);
        if (idx.length) groups.push(idx);
      }
    } else {
      const step = mode === 'single' ? 1 : Math.max(1, parseInt(size, 10) || 1);
      for (let i = 0; i < total; i += step) {
        groups.push(Array.from({ length: Math.min(step, total - i) }, (_, k) => i + k));
      }
    }
    if (!groups.length) throw new Error('분할할 페이지 구간이 없습니다. 페이지 범위를 확인해 주세요.');

    const results = [];
    const stem = baseName(file.name);
    for (let g = 0; g < groups.length; g++) {
      const out = await PDFDocument.create();
      const pages = await out.copyPages(src, groups[g]);
      pages.forEach(p => out.addPage(p));
      const first = groups[g][0] + 1;
      const last = groups[g][groups[g].length - 1] + 1;
      const label = first === last ? `${first}` : `${first}-${last}`;
      results.push({ blob: await saveDoc(out), name: `${stem}_${label}.pdf` });
    }
    return results;
  }

  /** 페이지 회전. which 가 비어 있으면 전체 페이지에 적용한다. */
  async function rotatePdf(file, { angle = 90, which = '', password } = {}) {
    const doc = await loadDoc(file, password);
    const total = doc.getPageCount();
    const targets = which.trim() ? parsePageRanges(which, total)
                                : Array.from({ length: total }, (_, i) => i);
    targets.forEach(i => {
      const p = doc.getPage(i);
      p.setRotation(degrees((p.getRotation().angle + Number(angle)) % 360));
    });
    return saveDoc(doc);
  }

  /** 페이지 여백 잘라내기. 비율(%)로 사방을 깎는다. */
  async function cropPdf(file, { top = 0, bottom = 0, left = 0, right = 0, password } = {}) {
    const doc = await loadDoc(file, password);
    for (const page of doc.getPages()) {
      const { width, height } = page.getSize();
      const l = width * (Number(left) / 100);
      const r = width * (Number(right) / 100);
      const t = height * (Number(top) / 100);
      const b = height * (Number(bottom) / 100);
      const w = width - l - r;
      const h = height - t - b;
      if (w <= 1 || h <= 1) throw new Error('잘라낼 여백이 너무 큽니다. 값을 줄여 주세요.');
      // MediaBox 원점을 고려해 CropBox 를 설정한다.
      const box = page.getMediaBox();
      page.setCropBox(box.x + l, box.y + b, w, h);
    }
    return saveDoc(doc);
  }

  /** 페이지 번호 삽입. {n}=현재 쪽, {total}=전체 쪽. */
  async function addPageNumbers(file, opts = {}) {
    const {
      format = '{n}', position = 'bottom-center', fontSize = 11,
      color = '#333333', margin = 28, startAt = 1, skipFirst = false, password,
    } = opts;
    const doc = await loadDoc(file, password);
    const pages = doc.getPages();
    const ascii = isAscii(format.replace(/\{n\}|\{total\}/g, '0'));
    const font = ascii ? await doc.embedFont(StandardFonts.Helvetica) : null;

    for (let i = 0; i < pages.length; i++) {
      if (skipFirst && i === 0) continue;
      const page = pages[i];
      const { width, height } = page.getSize();
      const text = String(format)
        .replace(/\{n\}/g, String(i + Number(startAt)))
        .replace(/\{total\}/g, String(pages.length));

      let w, h, draw;
      if (ascii) {
        w = font.widthOfTextAtSize(text, fontSize);
        h = fontSize;
        draw = (x, y) => page.drawText(text, { x, y, size: fontSize, font, color: hexToRgb(color) });
      } else {
        const png = renderTextToPng(text, { fontSize, color, bold: false });
        const img = await doc.embedPng(png.dataUrl);
        w = png.width; h = png.height;
        draw = (x, y) => page.drawImage(img, { x, y: y - h * 0.25, width: w, height: h });
      }

      const [vert, horiz] = position.split('-');
      const x = horiz === 'left' ? margin
              : horiz === 'right' ? width - margin - w
              : (width - w) / 2;
      const y = vert === 'top' ? height - margin - h : margin;
      draw(x, y);
    }
    return saveDoc(doc);
  }

  /** 사선 워터마크. 한글 문구도 그대로 들어간다. */
  async function addWatermark(file, opts = {}) {
    const {
      text = '대외비', fontSize = 60, color = '#d92d20',
      opacity = 0.25, rotation = 45, tile = false, password,
    } = opts;
    if (!String(text).trim()) throw new Error('워터마크에 넣을 문구를 입력해 주세요.');

    const doc = await loadDoc(file, password);
    const png = renderTextToPng(String(text), { fontSize: Number(fontSize), color, bold: true });
    const img = await doc.embedPng(png.dataUrl);
    const w = png.width, h = png.height;

    for (const page of doc.getPages()) {
      const { width, height } = page.getSize();
      const common = { width: w, height: h, opacity: Number(opacity), rotate: degrees(Number(rotation)) };
      if (tile) {
        const stepX = w * 1.5, stepY = h * 3.2;
        for (let y = -h; y < height + h; y += stepY) {
          for (let x = -w; x < width + w; x += stepX) {
            page.drawImage(img, { ...common, x, y });
          }
        }
      } else {
        // 회전 중심이 좌하단이므로 회전 후 중앙에 오도록 위치를 보정한다.
        const rad = Number(rotation) * Math.PI / 180;
        const cx = width / 2, cy = height / 2;
        page.drawImage(img, {
          ...common,
          x: cx - (w / 2) * Math.cos(rad) + (h / 2) * Math.sin(rad),
          y: cy - (w / 2) * Math.sin(rad) - (h / 2) * Math.cos(rad),
        });
      }
    }
    return saveDoc(doc);
  }

  /** 암호 걸기. */
  async function protectPdf(file, { userPassword, ownerPassword, allowPrinting = true, allowCopying = false } = {}) {
    if (!userPassword) throw new Error('열기 암호를 입력해 주세요.');
    const doc = await loadDoc(file);
    doc.encrypt({
      userPassword,
      ownerPassword: ownerPassword || userPassword,
      permissions: {
        printing: allowPrinting ? 'highResolution' : undefined,
        copying: !!allowCopying,
        modifying: false,
      },
    });
    return saveDoc(doc);
  }

  /** 암호 해제. 현재 암호를 알아야 한다. */
  async function unlockPdf(file, { password } = {}) {
    if (!password) throw new Error('현재 설정된 암호를 입력해 주세요.');
    let doc;
    try {
      doc = await loadDoc(file, password);
    } catch (e) {
      throw new Error('암호가 일치하지 않거나 지원하지 않는 암호화 방식입니다.');
    }
    // 새 문서로 페이지를 옮겨 담으면 암호화 정보가 따라오지 않는다.
    const out = await PDFDocument.create();
    const pages = await out.copyPages(doc, doc.getPageIndices());
    pages.forEach(p => out.addPage(p));
    return saveDoc(out);
  }

  /* ── pdf.js 를 쓰는 래스터 작업 ─────────────────────── */

  async function openWithPdfjs(file, password) {
    const data = new Uint8Array(await file.arrayBuffer());
    return pdfjsLib.getDocument({ data, password }).promise;
  }

  /**
   * 페이지를 이미지로 렌더링한다. scale 1 = 72dpi.
   *
   * intent 를 'print' 로 두는 이유: 기본값인 'display' 로 렌더링하면 pdf.js 가
   * requestAnimationFrame 으로 작업을 이어간다. 사용자가 변환 도중 다른 탭으로
   * 옮기면 브라우저가 rAF 를 멈추기 때문에 렌더링이 영영 끝나지 않는다.
   * 'print' 경로는 rAF 를 쓰지 않으므로 백그라운드에서도 끝까지 처리된다.
   * 출력물을 파일로 뽑는 용도라 print 쪽 렌더링이 의미상으로도 맞다.
   */
  async function renderPage(pdf, pageNo, scale) {
    const page = await pdf.getPage(pageNo);
    const viewport = page.getViewport({ scale });
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.floor(viewport.width));
    canvas.height = Math.max(1, Math.floor(viewport.height));
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    await page.render({ canvasContext: ctx, viewport, intent: 'print' }).promise;
    return canvas;
  }

  function canvasToBlob(canvas, type, quality) {
    return new Promise(res => canvas.toBlob(res, type, quality));
  }

  /** PDF 의 각 페이지를 이미지 파일로 뽑는다. */
  async function pdfToImages(file, { dpi = 150, format = 'jpeg', quality = 0.9, password, onProgress } = {}) {
    const pdf = await openWithPdfjs(file, password);
    const scale = Number(dpi) / 72;
    const stem = baseName(file.name);
    const mime = format === 'png' ? 'image/png' : 'image/jpeg';
    const ext = format === 'png' ? 'png' : 'jpg';
    const out = [];
    for (let i = 1; i <= pdf.numPages; i++) {
      onProgress?.(i - 1, pdf.numPages, `${i}쪽 렌더링 중`);
      const canvas = await renderPage(pdf, i, scale);
      out.push({
        blob: await canvasToBlob(canvas, mime, quality),
        name: `${stem}_${String(i).padStart(3, '0')}.${ext}`,
      });
      canvas.width = canvas.height = 0;  // 큰 문서에서 메모리를 즉시 놓아준다.
    }
    onProgress?.(pdf.numPages, pdf.numPages, '');
    return out;
  }

  /** 이미지들을 한 장씩 페이지로 담은 PDF 를 만든다. */
  async function imagesToPdf(files, { pageSize = 'fit', margin = 0, orientation = 'auto', onProgress } = {}) {
    const A4 = { width: 595.28, height: 841.89 };
    const doc = await PDFDocument.create();
    for (let i = 0; i < files.length; i++) {
      onProgress?.(i, files.length, files[i].name);
      const file = files[i];
      const bytes = await file.arrayBuffer();
      const type = (file.type || '').toLowerCase();
      let img;
      if (type.includes('png')) {
        img = await doc.embedPng(bytes);
      } else if (type.includes('jpeg') || type.includes('jpg')) {
        img = await doc.embedJpg(bytes);
      } else {
        // GIF/BMP/WEBP 등은 캔버스를 거쳐 PNG 로 정규화한다.
        img = await doc.embedPng(await imageFileToPngDataUrl(file));
      }

      if (pageSize === 'fit') {
        const page = doc.addPage([img.width + margin * 2, img.height + margin * 2]);
        page.drawImage(img, { x: margin, y: margin, width: img.width, height: img.height });
      } else {
        let pw = A4.width, ph = A4.height;
        const landscape = orientation === 'landscape'
          || (orientation === 'auto' && img.width > img.height);
        if (landscape) [pw, ph] = [ph, pw];
        const page = doc.addPage([pw, ph]);
        const avail = { w: pw - margin * 2, h: ph - margin * 2 };
        const s = Math.min(avail.w / img.width, avail.h / img.height);
        const w = img.width * s, h = img.height * s;
        page.drawImage(img, { x: (pw - w) / 2, y: (ph - h) / 2, width: w, height: h });
      }
    }
    if (doc.getPageCount() === 0) throw new Error('PDF로 만들 이미지가 없습니다.');
    onProgress?.(files.length, files.length, '');
    return saveDoc(doc);
  }

  function imageFileToPngDataUrl(file) {
    return new Promise((resolve, reject) => {
      const url = URL.createObjectURL(file);
      const im = new Image();
      im.onload = () => {
        const cv = document.createElement('canvas');
        cv.width = im.naturalWidth; cv.height = im.naturalHeight;
        cv.getContext('2d').drawImage(im, 0, 0);
        URL.revokeObjectURL(url);
        resolve(cv.toDataURL('image/png'));
      };
      im.onerror = () => { URL.revokeObjectURL(url); reject(new Error(`이미지를 읽을 수 없습니다: ${file.name}`)); };
      im.src = url;
    });
  }

  /**
   * 용량 줄이기.
   * 'light' 는 구조만 다시 쓰고(글자는 그대로 벡터), 'strong' 은 각 페이지를
   * 이미지로 다시 그려 넣는다. 강하게 줄면 글자 검색은 되지 않는다.
   */
  async function compressPdf(file, { level = 'light', password, onProgress } = {}) {
    if (level === 'light') {
      const doc = await loadDoc(file, password);
      const out = await PDFDocument.create();
      const pages = await out.copyPages(doc, doc.getPageIndices());
      pages.forEach(p => out.addPage(p));
      return new Blob([await out.save({ useObjectStreams: true })], { type: 'application/pdf' });
    }
    const preset = level === 'strong' ? { dpi: 96, q: 0.6 } : { dpi: 120, q: 0.75 };
    const pdf = await openWithPdfjs(file, password);
    const out = await PDFDocument.create();
    for (let i = 1; i <= pdf.numPages; i++) {
      onProgress?.(i - 1, pdf.numPages, `${i}쪽 압축 중`);
      const canvas = await renderPage(pdf, i, preset.dpi / 72);
      const blob = await canvasToBlob(canvas, 'image/jpeg', preset.q);
      const img = await out.embedJpg(await blob.arrayBuffer());
      const page = out.addPage([img.width * 72 / preset.dpi, img.height * 72 / preset.dpi]);
      page.drawImage(img, { x: 0, y: 0, width: page.getWidth(), height: page.getHeight() });
      canvas.width = canvas.height = 0;
    }
    onProgress?.(pdf.numPages, pdf.numPages, '');
    return saveDoc(out);
  }

  /** 여러 결과물을 zip 하나로 묶는다. */
  async function zipAll(items, zipName) {
    const zip = new JSZip();
    for (const it of items) zip.file(it.name, it.blob);
    const blob = await zip.generateAsync({ type: 'blob', compression: 'DEFLATE' });
    return { blob, name: zipName };
  }


  /**
   * 깨진 PDF 를 브라우저에서 복구해 본다.
   *
   * pdf-lib 을 관대한 모드로 열어 다시 쓰는 방식이라, 상호참조표가 조금 어긋난
   * 정도는 살아난다. 손상이 심하면 실패하는데, 그때는 호출부가 로컬 엔진의
   * MuPDF 복구로 넘긴다. MuPDF 쪽이 훨씬 끈질기다.
   */
  async function repairPdf(file) {
    const bytes = await file.arrayBuffer();
    const doc = await PDFDocument.load(bytes, {
      ignoreEncryption: true,
      throwOnInvalidObject: false,
      updateMetadata: false,
    });
    const pageCount = doc.getPageCount();
    if (!pageCount) throw new Error('살릴 수 있는 페이지를 찾지 못했습니다.');

    // 새 문서로 옮겨 담아야 망가진 구조가 따라오지 않는다.
    const out = await PDFDocument.create();
    const pages = await out.copyPages(doc, doc.getPageIndices());
    pages.forEach(p => out.addPage(p));
    return { blob: await saveDoc(out), pageCount };
  }


  /**
   * 쪽 작업 공간의 상태(순서·회전)를 그대로 반영한 새 PDF 를 만든다.
   * state 는 [{ index, rotation }] 이며 배열 순서가 곧 결과의 쪽 순서다.
   */
  async function buildFromPages(file, state, password) {
    if (!state.length) throw new Error('최소 한 쪽은 남겨야 합니다.');
    const src = await loadDoc(file, password);
    const out = await PDFDocument.create();
    const copied = await out.copyPages(src, state.map(s => s.index));
    copied.forEach((page, i) => {
      const turn = state[i].rotation || 0;
      if (turn) page.setRotation(degrees((page.getRotation().angle + turn) % 360));
      out.addPage(page);
    });
    return saveDoc(out);
  }


  /**
   * 편집기에서 올려둔 항목(서명 그림·글상자·검은 칠)을 PDF 에 실제로 새긴다.
   *
   * 항목의 좌표는 쪽 크기에 대한 비율(0~1)이고 y 는 화면과 같이 위에서부터 잰다.
   * PDF 는 아래에서부터 재므로 옮겨 담을 때 뒤집는다.
   *
   * 검은 칠은 사각형만 덧그려서는 안 된다. 그렇게 하면 글자가 그대로 남아 복사·
   * 검색으로 읽힌다. 그래서 칠이 있는 쪽은 통째로 그림으로 다시 굽고 그 위에
   * 칠을 올린다. 그 쪽은 글자 선택이 안 되지만, 가린 내용이 정말로 사라진다.
   */
  async function applyEdits(file, items, { password, redactDpi = 150, onProgress } = {}) {
    if (!items.length) throw new Error('페이지에 올린 항목이 없습니다.');

    const src = await loadDoc(file, password);
    const total = src.getPageCount();
    const redactPages = new Set(items.filter(i => i.type === 'redact').map(i => i.page));
    const out = await PDFDocument.create();
    const viewer = redactPages.size ? await openWithPdfjs(file, password) : null;

    for (let i = 0; i < total; i++) {
      onProgress?.(i, total, `${i + 1}/${total}쪽 처리 중`);

      if (!redactPages.has(i)) {
        const [copied] = await out.copyPages(src, [i]);
        out.addPage(copied);
        continue;
      }

      // 칠이 있는 쪽: 그림으로 구운 뒤 그 위에 검은 칸을 올린다.
      const canvas = await renderPage(viewer, i + 1, redactDpi / 72);
      const ctx = canvas.getContext('2d');
      ctx.fillStyle = '#000000';
      for (const it of items) {
        if (it.type !== 'redact' || it.page !== i) continue;
        ctx.fillRect(it.x * canvas.width, it.y * canvas.height,
                     it.w * canvas.width, it.h * canvas.height);
      }
      const jpg = await canvasToBlob(canvas, 'image/jpeg', 0.92);
      const img = await out.embedJpg(await jpg.arrayBuffer());
      const { width, height } = src.getPage(i).getSize();
      const page = out.addPage([width, height]);
      page.drawImage(img, { x: 0, y: 0, width, height });
      canvas.width = canvas.height = 0;
    }

    // 글상자와 그림은 마지막에 얹는다. 구워진 쪽 위에도 그대로 올라간다.
    const pages = out.getPages();
    for (const it of items) {
      if (it.type === 'redact') continue;
      const page = pages[it.page];
      if (!page) continue;
      const { width, height } = page.getSize();
      const w = it.w * width;
      const h = it.h * height;
      const x = it.x * width;
      const y = height * (1 - it.y - it.h);      // 화면 좌표 -> PDF 좌표

      if (it.type === 'image') {
        const bytes = await (await fetch(it.dataUrl)).arrayBuffer();
        const img = it.dataUrl.startsWith('data:image/png')
          ? await out.embedPng(bytes) : await out.embedJpg(bytes);
        page.drawImage(img, { x, y, width: w, height: h, opacity: it.opacity ?? 1 });
      } else if (it.type === 'text') {
        // 한글이 섞일 수 있으니 캔버스로 그려 그림으로 넣는다.
        const png = renderTextToPng(it.text, {
          fontSize: 64, color: it.color || '#111111', bold: !!it.bold,
        });
        const img = await out.embedPng(png.dataUrl);
        const drawH = h;
        const drawW = drawH * (png.width / png.height);
        page.drawImage(img, { x, y, width: drawW, height: drawH });
      }
    }

    onProgress?.(total, total, '');
    return { blob: await saveDoc(out), rasterized: redactPages.size };
  }


  /* ── 두 PDF 비교 ─────────────────────────────── */

  /**
   * 줄 단위로 무엇이 빠지고 무엇이 새로 들어왔는지 찾는다.
   * 최장 공통 부분수열을 구해 양쪽에 다 있는 줄은 건너뛴다.
   */
  function diffLines(oldText, newText) {
    const a = oldText.split('\n').map(s => s.trim()).filter(Boolean);
    const b = newText.split('\n').map(s => s.trim()).filter(Boolean);

    // 줄 수가 많으면 표가 너무 커지므로 그때는 집합 비교로 갈음한다.
    if (a.length * b.length > 400000) {
      const setA = new Set(a), setB = new Set(b);
      return {
        removed: a.filter(l => !setB.has(l)),
        added: b.filter(l => !setA.has(l)),
      };
    }

    const m = a.length, n = b.length;
    const lcs = Array.from({ length: m + 1 }, () => new Uint32Array(n + 1));
    for (let i = m - 1; i >= 0; i--) {
      for (let j = n - 1; j >= 0; j--) {
        lcs[i][j] = a[i] === b[j] ? lcs[i + 1][j + 1] + 1
                                  : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
      }
    }
    const removed = [], added = [];
    let i = 0, j = 0;
    while (i < m && j < n) {
      if (a[i] === b[j]) { i++; j++; }
      else if (lcs[i + 1][j] >= lcs[i][j + 1]) removed.push(a[i++]);
      else added.push(b[j++]);
    }
    while (i < m) removed.push(a[i++]);
    while (j < n) added.push(b[j++]);
    return { removed, added };
  }

  /** 쪽에서 글자만 뽑아 온다. */
  async function pageText(pdf, pageNo) {
    const page = await pdf.getPage(pageNo);
    const content = await page.getTextContent();
    // pdf.js 는 줄바꿈을 따로 주지 않으므로 y 좌표가 바뀌면 줄이 바뀐 것으로 본다.
    let lastY = null;
    const out = [];
    for (const item of content.items) {
      const y = Math.round(item.transform[5]);
      if (lastY !== null && Math.abs(y - lastY) > 2) out.push('\n');
      out.push(item.str);
      lastY = y;
    }
    return out.join('');
  }

  /**
   * 두 PDF 를 견줘 달라진 곳을 붉게 칠한 보고서 PDF 와 글자 차이 목록을 만든다.
   *
   * 그림을 격자로 잘라 칸 단위로 견준다. 픽셀 하나하나를 칠하면 글꼴이 미세하게
   * 밀린 것까지 붉어져서 정작 무엇이 달라졌는지 보이지 않는다.
   */
  async function comparePdfs(fileA, fileB, { dpi = 110, cell = 10, tolerance = 26, onProgress } = {}) {
    const [pdfA, pdfB] = await Promise.all([openWithPdfjs(fileA), openWithPdfjs(fileB)]);
    const total = Math.max(pdfA.numPages, pdfB.numPages);
    const out = await PDFDocument.create();
    const font = await out.embedFont(StandardFonts.Helvetica);
    const scale = dpi / 72;
    const report = [];
    let changedPages = 0;

    for (let i = 1; i <= total; i++) {
      onProgress?.(i - 1, total, `${i}/${total}쪽 견주는 중`);

      const inA = i <= pdfA.numPages;
      const inB = i <= pdfB.numPages;
      const canvasA = inA ? await renderPage(pdfA, i, scale) : null;
      const canvasB = inB ? await renderPage(pdfB, i, scale) : null;
      const shown = canvasB || canvasA;

      let changed = !inA || !inB;
      if (canvasA && canvasB) {
        changed = markDifferences(canvasA, canvasB, cell, tolerance);
      } else if (shown) {
        // 한쪽에만 있는 쪽은 전체를 표시한다.
        const ctx = shown.getContext('2d');
        ctx.fillStyle = 'rgba(217, 45, 32, .16)';
        ctx.fillRect(0, 0, shown.width, shown.height);
      }
      if (changed) changedPages++;

      const jpg = await canvasToBlob(shown, 'image/jpeg', 0.85);
      const img = await out.embedJpg(await jpg.arrayBuffer());
      const page = out.addPage([shown.width * 72 / dpi, shown.height * 72 / dpi]);
      page.drawImage(img, { x: 0, y: 0, width: page.getWidth(), height: page.getHeight() });

      const label = !inA ? `p.${i} ADDED` : !inB ? `p.${i} REMOVED`
                  : changed ? `p.${i} CHANGED` : `p.${i} same`;
      page.drawText(label, {
        x: 8, y: page.getHeight() - 16, size: 9, font,
        color: changed ? rgb(0.85, 0.18, 0.13) : rgb(0.45, 0.45, 0.45),
      });

      const textA = inA ? await pageText(pdfA, i) : '';
      const textB = inB ? await pageText(pdfB, i) : '';
      const { removed, added } = diffLines(textA, textB);
      if (removed.length || added.length) {
        report.push(`── ${i}쪽 ──`);
        removed.forEach(l => report.push(`  - ${l}`));
        added.forEach(l => report.push(`  + ${l}`));
        report.push('');
      }
      if (canvasA) canvasA.width = canvasA.height = 0;
      if (canvasB && canvasB !== shown) canvasB.width = canvasB.height = 0;
      shown.width = shown.height = 0;
    }

    onProgress?.(total, total, '');
    return {
      blob: await saveDoc(out),
      report: report.length
        ? `달라진 곳\n\n${report.join('\n')}`
        : '글자 내용에서 달라진 곳을 찾지 못했습니다.',
      totalPages: total,
      changedPages,
    };
  }

  /** canvasB 위에 canvasA 와 다른 칸을 붉게 덧칠한다. 달라진 곳이 있으면 true. */
  function markDifferences(canvasA, canvasB, cell, tolerance) {
    const w = Math.min(canvasA.width, canvasB.width);
    const h = Math.min(canvasA.height, canvasB.height);
    const ctxA = canvasA.getContext('2d');
    const ctxB = canvasB.getContext('2d');
    const da = ctxA.getImageData(0, 0, w, h).data;
    const db = ctxB.getImageData(0, 0, w, h).data;

    ctxB.fillStyle = 'rgba(217, 45, 32, .30)';
    let any = false;

    for (let cy = 0; cy < h; cy += cell) {
      for (let cx = 0; cx < w; cx += cell) {
        let differs = false;
        for (let y = cy; y < Math.min(cy + cell, h) && !differs; y++) {
          for (let x = cx; x < Math.min(cx + cell, w); x++) {
            const k = (y * w + x) * 4;
            if (Math.abs(da[k] - db[k]) > tolerance ||
                Math.abs(da[k + 1] - db[k + 1]) > tolerance ||
                Math.abs(da[k + 2] - db[k + 2]) > tolerance) { differs = true; break; }
          }
        }
        if (differs) { ctxB.fillRect(cx, cy, cell, cell); any = true; }
      }
    }
    // 크기 자체가 다르면 그것도 차이다.
    if (canvasA.width !== canvasB.width || canvasA.height !== canvasB.height) any = true;
    return any;
  }

  return {
    formatBytes, baseName, extOf, parsePageRanges, download,
    loadDoc, saveDoc, openWithPdfjs, renderPage,
    mergePdfs, pickPages, splitPdf, rotatePdf, cropPdf,
    addPageNumbers, addWatermark, protectPdf, unlockPdf,
    pdfToImages, imagesToPdf, compressPdf, repairPdf, buildFromPages,
    applyEdits, comparePdfs, zipAll,
  };
})();
