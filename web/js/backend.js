/*
 * backend.js — 로컬 변환 엔진과의 통신.
 *
 * 한글(HWP)과 MS Office 문서는 해당 프로그램이 설치된 Windows 에서만 PDF 로
 * 바꿀 수 있다. 그래서 이 앱은 내 PC 에서 도는 작은 엔진을 찾아보고, 있으면
 * 관련 도구를 켜고 없으면 안내 문구를 보여준다. 엔진이 없어도 나머지 도구는
 * 전부 그대로 동작한다.
 */
'use strict';

const Backend = (() => {

  // 앱을 엔진이 직접 서빙하고 있으면 같은 출처를, 아니면 기본 포트를 쓴다.
  const SAME_ORIGIN = location.protocol.startsWith('http') ? location.origin : null;
  const CANDIDATES = [SAME_ORIGIN, 'http://localhost:8765', 'http://127.0.0.1:8765']
    .filter(Boolean)
    .filter((v, i, a) => a.indexOf(v) === i);

  /**
   * 이 페이지가 내 컴퓨터에서 열린 것인지 판단한다.
   *
   * GitHub Pages 처럼 https 로 올라간 판에서는 http://localhost 로 보내는 요청을
   * 브라우저가 막는다(혼합 콘텐츠·사설망 접근 제한). 그런 곳에서 15초마다 헛되이
   * 두드리면 콘솔만 시끄러워지므로, 원격 판에서는 한 번만 확인하고 멈춘다.
   */
  const IS_LOCAL_PAGE = ['localhost', '127.0.0.1', '::1'].includes(location.hostname)
    || location.protocol === 'file:';

  let base = null;
  let info = null;
  const listeners = [];

  function onChange(fn) {
    listeners.push(fn);
    if (info !== null) fn(info);
  }

  function notify() {
    listeners.forEach(fn => { try { fn(info); } catch (e) { console.error(e); } });
  }

  async function tryOne(origin) {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), 2500);
    try {
      const res = await fetch(origin + '/api/health', { signal: ctl.signal, cache: 'no-store' });
      if (!res.ok) return null;
      const data = await res.json();
      return data && data.ok ? data : null;
    } catch (e) {
      return null;   // 엔진이 없는 건 흔한 정상 상황이다. 조용히 넘어간다.
    } finally {
      clearTimeout(timer);
    }
  }

  /** 로컬 엔진을 찾는다. 결과는 캐시하지 않고 매번 확인한다(중간에 켤 수 있으므로). */
  async function detect() {
    for (const origin of CANDIDATES) {
      const data = await tryOne(origin);
      if (data) { base = origin; info = data; notify(); return info; }
    }
    base = null; info = false; notify();
    return false;
  }

  function isReady() { return !!info; }
  function engines() { return (info && info.engines) || {}; }

  /** 특정 엔진(hwp/word/excel/powerpoint)이 쓸 수 있는지. */
  function has(name) { return !!engines()[name]; }

  const NO_ENGINE_MESSAGE = IS_LOCAL_PAGE
    ? '로컬 변환 엔진에 연결할 수 없습니다. 프로젝트 폴더의 start.bat 을 실행한 뒤 다시 시도해 주세요. ' +
      '한글·오피스 문서 변환에는 한컴오피스 또는 MS Office가 설치된 Windows PC가 필요합니다.'
    : '이 웹판에서는 한글·오피스 변환을 쓸 수 없습니다. 브라우저 보안 정책상 웹사이트가 ' +
      '내 컴퓨터의 프로그램에 접근할 수 없기 때문입니다. 이 기능이 필요하시면 프로젝트를 ' +
      '내려받아 start.bat 을 실행해 주세요. 나머지 도구는 여기서 그대로 쓰실 수 있습니다.';

  async function post(path, form) {
    if (!base) throw new Error(NO_ENGINE_MESSAGE);
    let res;
    try {
      res = await fetch(base + path, { method: 'POST', body: form });
    } catch (e) {
      base = null; info = false; notify();
      throw new Error(NO_ENGINE_MESSAGE);
    }
    if (!res.ok) {
      let detail = '';
      try { detail = (await res.json()).detail || ''; } catch (e) { /* 본문이 JSON이 아닐 수 있다 */ }
      throw new Error(detail || `엔진이 요청을 처리하지 못했습니다 (HTTP ${res.status}).`);
    }
    return res.json();
  }

  const ENGINE_GONE_MESSAGE =
    '작업 도중 로컬 엔진과의 연결이 끊어졌습니다. 엔진 창(검은 명령 창)이 닫히지 ' +
    '않았는지 확인하고, 닫혔다면 start.bat 을 다시 실행한 뒤 시도해 주세요.';

  /**
   * 네트워크 오류를 사람이 읽을 수 있는 말로 바꾼다.
   *
   * fetch 는 서버가 사라지면 'Failed to fetch' 라는 영문 오류만 던진다. 그대로
   * 보여주면 사용자는 무엇을 해야 할지 알 수 없다. 엔진이 정말 죽었는지 표시도
   * 함께 갱신해 화면의 배지가 곧바로 회색으로 바뀌게 한다.
   */
  function engineLost() {
    base = null;
    info = false;
    notify();
    return new Error(ENGINE_GONE_MESSAGE);
  }

  /** 작업이 끝날 때까지 상태를 물어본다. */
  async function waitFor(jobId, onProgress) {
    for (;;) {
      let res;
      try {
        res = await fetch(`${base}/api/job/${jobId}`, { cache: 'no-store' });
      } catch (e) {
        throw engineLost();
      }
      if (res.status === 404) {
        throw new Error('작업 기록을 찾을 수 없습니다. 엔진이 다시 시작되었을 수 있습니다. ' +
                        '처음부터 다시 시도해 주세요.');
      }
      if (!res.ok) throw new Error('작업 상태를 확인할 수 없습니다. (HTTP ' + res.status + ')');
      const st = await res.json();
      onProgress?.(st.progress, st.message);
      if (st.status === 'done') return st;
      if (st.status === 'error') throw new Error(st.error || '변환에 실패했습니다.');
      await new Promise(r => setTimeout(r, 700));
    }
  }

  async function fetchResult(jobId, filename) {
    let res;
    try {
      res = await fetch(`${base}/api/download/${jobId}`);
    } catch (e) {
      throw engineLost();
    }
    if (!res.ok) throw new Error('결과 파일을 받지 못했습니다. (HTTP ' + res.status + ')');
    return { blob: await res.blob(), name: filename || 'result.pdf' };
  }

  /** 문서 여러 개를 순서대로 하나의 PDF 로 병합한다. */
  async function mergeDocuments(files, { bookmarks = true, filename = '병합문서.pdf', onProgress } = {}) {
    const form = new FormData();
    files.forEach(f => form.append('files', f, f.name));
    form.append('bookmarks', bookmarks ? 'true' : 'false');
    form.append('filename', filename);
    const job = await post('/api/merge', form);
    const done = await waitFor(job.id, onProgress);
    return fetchResult(job.id, done.filename);
  }

  /** 문서 한 개를 PDF 로 변환한다. */
  async function convertToPdf(file, { onProgress } = {}) {
    const form = new FormData();
    form.append('file', file, file.name);
    const job = await post('/api/convert', form);
    const done = await waitFor(job.id, onProgress);
    return fetchResult(job.id, done.filename);
  }


  /** PDF 를 Word/Excel/PowerPoint/PDF-A 로 내보내거나 손상된 PDF 를 복구한다. */
  async function exportPdf(file, target, { onProgress } = {}) {
    const form = new FormData();
    form.append('file', file, file.name);
    form.append('target', target);
    const job = await post('/api/export', form);
    const done = await waitFor(job.id, onProgress);
    return fetchResult(job.id, done.filename);
  }

  /** 웹페이지 주소 또는 HTML 파일을 PDF 로 만든다. */
  async function htmlToPdf({ url = '', file = null, paper = 'A4',
                             landscape = false, marginMm = 12, onProgress } = {}) {
    const form = new FormData();
    form.append('url', url);
    form.append('paper', paper);
    form.append('landscape', landscape ? 'true' : 'false');
    form.append('margin_mm', String(marginMm));
    if (file) form.append('file', file, file.name);
    const job = await post('/api/html', form);
    const done = await waitFor(job.id, onProgress);
    return fetchResult(job.id, done.filename);
  }

  return { detect, isReady, has, engines, onChange, mergeDocuments, convertToPdf,
           exportPdf, htmlToPdf, NO_ENGINE_MESSAGE,
           canReachEngine: IS_LOCAL_PAGE,
           get info() { return info; } };
})();
