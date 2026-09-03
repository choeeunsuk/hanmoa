/*
 * editor.js — 쪽 위에 무언가를 얹는 편집기.
 *
 * 서명 넣기, 글자 넣기, 검은 칠 세 도구가 이 화면을 함께 쓴다. 하는 일이
 * "쪽의 어느 자리에 무엇을 얹을지 정한다"로 똑같기 때문이다.
 *
 * 얹은 항목의 좌표는 쪽 크기에 대한 비율로 들고 있다. 그래야 화면 배율이나
 * 창 크기가 달라져도 결과가 흔들리지 않는다. 실제로 PDF 에 새기는 일은
 * Core.applyEdits 가 한다.
 */
'use strict';

const Editor = (() => {

  const root = document.getElementById('editor');
  const stage = document.getElementById('editStage');
  const canvasHolder = document.getElementById('editCanvas');
  const layer = document.getElementById('editLayer');
  const pageLabel = document.getElementById('editPageLabel');
  const hint = document.getElementById('editHint');

  let viewer = null;          // pdf.js 문서
  let file = null;
  let pageNo = 1;             // 1부터
  let pageCount = 0;
  let items = [];             // { id, type, page(0부터), x, y, w, h, ... }
  let mode = 'redact';        // redact | text | image
  let pending = null;         // 그림 도구가 쓸 dataUrl
  let textDefaults = { text: '확인', color: '#111111', bold: true };
  let seq = 0;
  let onChange = null;

  const HINTS = {
    redact: '가릴 곳을 마우스로 끌어 상자를 그리세요. 그 부분은 되살릴 수 없게 지워집니다.',
    text: '글자를 넣을 자리를 누르세요.',
    image: '서명을 넣을 자리를 누르세요.',
  };

  function reset() {
    viewer = null; file = null; items = []; pageNo = 1; pageCount = 0; pending = null;
    layer.textContent = '';
    canvasHolder.textContent = '';
    root.hidden = true;
  }

  async function load(f, { password, mode: m = 'redact', onStateChange } = {}) {
    reset();
    file = f;
    mode = m;
    onChange = onStateChange;
    viewer = await Core.openWithPdfjs(f, password);
    pageCount = viewer.numPages;
    root.hidden = false;
    hint.textContent = HINTS[mode] || '';
    await showPage(1);
    return pageCount;
  }

  async function showPage(n) {
    pageNo = Math.max(1, Math.min(pageCount, n));
    // 화면 폭에 맞춰 그린다. 너무 크면 느리고 너무 작으면 자리를 못 잡는다.
    const targetWidth = Math.min(stage.clientWidth || 720, 900);
    const first = await viewer.getPage(pageNo);
    const base = first.getViewport({ scale: 1 });
    const scale = targetWidth / base.width;

    const canvas = await Core.renderPage(viewer, pageNo, scale);
    canvasHolder.textContent = '';
    canvas.className = 'edit-page-canvas';
    canvasHolder.appendChild(canvas);
    layer.style.width = canvas.width + 'px';
    layer.style.height = canvas.height + 'px';
    pageLabel.textContent = `${pageNo} / ${pageCount}쪽`;
    renderItems();
  }

  function setMode(m) {
    mode = m;
    hint.textContent = HINTS[m] || '';
  }

  function setPendingImage(dataUrl) { pending = dataUrl; }
  function setTextDefaults(d) { textDefaults = { ...textDefaults, ...d }; }

  function getItems() { return items.slice(); }
  function stats() {
    const byType = {};
    items.forEach(i => { byType[i.type] = (byType[i.type] || 0) + 1; });
    return { count: items.length, byType, pageCount };
  }

  function notify() {
    renderItems();
    onChange?.(stats());
  }

  function addItem(item) {
    items.push({ id: ++seq, page: pageNo - 1, ...item });
    notify();
  }

  function removeItem(id) {
    items = items.filter(i => i.id !== id);
    notify();
  }

  function clearAll() { items = []; notify(); }

  /* ── 항목 그리기 ─────────────────────────────── */

  function renderItems() {
    layer.textContent = '';
    for (const it of items) {
      if (it.page !== pageNo - 1) continue;
      const box = document.createElement('div');
      box.className = 'edit-item edit-' + it.type;
      box.style.left = (it.x * 100) + '%';
      box.style.top = (it.y * 100) + '%';
      box.style.width = (it.w * 100) + '%';
      box.style.height = (it.h * 100) + '%';
      box.dataset.id = String(it.id);

      if (it.type === 'image') {
        const img = document.createElement('img');
        img.src = it.dataUrl;
        img.alt = '';
        box.appendChild(img);
      } else if (it.type === 'text') {
        const span = document.createElement('span');
        span.textContent = it.text;
        span.style.color = it.color;
        span.style.fontWeight = it.bold ? '700' : '400';
        box.appendChild(span);
      }

      const del = document.createElement('button');
      del.type = 'button';
      del.className = 'edit-del';
      del.textContent = '×';
      del.title = '지우기';
      del.setAttribute('aria-label', '이 항목 지우기');
      del.addEventListener('pointerdown', e => e.stopPropagation());
      del.addEventListener('click', e => { e.stopPropagation(); removeItem(it.id); });
      box.appendChild(del);

      const grip = document.createElement('span');
      grip.className = 'edit-grip';
      box.appendChild(grip);

      layer.appendChild(box);
    }
  }

  /* ── 마우스 조작 ─────────────────────────────── */

  function rel(e) {
    const r = layer.getBoundingClientRect();
    return {
      x: Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)),
      y: Math.min(1, Math.max(0, (e.clientY - r.top) / r.height)),
    };
  }

  let drag = null;

  layer.addEventListener('pointerdown', e => {
    const box = e.target.closest('.edit-item');
    const start = rel(e);
    // 포인터를 붙잡아 두면 커서가 쪽 밖으로 나가도 끌기가 이어진다. 다만 이게
    // 실패해도(브라우저마다 조건이 다르다) 조작 자체는 되어야 하므로 감싼다.
    try { layer.setPointerCapture(e.pointerId); } catch (err) { /* 없어도 동작한다 */ }

    if (box) {
      const id = Number(box.dataset.id);
      const it = items.find(i => i.id === id);
      if (!it) return;
      const resizing = e.target.classList.contains('edit-grip');
      drag = { kind: resizing ? 'resize' : 'move', it, start,
               orig: { x: it.x, y: it.y, w: it.w, h: it.h } };
      box.classList.add('active');
      return;
    }

    if (mode === 'redact') {
      drag = { kind: 'draw', start, ghost: makeGhost(start) };
    } else if (mode === 'text') {
      const text = window.prompt('넣을 글자를 입력하세요.', textDefaults.text);
      if (text && text.trim()) {
        addItem({ type: 'text', text: text.trim(), color: textDefaults.color,
                  bold: textDefaults.bold, x: start.x, y: start.y, w: 0.2, h: 0.035 });
      }
    } else if (mode === 'image') {
      if (!pending) {
        hint.textContent = '먼저 오른쪽에서 서명을 그리거나 그림 파일을 올려 주세요.';
        return;
      }
      // 그림 비율을 지켜 기본 크기를 잡는다.
      const img = new Image();
      img.onload = () => {
        const w = 0.22;
        const ratio = img.naturalHeight / img.naturalWidth;
        const layerRatio = layer.clientWidth / layer.clientHeight;
        addItem({ type: 'image', dataUrl: pending,
                  x: Math.min(start.x, 1 - w), y: start.y,
                  w, h: w * ratio * layerRatio });
      };
      img.src = pending;
    }
  });

  layer.addEventListener('pointermove', e => {
    if (!drag) return;
    const now = rel(e);

    if (drag.kind === 'draw') {
      const x = Math.min(drag.start.x, now.x), y = Math.min(drag.start.y, now.y);
      const w = Math.abs(now.x - drag.start.x), h = Math.abs(now.y - drag.start.y);
      Object.assign(drag.ghost.style, {
        left: x * 100 + '%', top: y * 100 + '%',
        width: w * 100 + '%', height: h * 100 + '%',
      });
    } else if (drag.kind === 'move') {
      const it = drag.it;
      it.x = Math.min(1 - it.w, Math.max(0, drag.orig.x + (now.x - drag.start.x)));
      it.y = Math.min(1 - it.h, Math.max(0, drag.orig.y + (now.y - drag.start.y)));
      const box = layer.querySelector(`[data-id="${it.id}"]`);
      if (box) { box.style.left = it.x * 100 + '%'; box.style.top = it.y * 100 + '%'; }
    } else if (drag.kind === 'resize') {
      const it = drag.it;
      it.w = Math.min(1 - it.x, Math.max(0.02, drag.orig.w + (now.x - drag.start.x)));
      it.h = Math.min(1 - it.y, Math.max(0.012, drag.orig.h + (now.y - drag.start.y)));
      const box = layer.querySelector(`[data-id="${it.id}"]`);
      if (box) { box.style.width = it.w * 100 + '%'; box.style.height = it.h * 100 + '%'; }
    }
  });

  layer.addEventListener('pointerup', e => {
    if (!drag) return;
    const now = rel(e);

    if (drag.kind === 'draw') {
      drag.ghost.remove();
      const x = Math.min(drag.start.x, now.x), y = Math.min(drag.start.y, now.y);
      const w = Math.abs(now.x - drag.start.x), h = Math.abs(now.y - drag.start.y);
      // 실수로 살짝 누른 것은 상자로 치지 않는다.
      if (w > 0.008 && h > 0.004) addItem({ type: 'redact', x, y, w, h });
      else notify();
    } else {
      notify();
    }
    drag = null;
    layer.querySelectorAll('.edit-item.active').forEach(b => b.classList.remove('active'));
  });

  function makeGhost(start) {
    const g = document.createElement('div');
    g.className = 'edit-ghost';
    g.style.left = start.x * 100 + '%';
    g.style.top = start.y * 100 + '%';
    layer.appendChild(g);
    return g;
  }

  /* ── 쪽 이동 ─────────────────────────────────── */

  document.getElementById('editPrev')?.addEventListener('click', () => showPage(pageNo - 1));
  document.getElementById('editNext')?.addEventListener('click', () => showPage(pageNo + 1));
  document.getElementById('editClear')?.addEventListener('click', () => clearAll());

  return { load, reset, showPage, setMode, setPendingImage, setTextDefaults,
           getItems, stats, clearAll, get page() { return pageNo; } };
})();


