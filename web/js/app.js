/*
 * app.js — 화면 전환과 실행 흐름을 잇는다.
 */
'use strict';

(() => {

  const viewHome = document.getElementById('viewHome');
  const viewTool = document.getElementById('viewTool');
  const toolGrid = document.getElementById('toolGrid');
  const toolTitle = document.getElementById('toolTitle');
  const toolDesc = document.getElementById('toolDesc');
  const optionTitle = document.getElementById('optionTitle');

  let current = null;

  /* ── 홈 화면 ─────────────────────────────────── */

  function renderHome() {
    toolGrid.textContent = '';
    for (const category of CATEGORY_ORDER) {
      const inCategory = TOOLS.filter(t => t.category === category);
      if (!inCategory.length) continue;

      const label = document.createElement('h2');
      label.className = 'cat-label';
      label.textContent = category;
      toolGrid.appendChild(label);

      for (const tool of inCategory) {
        const card = document.createElement('a');
        card.className = 'tool-card';
        card.href = `#/tool/${tool.id}`;

        const icon = document.createElement('div');
        icon.className = 'icon';
        icon.textContent = tool.icon;
        card.appendChild(icon);

        const h3 = document.createElement('h3');
        h3.textContent = tool.name;
        card.appendChild(h3);

        const p = document.createElement('p');
        p.textContent = tool.desc;
        card.appendChild(p);

        if (tool.tag === 'new') {
          const tag = document.createElement('span');
          tag.className = 'tag tag-new';
          tag.textContent = 'NEW';
          card.appendChild(tag);
        } else if (tool.needsEngine) {
          const tag = document.createElement('span');
          tag.className = 'tag tag-engine';
          tag.textContent = '엔진 필요';
          card.appendChild(tag);
        }
        toolGrid.appendChild(card);
      }
    }
  }

  /* ── 도구 화면 ───────────────────────────────── */

  function openTool(tool) {
    current = tool;
    viewHome.hidden = true;
    viewTool.hidden = false;
    toolTitle.textContent = tool.name;
    toolDesc.textContent = tool.desc;
    optionTitle.textContent = tool.options?.length ? '설정' : '실행';

    PageWork.reset();
    Editor.reset();
    Scanner.hide();
    const signBox = document.getElementById('signBox');
    signBox.hidden = tool.editorMode !== 'image';
    // 칸이 보이게 된 다음에야 캔버스 크기를 잡을 수 있다.
    if (!signBox.hidden) requestAnimationFrame(() => SignPad.refresh());
    UI.el.dropzone.hidden = tool.workspace === 'camera';
    UI.setTool(tool, onFilesChanged);
    UI.buildOptions(tool.options);
    UI.setNote(tool.note || '');
    updateRunState(UI.getFiles());
    window.scrollTo(0, 0);
  }

  // needsEngine 값에 따라 부족한 것이 무엇인지 구체적으로 알려준다.
  const ENGINE_HINTS = {
    hwp: '한글 문서 변환에는 한컴오피스가 설치된 Windows가 필요합니다.',
    browser: '웹페이지 변환에는 Chrome 또는 Microsoft Edge가 필요합니다.',
    ghostscript: 'PDF/A 변환에는 Ghostscript가 필요합니다. 설치 후 start.bat 을 다시 실행해 주세요.',
    export: '이 변환은 로컬 엔진이 처리합니다.',
  };

  /**
   * 파일 목록이 바뀔 때 불린다. 쪽 단위로 작업하는 도구라면 여기서 PDF 를 열어
   * 모든 쪽의 미리보기를 만든다. 큰 문서는 시간이 걸리므로 진행 창을 띄운다.
   */
  async function onFilesChanged(files) {
    updateRunState(files);
    if (current?.workspace === 'camera') {
      // 카메라 도구는 파일을 올릴 일이 없다. 올려둔 파일 칸을 감춘다.
      UI.el.fileList.hidden = true;
      UI.el.dropzone.hidden = true;
      Scanner.show(showScanStats);
      return;
    }

    if (current?.workspace === 'canvas') {
      UI.el.fileList.hidden = true;
      if (!files.length) { Editor.reset(); return; }
      try {
        UI.showBusy('쪽 여는 중…');
        await Editor.load(files[0], { mode: current.editorMode, onStateChange: showEditStats });
        UI.closeOverlay();
        showEditStats(Editor.stats());
      } catch (e) {
        UI.showError('이 PDF를 열지 못했습니다. ' + (e?.message || ''));
        Editor.reset();
      }
      updateRunState(files);
      return;
    }

    if (current?.workspace !== 'pages') return;

    // 쪽 화면에서는 파일 카드가 군더더기라 감춘다.
    UI.el.fileList.hidden = true;

    if (!files.length) { PageWork.reset(); return; }
    try {
      UI.showBusy('쪽 미리보기 만드는 중…');
      await PageWork.load(files[0], {
        onProgress: (i, n, msg) => UI.progress(Math.round(i * 100 / Math.max(n, 1)), msg),
        onStateChange: showPageStats,
      });
      UI.closeOverlay();
      showPageStats(PageWork.stats());
    } catch (e) {
      UI.showError('이 PDF의 쪽을 펼치지 못했습니다. ' + (e?.message || ''));
      PageWork.reset();
    }
    updateRunState(files);
  }

  function showScanStats(st) {
    UI.setNote(st.count ? `${st.count}장 찍었습니다.` : (current?.note || ''));
    UI.el.runBtn.disabled = st.count === 0;
  }

  const EDIT_LABEL = { redact: '가릴 상자', text: '글상자', image: '서명' };

  function showEditStats(st) {
    if (!st.count) { UI.setNote(current?.note || ''); return; }
    const parts = Object.entries(st.byType)
      .map(([k, n]) => `${EDIT_LABEL[k] || k} ${n}개`);
    UI.setNote(parts.join(' · ') + ' 올림');
  }

  function showPageStats(st) {
    const el = document.getElementById('pageStat');
    if (!el) return;
    el.textContent = st.removed
      ? `${st.total}쪽 중 ${st.kept}쪽 남김 · ${st.removed}쪽 뺌`
      : `${st.total}쪽`;
  }

  function updateRunState(files) {
    const btn = UI.el.runBtn;
    const need = current?.needsEngine;

    if (need && !Backend.isReady()) {
      btn.disabled = true;
      // 웹에 올라간 판을 보는 사람에게는 start.bat 이 없다. 내려받는 것부터 안내한다.
      if (Backend.canReachEngine) {
        btn.textContent = '로컬 엔진이 필요합니다';
        UI.setNote('start.bat 을 실행하면 이 도구가 켜집니다.');
      } else {
        btn.textContent = '내 컴퓨터에서만 됩니다';
        UI.setNote('한글·오피스 변환은 웹에서 할 수 없습니다. 위 GitHub 링크에서 내려받아 '
                 + 'start.bat 을 실행하면 이 도구를 쓸 수 있습니다.');
      }
      return;
    }
    if (need && !Backend.has(need)) {
      btn.disabled = true;
      btn.textContent = '사용할 수 없습니다';
      UI.setNote(ENGINE_HINTS[need] || '필요한 프로그램이 설치되어 있지 않습니다.');
      return;
    }

    btn.textContent = current ? current.name : '실행';
    if (current?.workspace === 'camera') {
      btn.disabled = Scanner.count() === 0;
      return;
    }
    // 파일 없이도 실행할 수 있는 도구가 있다(예: 주소만 넣는 웹페이지 변환).
    btn.disabled = current?.optionalFiles ? false : !files.length;
    if (!need && !current?.note) UI.setNote('');
  }

  function showHome() {
    current = null;
    viewTool.hidden = true;
    viewHome.hidden = false;
    window.scrollTo(0, 0);
  }

  /* ── 실행 ────────────────────────────────────── */

  function isPasswordError(err) {
    return err && (err.name === 'EncryptedPDFError'
      || /encrypt|password|암호/i.test(err.message || ''));
  }

  async function run() {
    if (!current) return;
    const files = UI.getFiles();
    if (!files.length && !current.optionalFiles) return;

    UI.showBusy(`${current.name} 처리 중…`);

    const ctx = {
      password: undefined,
      progress: (pct, msg) => UI.progress(pct, msg),
      note: text => { ctx._note = text; },
    };

    const attempt = async () => current.run(files, UI.getOptions(), ctx);

    try {
      let results;
      try {
        results = await attempt();
      } catch (err) {
        // 암호가 걸린 PDF 였다면 한 번만 물어보고 다시 시도한다.
        if (!ctx.password && isPasswordError(err) && current.id !== 'unlock' && current.id !== 'protect') {
          const pw = window.prompt('이 PDF에는 암호가 걸려 있습니다. 암호를 입력해 주세요.');
          if (!pw) throw new Error('암호가 걸린 PDF입니다. 암호를 입력해야 처리할 수 있습니다.');
          ctx.password = pw;
          UI.showBusy(`${current.name} 처리 중…`);
          results = await attempt();
        } else {
          throw err;
        }
      }

      if (!results || !results.length) throw new Error('결과 파일이 만들어지지 않았습니다.');
      UI.progress(100, '');
      const note = ctx._note || (results.length > 1
        ? `${results.length}개 파일이 만들어졌습니다. 눌러서 저장하세요.`
        : '저장이 시작되지 않으면 아래를 눌러 주세요.');
      UI.showResults(results, note);
    } catch (err) {
      console.error(err);
      UI.showError(err?.message || String(err));
    }
  }

  UI.el.runBtn.addEventListener('click', run);

  const signState = document.getElementById('signState');
  const signUpload = document.getElementById('signUpload');

  document.getElementById('signUse')?.addEventListener('click', () => {
    const url = SignPad.toDataUrl();
    if (!url) { signState.textContent = '먼저 위 칸에 서명을 그려 주세요.'; return; }
    Editor.setPendingImage(url);
    signState.textContent = '준비됐습니다. 문서에서 넣을 자리를 누르세요.';
  });

  document.getElementById('signUploadBtn')?.addEventListener('click', () => signUpload?.click());
  signUpload?.addEventListener('change', () => {
    const f = signUpload.files?.[0];
    if (!f) return;
    const reader = new FileReader();
    reader.onload = () => {
      Editor.setPendingImage(String(reader.result));
      signState.textContent = `${f.name} 준비됐습니다. 넣을 자리를 누르세요.`;
    };
    reader.readAsDataURL(f);
    signUpload.value = '';
  });

  document.getElementById('rotAllLeft')?.addEventListener('click', () => PageWork.rotateAll(-90));
  document.getElementById('rotAllRight')?.addEventListener('click', () => PageWork.rotateAll(90));
  document.getElementById('restoreAll')?.addEventListener('click', () => PageWork.restoreAll());

  /* ── 라우팅 ──────────────────────────────────── */

  function route() {
    const match = /^#\/tool\/([\w-]+)/.exec(location.hash);
    const tool = match ? findTool(match[1]) : null;
    if (tool) openTool(tool);
    else showHome();
  }

  window.addEventListener('hashchange', route);

  /* ── 시작 ────────────────────────────────────── */

  applyBrand();
  renderHome();
  route();

  Backend.onChange(info => {
    UI.setEngineBadge(info);
    if (current) updateRunState(UI.getFiles());
  });
  Backend.detect();
  // 사용자가 나중에 엔진을 켤 수 있으므로 주기적으로 다시 확인한다.
  // 다만 웹에 올라간 판에서는 어차피 닿을 수 없으므로 두드리지 않는다.
  if (Backend.canReachEngine) {
    setInterval(() => { if (!Backend.isReady()) Backend.detect(); }, 15000);
  }
})();
