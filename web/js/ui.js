/*
 * ui.js — 화면 조립. 파일 목록, 드래그 정렬, 미리보기, 옵션 패널, 진행/결과 창.
 */
'use strict';

const UI = (() => {

  const $ = id => document.getElementById(id);

  const el = {
    dropzone: $('dropzone'), fileInput: $('fileInput'), pickBtn: $('pickBtn'),
    fileList: $('fileList'), dzSub: $('dzSub'), sortHint: $('sortHint'),
    optionPanel: $('optionPanel'), optionTitle: $('optionTitle'),
    runBtn: $('runBtn'), sideNote: $('sideNote'),
    overlay: $('overlay'), ovBusy: $('ovBusy'), ovDone: $('ovDone'), ovError: $('ovError'),
    ovTitle: $('ovTitle'), ovMsg: $('ovMsg'), ovBar: $('ovBar'),
    ovDoneMsg: $('ovDoneMsg'), ovDownloads: $('ovDownloads'),
    ovErrMsg: $('ovErrMsg'), ovClose: $('ovClose'), ovErrClose: $('ovErrClose'),
    engineBadge: $('engineBadge'),
  };

  /* ── 파일 목록 상태 ─────────────────────────────── */

  let files = [];        // File 객체 배열. 순서가 곧 처리 순서다.
  let tool = null;       // 현재 도구 정의
  let onFilesChanged = null;

  function setTool(t, changedCb) {
    tool = t;
    onFilesChanged = changedCb;
    files = [];
    el.fileInput.multiple = !!t.multiple;
    el.fileInput.accept = (t.accept || []).join(',');
    el.dzSub.textContent = t.acceptLabel || '';
    render();
  }

  function getFiles() { return files.slice(); }

  function accepts(file) {
    if (!tool || !tool.accept || !tool.accept.length) return true;
    const ext = Core.extOf(file.name);
    return tool.accept.includes(ext);
  }

  function addFiles(incoming) {
    const list = Array.from(incoming).filter(f => f.size > 0);
    const good = list.filter(accepts);
    const bad = list.filter(f => !accepts(f));

    if (!tool.multiple) {
      files = good.slice(0, 1);
    } else {
      // 같은 파일을 두 번 넣는 실수를 막는다(이름+크기+수정시각으로 판단).
      const key = f => `${f.name}|${f.size}|${f.lastModified}`;
      const seen = new Set(files.map(key));
      good.forEach(f => { if (!seen.has(key(f))) { seen.add(key(f)); files.push(f); } });
    }
    render();   // render() 안에서 onFilesChanged 가 한 번만 나간다
    if (bad.length) {
      const names = bad.map(f => f.name).join(', ');
      toast(`이 도구에서 지원하지 않는 형식이라 제외했습니다: ${names}`);
    }
  }

  function removeFile(i) {
    files.splice(i, 1);
    render();
  }

  function move(from, to) {
    if (from === to || from < 0 || to < 0 || from >= files.length || to >= files.length) return;
    const [item] = files.splice(from, 1);
    files.splice(to, 0, item);
    render();
  }

  /* ── 미리보기 ──────────────────────────────────── */

  const ICONS = {
    '.hwp': '📄', '.hwpx': '📄', '.hml': '📄',
    '.doc': '📝', '.docx': '📝', '.rtf': '📝', '.odt': '📝', '.txt': '📝',
    '.xls': '📊', '.xlsx': '📊', '.csv': '📊',
    '.ppt': '📽️', '.pptx': '📽️',
  };

  /** PDF 첫 페이지 또는 이미지 자체를 카드 안에 그려준다. 실패하면 아이콘으로 둔다. */
  async function paintThumb(file, holder) {
    const ext = Core.extOf(file.name);
    try {
      if (ext === '.pdf') {
        const pdf = await Core.openWithPdfjs(file);
        const canvas = await Core.renderPage(pdf, 1, 0.45);
        holder.textContent = '';
        canvas.style.width = '100%';
        canvas.style.height = '100%';
        canvas.style.objectFit = 'contain';
        holder.appendChild(canvas);
        return pdf.numPages;
      }
      if (file.type.startsWith('image/')) {
        const img = document.createElement('img');
        img.src = URL.createObjectURL(file);
        img.onload = () => URL.revokeObjectURL(img.src);
        img.alt = '';
        holder.textContent = '';
        holder.appendChild(img);
      }
    } catch (e) {
      // 암호가 걸린 PDF 등은 미리보기를 만들 수 없다. 아이콘을 유지한다.
    }
    return null;
  }

  function render() {
    const has = files.length > 0;
    el.fileList.hidden = !has;
    el.sortHint.hidden = !(has && tool?.multiple && files.length > 1);
    el.dropzone.querySelector('.dz-title').textContent =
      has ? '파일을 더 추가하려면 여기에 놓으세요' : '파일을 여기에 끌어다 놓으세요';

    el.fileList.textContent = '';
    files.forEach((file, i) => {
      const card = document.createElement('div');
      card.className = 'file-card';
      card.draggable = !!tool?.multiple;
      card.dataset.index = String(i);

      if (tool?.multiple) {
        const order = document.createElement('div');
        order.className = 'order';
        order.textContent = String(i + 1);
        card.appendChild(order);
      }

      const rm = document.createElement('button');
      rm.type = 'button';
      rm.className = 'remove';
      rm.textContent = '×';
      rm.title = '목록에서 빼기';
      rm.setAttribute('aria-label', `${file.name} 빼기`);
      rm.addEventListener('click', ev => { ev.stopPropagation(); removeFile(i); });
      card.appendChild(rm);

      const thumb = document.createElement('div');
      thumb.className = 'thumb';
      thumb.textContent = ICONS[Core.extOf(file.name)] || '📄';
      card.appendChild(thumb);

      const name = document.createElement('div');
      name.className = 'name';
      name.textContent = file.name;
      name.title = file.name;
      card.appendChild(name);

      const meta = document.createElement('div');
      meta.className = 'meta';
      meta.textContent = Core.formatBytes(file.size);
      card.appendChild(meta);

      el.fileList.appendChild(card);
      paintThumb(file, thumb).then(pages => {
        if (pages) meta.textContent = `${pages}쪽 · ${Core.formatBytes(file.size)}`;
      });
    });

    // 실행 가능 여부는 app.js 가 도구별 조건까지 보고 결정한다.
    onFilesChanged?.(files);
  }

  /* ── 드래그로 순서 바꾸기 ───────────────────────── */

  let dragFrom = -1;

  el.fileList.addEventListener('dragstart', e => {
    const card = e.target.closest('.file-card');
    if (!card) return;
    dragFrom = Number(card.dataset.index);
    card.classList.add('dragging');
    e.dataTransfer.effectAllowed = 'move';
    // Firefox 는 데이터가 없으면 드래그를 시작하지 않는다.
    e.dataTransfer.setData('text/plain', String(dragFrom));
  });

  el.fileList.addEventListener('dragend', () => {
    dragFrom = -1;
    el.fileList.querySelectorAll('.file-card')
      .forEach(c => c.classList.remove('dragging', 'drop-target'));
  });

  el.fileList.addEventListener('dragover', e => {
    if (dragFrom < 0) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    const card = e.target.closest('.file-card');
    el.fileList.querySelectorAll('.file-card').forEach(c => c.classList.remove('drop-target'));
    if (card && Number(card.dataset.index) !== dragFrom) card.classList.add('drop-target');
  });

  el.fileList.addEventListener('drop', e => {
    if (dragFrom < 0) return;
    e.preventDefault();
    e.stopPropagation();
    const card = e.target.closest('.file-card');
    if (card) move(dragFrom, Number(card.dataset.index));
    dragFrom = -1;
  });

  /* ── 드롭존 ────────────────────────────────────── */

  el.pickBtn.addEventListener('click', e => { e.stopPropagation(); el.fileInput.click(); });
  el.dropzone.addEventListener('click', () => el.fileInput.click());
  el.dropzone.addEventListener('keydown', e => {
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); el.fileInput.click(); }
  });
  el.fileInput.addEventListener('change', () => {
    if (el.fileInput.files.length) addFiles(el.fileInput.files);
    el.fileInput.value = '';   // 같은 파일을 연달아 고를 수 있게 초기화한다.
  });

  ['dragenter', 'dragover'].forEach(ev =>
    el.dropzone.addEventListener(ev, e => { e.preventDefault(); el.dropzone.classList.add('over'); }));
  ['dragleave', 'drop'].forEach(ev =>
    el.dropzone.addEventListener(ev, () => el.dropzone.classList.remove('over')));
  el.dropzone.addEventListener('drop', e => {
    e.preventDefault();
    if (e.dataTransfer?.files?.length) addFiles(e.dataTransfer.files);
  });
  // 창 전체에 떨어뜨린 파일이 브라우저에서 그냥 열리는 것을 막는다.
  window.addEventListener('dragover', e => e.preventDefault());
  window.addEventListener('drop', e => e.preventDefault());

  /* ── 옵션 패널 ─────────────────────────────────── */

  const values = {};

  /** 도구 정의의 options 스키마로 폼을 만든다. */
  function buildOptions(schema) {
    Object.keys(values).forEach(k => delete values[k]);
    el.optionPanel.textContent = '';

    if (!schema || !schema.length) {
      const p = document.createElement('p');
      p.className = 'empty-note';
      p.textContent = '따로 설정할 항목이 없습니다. 파일을 올리고 실행하세요.';
      el.optionPanel.appendChild(p);
      return;
    }

    for (const f of schema) {
      values[f.key] = f.value;
      const wrap = document.createElement('div');

      if (f.type === 'checkbox') {
        wrap.className = 'check-row';
        const input = document.createElement('input');
        input.type = 'checkbox';
        input.id = 'opt_' + f.key;
        input.checked = !!f.value;
        input.addEventListener('change', () => { values[f.key] = input.checked; refreshVisibility(schema); });
        const label = document.createElement('label');
        label.htmlFor = input.id;
        label.textContent = f.label;
        wrap.append(input, label);
      } else {
        wrap.className = 'field';
        const label = document.createElement('label');
        label.htmlFor = 'opt_' + f.key;
        label.textContent = f.label;
        wrap.appendChild(label);

        let input;
        if (f.type === 'select') {
          input = document.createElement('select');
          for (const o of f.choices) {
            const opt = document.createElement('option');
            opt.value = o.value;
            opt.textContent = o.label;
            input.appendChild(opt);
          }
          input.value = f.value;
          input.addEventListener('change', () => { values[f.key] = input.value; refreshVisibility(schema); });
        } else {
          input = document.createElement('input');
          input.type = f.type || 'text';
          if (f.type === 'number') { input.min = f.min ?? 0; input.max = f.max ?? 9999; input.step = f.step ?? 1; }
          input.value = f.value ?? '';
          if (f.placeholder) input.placeholder = f.placeholder;
          input.addEventListener('input', () => {
            values[f.key] = f.type === 'number' ? Number(input.value) : input.value;
          });
        }
        input.id = 'opt_' + f.key;
        wrap.appendChild(input);

        if (f.desc) {
          const d = document.createElement('p');
          d.className = 'desc';
          d.textContent = f.desc;
          wrap.appendChild(d);
        }
      }
      wrap.dataset.key = f.key;
      el.optionPanel.appendChild(wrap);
    }
    refreshVisibility(schema);
  }

  /** showIf 조건이 달린 항목을 현재 값에 맞춰 보이거나 감춘다. */
  function refreshVisibility(schema) {
    for (const f of schema) {
      if (!f.showIf) continue;
      const node = el.optionPanel.querySelector(`[data-key="${f.key}"]`);
      if (node) node.hidden = !f.showIf(values);
    }
  }

  function getOptions() { return { ...values }; }

  /* ── 진행 / 결과 창 ─────────────────────────────── */

  function showBusy(title) {
    el.overlay.hidden = false;
    el.ovBusy.hidden = false;
    el.ovDone.hidden = true;
    el.ovError.hidden = true;
    el.ovTitle.textContent = title || '처리 중…';
    el.ovMsg.textContent = '';
    el.ovBar.style.width = '0%';
  }

  function progress(pct, message) {
    el.ovBar.style.width = Math.max(0, Math.min(100, pct)) + '%';
    if (message != null) el.ovMsg.textContent = message;
  }

  function showResults(items, note) {
    el.ovBusy.hidden = true;
    el.ovError.hidden = true;
    el.ovDone.hidden = false;
    el.ovDoneMsg.textContent = note || '';
    el.ovDownloads.textContent = '';

    for (const item of items) {
      const row = document.createElement('button');
      row.type = 'button';
      row.className = 'dl-item';
      const name = document.createElement('span');
      name.textContent = item.name;
      const size = document.createElement('b');
      size.textContent = Core.formatBytes(item.blob.size) + ' ↓';
      row.append(name, size);
      row.addEventListener('click', () => Core.download(item.blob, item.name));
      el.ovDownloads.appendChild(row);
    }
    // 결과가 하나뿐이면 바로 저장을 시작한다.
    if (items.length === 1) Core.download(items[0].blob, items[0].name);
  }

  function showError(message) {
    el.ovBusy.hidden = true;
    el.ovDone.hidden = true;
    el.ovError.hidden = false;
    el.ovErrMsg.textContent = message || '알 수 없는 오류가 발생했습니다.';
  }

  function closeOverlay() { el.overlay.hidden = true; }

  el.ovClose.addEventListener('click', closeOverlay);
  el.ovErrClose.addEventListener('click', closeOverlay);
  el.overlay.addEventListener('click', e => { if (e.target === el.overlay && el.ovBusy.hidden) closeOverlay(); });
  document.addEventListener('keydown', e => { if (e.key === 'Escape' && el.ovBusy.hidden) closeOverlay(); });

  /* ── 기타 ──────────────────────────────────────── */

  function toast(message) {
    el.sideNote.textContent = message;
    setTimeout(() => { if (el.sideNote.textContent === message) el.sideNote.textContent = ''; }, 6000);
  }

  function setNote(text) { el.sideNote.textContent = text || ''; }

  function setEngineBadge(info) {
    const badge = el.engineBadge;
    const text = badge.querySelector('.engine-text');
    if (info) {
      const names = [];
      if (info.engines?.hwp) names.push('한글');
      if (info.engines?.word) names.push('오피스');
      badge.className = 'engine-badge on';
      text.textContent = names.length ? `엔진 연결됨 · ${names.join('·')}` : '엔진 연결됨';
      badge.title = '한글·오피스 문서 변환을 쓸 수 있습니다.';
    } else {
      badge.className = 'engine-badge off';
      // 웹에 올라간 판은 애초에 내 컴퓨터의 엔진에 닿을 수 없다. 켜라고 하면 오해를 준다.
      const remote = Backend.canReachEngine === false;
      text.textContent = remote ? '웹판' : '엔진 없음';
      badge.title = remote
        ? '이 웹판은 브라우저만으로 도는 도구를 제공합니다. 한글·오피스 변환은 프로젝트를 내려받아 start.bat 을 실행해야 합니다.'
        : '한글·오피스 변환을 쓰려면 start.bat 을 실행하세요. 나머지 도구는 그대로 동작합니다.';
    }
  }

  return {
    el, setTool, getFiles, addFiles, render,
    buildOptions, getOptions,
    showBusy, progress, showResults, showError, closeOverlay,
    toast, setNote, setEngineBadge,
  };
})();