/*
 * 서명 패드 — 마우스나 손가락으로 이름을 그려 투명 배경 PNG 로 만든다.
 * 도장 이미지를 파일로 올려도 된다.
 */
const SignPad = (() => {
  const canvas = document.getElementById('signPad');
  if (!canvas) return { toDataUrl: () => null, clear() {}, isEmpty: () => true };

  const ctx = canvas.getContext('2d');
  let drawing = false;
  let dirty = false;
  let sizedFor = '';

  /**
   * 화면에 실제로 보일 때만 크기를 잡는다.
   *
   * 이 칸은 서명 도구를 열기 전까지 숨어 있다. 숨은 동안 크기를 재면 폭이 0 이라
   * 1x1 짜리 캔버스가 만들어지고, 그 뒤로는 아무리 그어도 아무것도 남지 않는다.
   * 그래서 크기가 잡힐 때까지 기다렸다가 한 번만 맞춘다.
   */
  function resize() {
    const rect = canvas.getBoundingClientRect();
    if (rect.width < 2 || rect.height < 2) return false;

    const dpr = window.devicePixelRatio || 1;
    const key = `${Math.round(rect.width)}x${Math.round(rect.height)}@${dpr}`;
    if (key === sizedFor) return true;      // 같은 크기면 다시 잡지 않는다(내용이 지워지므로)

    canvas.width = Math.round(rect.width * dpr);
    canvas.height = Math.round(rect.height * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.lineWidth = 2.4;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.strokeStyle = '#111111';
    sizedFor = key;
    dirty = false;
    return true;
  }

  /** 서명 도구를 열 때 불린다. 그때가 이 칸이 처음 보이는 순간이다. */
  function refresh() { resize(); }

  // 창 크기나 표시 여부가 바뀌면 알아서 다시 잡는다.
  if (typeof ResizeObserver === 'function') {
    new ResizeObserver(() => resize()).observe(canvas);
  }

  function pos(e) {
    const r = canvas.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  }

  canvas.addEventListener('pointerdown', e => {
    if (!resize()) return;          // 아직 보이지 않으면 그릴 수 없다
    drawing = true; dirty = true;
    try { canvas.setPointerCapture(e.pointerId); } catch (err) { /* 없어도 동작한다 */ }
    const p = pos(e);
    ctx.beginPath();
    ctx.moveTo(p.x, p.y);
  });
  canvas.addEventListener('pointermove', e => {
    if (!drawing) return;
    const p = pos(e);
    ctx.lineTo(p.x, p.y);
    ctx.stroke();
  });
  canvas.addEventListener('pointerup', () => { drawing = false; });
  canvas.addEventListener('pointerleave', () => { drawing = false; });

  function clear() {
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    dirty = false;
  }

  /** 그린 부분만 잘라 투명 PNG 로 만든다. 여백이 붙어 나오면 배치가 어긋난다. */
  function toDataUrl() {
    if (!dirty) return null;
    const img = ctx.getImageData(0, 0, canvas.width, canvas.height);
    let minX = canvas.width, minY = canvas.height, maxX = 0, maxY = 0;
    for (let y = 0; y < canvas.height; y++) {
      for (let x = 0; x < canvas.width; x++) {
        if (img.data[(y * canvas.width + x) * 4 + 3] > 8) {
          if (x < minX) minX = x;
          if (x > maxX) maxX = x;
          if (y < minY) minY = y;
          if (y > maxY) maxY = y;
        }
      }
    }
    if (maxX <= minX || maxY <= minY) return null;
    const pad = 6;
    minX = Math.max(0, minX - pad); minY = Math.max(0, minY - pad);
    maxX = Math.min(canvas.width - 1, maxX + pad);
    maxY = Math.min(canvas.height - 1, maxY + pad);

    const out = document.createElement('canvas');
    out.width = maxX - minX + 1;
    out.height = maxY - minY + 1;
    out.getContext('2d').drawImage(canvas, minX, minY, out.width, out.height,
                                   0, 0, out.width, out.height);
    return out.toDataURL('image/png');
  }

  document.getElementById('signClear')?.addEventListener('click', clear);

  return { toDataUrl, clear, refresh, isEmpty: () => !dirty };
})();
