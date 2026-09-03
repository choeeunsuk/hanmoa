/*
 * pages.js — 쪽 단위 작업 공간.
 *
 * 파일 목록 대신 PDF 의 각 쪽을 카드로 펼쳐 놓고, 끌어서 순서를 바꾸거나
 * 돌리거나 뺄 수 있게 한다. '페이지 정리' 도구가 이 화면을 쓴다.
 *
 * 쪽 그림은 한 번만 그려 두고, 회전은 카드에 CSS transform 만 걸어 보여준다.
 * 다시 그리지 않으므로 수백 쪽짜리 문서에서도 회전이 즉시 반응한다.
 */
'use strict';

const PageWork = (() => {

  const grid = document.getElementById('pageGrid');
  const bar = document.getElementById('pageBar');

  let pages = [];        // { index, rotation, deleted, thumb }
  let sourceFile = null;
  let onChange = null;
  let loadToken = 0;     // 늦게 끝난 이전 load 가 새 결과를 덮어쓰지 못하게 막는다

  function reset() {
    pages = [];
    sourceFile = null;
    grid.textContent = '';
    grid.hidden = true;
    if (bar) bar.hidden = true;
  }

  /**
   * PDF 를 열어 모든 쪽의 미리보기를 만든다.
   *
   * 쪽을 하나씩 비동기로 그리므로, 앞선 호출이 끝나기 전에 다시 불리면 두 결과가
   * 섞여 쪽이 두 배로 늘어난다. 호출마다 표를 하나 뽑아 두고, 표가 바뀌면 이전
   * 작업은 조용히 손을 뗀다.
   */
  async function load(file, { password, onProgress, onStateChange } = {}) {
    const token = ++loadToken;
    reset();
    loadToken = token;          // reset() 이 건드리지 않도록 다시 세운다
    sourceFile = file;
    onChange = onStateChange;

    const pdf = await Core.openWithPdfjs(file, password);
    if (token !== loadToken) return 0;
    const total = pdf.numPages;
    const built = [];

    for (let i = 1; i <= total; i++) {
      if (token !== loadToken) return 0;
      onProgress?.(i - 1, total, `${i}/${total}쪽 미리보기 만드는 중`);
      // 너무 큰 문서에서 메모리가 터지지 않도록 작게 그린다.
      const canvas = await Core.renderPage(pdf, i, 0.32);
      built.push({ index: i - 1, rotation: 0, deleted: false, thumb: canvas });
    }
    if (token !== loadToken) return 0;

    pages = built;
    onProgress?.(total, total, '');
    render();
    return total;
  }

  /** 현재 상태를 결과로 낼 순서대로 돌려준다. 뺀 쪽은 빠진다. */
  function getState() {
    return pages.filter(p => !p.deleted)
                .map(p => ({ index: p.index, rotation: ((p.rotation % 360) + 360) % 360 }));
  }

  function stats() {
    const kept = pages.filter(p => !p.deleted).length;
    return { total: pages.length, kept, removed: pages.length - kept };
  }

  function notify() {
    render();
    onChange?.(stats());
  }

  function rotate(pos, delta) {
    pages[pos].rotation = (pages[pos].rotation + delta + 360) % 360;
    notify();
  }

  function toggleDelete(pos) {
    pages[pos].deleted = !pages[pos].deleted;
    notify();
  }

  function move(from, to) {
    if (from === to || from < 0 || to < 0 || from >= pages.length || to >= pages.length) return;
    const [item] = pages.splice(from, 1);
    pages.splice(to, 0, item);
    notify();
  }

  function rotateAll(delta) {
    pages.forEach(p => { if (!p.deleted) p.rotation = (p.rotation + delta + 360) % 360; });
    notify();
  }

  /** 순서·회전·뺀 쪽을 모두 처음 상태로 돌린다. */
  function restoreAll() {
    pages.forEach(p => { p.deleted = false; p.rotation = 0; });
    pages.sort((a, b) => a.index - b.index);
    notify();
  }

  /* ── 그리기 ──────────────────────────────────── */

  function render() {
    grid.hidden = pages.length === 0;
    if (bar) bar.hidden = pages.length === 0;
    grid.textContent = '';

    pages.forEach((page, pos) => {
      const card = document.createElement('div');
      card.className = 'page-card' + (page.deleted ? ' removed' : '');
      card.draggable = !page.deleted;
      card.dataset.pos = String(pos);

      const holder = document.createElement('div');
      holder.className = 'page-thumb';
      const img = page.thumb;
      img.style.transform = `rotate(${page.rotation}deg)`;
      // 90/270도로 돌면 가로세로가 바뀌므로 칸에 맞게 줄인다.
      img.style.maxWidth = page.rotation % 180 ? '72%' : '100%';
      img.style.maxHeight = page.rotation % 180 ? '72%' : '100%';
      holder.appendChild(img);
      card.appendChild(holder);

      const num = document.createElement('span');
      num.className = 'page-num';
      num.textContent = String(page.index + 1);
      card.appendChild(num);

      const tools = document.createElement('div');
      tools.className = 'page-tools';
      tools.appendChild(iconBtn('↺', '왼쪽으로 돌리기', () => rotate(pos, -90)));
      tools.appendChild(iconBtn('↻', '오른쪽으로 돌리기', () => rotate(pos, 90)));
      tools.appendChild(iconBtn(page.deleted ? '↩' : '✕',
                                page.deleted ? '되살리기' : '이 쪽 빼기',
                                () => toggleDelete(pos)));
      card.appendChild(tools);

      grid.appendChild(card);
    });
  }

  function iconBtn(label, title, handler) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'page-btn';
    b.textContent = label;
    b.title = title;
    b.setAttribute('aria-label', title);
    b.addEventListener('click', e => { e.stopPropagation(); handler(); });
    return b;
  }

  /* ── 끌어서 순서 바꾸기 ──────────────────────── */

  let dragFrom = -1;

  grid.addEventListener('dragstart', e => {
    const card = e.target.closest('.page-card');
    if (!card) return;
    dragFrom = Number(card.dataset.pos);
    card.classList.add('dragging');
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', String(dragFrom));
  });

  grid.addEventListener('dragend', () => {
    dragFrom = -1;
    grid.querySelectorAll('.page-card').forEach(c => c.classList.remove('dragging', 'drop-target'));
  });

  grid.addEventListener('dragover', e => {
    if (dragFrom < 0) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    const card = e.target.closest('.page-card');
    grid.querySelectorAll('.page-card').forEach(c => c.classList.remove('drop-target'));
    if (card && Number(card.dataset.pos) !== dragFrom) card.classList.add('drop-target');
  });

  grid.addEventListener('drop', e => {
    if (dragFrom < 0) return;
    e.preventDefault();
    e.stopPropagation();
    const card = e.target.closest('.page-card');
    if (card) move(dragFrom, Number(card.dataset.pos));
    dragFrom = -1;
  });

  return { load, reset, getState, stats, rotateAll, restoreAll, get file() { return sourceFile; } };
})();
