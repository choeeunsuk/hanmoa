/*
 * scan.js — 카메라로 종이 문서를 찍어 PDF 로 만든다.
 *
 * 스캐너가 없는 자리에서 유인물이나 결재판을 바로 PDF 로 만들 때 쓴다.
 * 찍은 사진은 브라우저 안에만 있고 어디로도 올라가지 않는다.
 */
'use strict';

const Scanner = (() => {

  const root = document.getElementById('scanner');
  const video = document.getElementById('scanVideo');
  const msg = document.getElementById('scanMsg');
  const shotList = document.getElementById('scanShots');
  const deviceSelect = document.getElementById('scanDevice');
  const shotBtn = document.getElementById('scanShot');
  const startBtn = document.getElementById('scanStart');

  let stream = null;
  let shots = [];          // { id, blob, url }
  let seq = 0;
  let onChange = null;

  const SUPPORTED = !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia);

  function show(onStateChange) {
    onChange = onStateChange;
    root.hidden = false;
    if (!SUPPORTED) {
      msg.textContent = '이 브라우저에서는 카메라를 쓸 수 없습니다. '
                      + '대신 사진을 찍어 두었다가 "이미지를 PDF로" 도구를 쓰세요.';
      startBtn.disabled = true;
      return;
    }
    msg.textContent = '“카메라 켜기”를 누르면 브라우저가 카메라 사용을 물어봅니다.';
    render();
  }

  function hide() {
    stop();
    clear();
    root.hidden = true;
  }

  /** 카메라를 켠다. 사용자가 허락하지 않으면 이유를 알려준다. */
  async function start(deviceId) {
    if (!SUPPORTED) return;
    stop();
    try {
      msg.textContent = '카메라를 켜는 중…';
      stream = await navigator.mediaDevices.getUserMedia({
        video: deviceId
          ? { deviceId: { exact: deviceId } }
          // 문서를 찍는 용도라 뒷면 카메라와 높은 해상도를 요청한다.
          : { facingMode: { ideal: 'environment' },
              width: { ideal: 2560 }, height: { ideal: 1440 } },
        audio: false,
      });
      video.srcObject = stream;
      await video.play();
      const track = stream.getVideoTracks()[0];
      const s = track.getSettings();
      msg.textContent = `${s.width || '?'}×${s.height || '?'} · 문서를 화면에 채운 뒤 촬영하세요.`;
      shotBtn.disabled = false;
      startBtn.textContent = '카메라 다시 켜기';
      await listDevices();
    } catch (e) {
      shotBtn.disabled = true;
      msg.textContent = describeCameraError(e);
    }
  }

  function describeCameraError(e) {
    const name = e && e.name;
    if (name === 'NotAllowedError' || name === 'SecurityError') {
      return '카메라 사용이 거부되었습니다. 주소창 옆 자물쇠를 눌러 카메라를 허용해 주세요.';
    }
    if (name === 'NotFoundError' || name === 'OverconstrainedError') {
      return '쓸 수 있는 카메라를 찾지 못했습니다.';
    }
    if (name === 'NotReadableError') {
      return '다른 프로그램이 카메라를 쓰고 있습니다. 화상회의 앱 등을 닫고 다시 시도해 주세요.';
    }
    return '카메라를 켜지 못했습니다. ' + (e && e.message ? e.message : '');
  }

  /** 카메라가 여러 개면 고를 수 있게 한다. 허락을 받은 뒤에야 이름이 보인다. */
  async function listDevices() {
    try {
      const devices = await navigator.mediaDevices.enumerateDevices();
      const cams = devices.filter(d => d.kind === 'videoinput');
      deviceSelect.hidden = cams.length < 2;
      if (cams.length < 2) return;
      const current = stream?.getVideoTracks()[0]?.getSettings()?.deviceId;
      deviceSelect.textContent = '';
      cams.forEach((c, i) => {
        const opt = document.createElement('option');
        opt.value = c.deviceId;
        opt.textContent = c.label || `카메라 ${i + 1}`;
        if (c.deviceId === current) opt.selected = true;
        deviceSelect.appendChild(opt);
      });
    } catch (e) {
      deviceSelect.hidden = true;
    }
  }

  function stop() {
    if (stream) {
      stream.getTracks().forEach(t => t.stop());
      stream = null;
    }
    video.srcObject = null;
    shotBtn.disabled = true;
  }

  /** 현재 화면을 한 장 찍는다. */
  async function capture() {
    if (!stream) return;
    const w = video.videoWidth, h = video.videoHeight;
    if (!w || !h) { msg.textContent = '아직 화면이 준비되지 않았습니다. 잠시 뒤 다시 눌러 주세요.'; return; }

    const cv = document.createElement('canvas');
    cv.width = w; cv.height = h;
    cv.getContext('2d').drawImage(video, 0, 0, w, h);
    const blob = await new Promise(r => cv.toBlob(r, 'image/jpeg', 0.92));
    cv.width = cv.height = 0;

    const id = ++seq;
    shots.push({ id, blob, url: URL.createObjectURL(blob) });
    msg.textContent = `${shots.length}장 찍었습니다.`;
    render();
  }

  function removeShot(id) {
    const idx = shots.findIndex(s => s.id === id);
    if (idx < 0) return;
    URL.revokeObjectURL(shots[idx].url);
    shots.splice(idx, 1);
    render();
  }

  function move(from, to) {
    if (from === to || from < 0 || to < 0 || from >= shots.length || to >= shots.length) return;
    const [item] = shots.splice(from, 1);
    shots.splice(to, 0, item);
    render();
  }

  function clear() {
    shots.forEach(s => URL.revokeObjectURL(s.url));
    shots = [];
    render();
  }

  /** 찍은 사진을 파일 목록으로 넘겨준다. 순서가 곧 쪽 순서다. */
  function getFiles() {
    return shots.map((s, i) =>
      new File([s.blob], `촬영_${String(i + 1).padStart(2, '0')}.jpg`, { type: 'image/jpeg' }));
  }

  function count() { return shots.length; }

  function render() {
    shotList.textContent = '';
    shots.forEach((s, i) => {
      const card = document.createElement('div');
      card.className = 'shot-card';
      card.draggable = true;
      card.dataset.pos = String(i);

      const img = document.createElement('img');
      img.src = s.url;
      img.alt = `${i + 1}번째 촬영`;
      card.appendChild(img);

      const num = document.createElement('span');
      num.className = 'page-num';
      num.textContent = String(i + 1);
      card.appendChild(num);

      const del = document.createElement('button');
      del.type = 'button';
      del.className = 'remove';
      del.textContent = '×';
      del.title = '이 장 버리기';
      del.addEventListener('click', e => { e.stopPropagation(); removeShot(s.id); });
      card.appendChild(del);

      shotList.appendChild(card);
    });
    onChange?.({ count: shots.length });
  }

  /* ── 끌어서 순서 바꾸기 ──────────────────────── */

  let dragFrom = -1;
  shotList.addEventListener('dragstart', e => {
    const card = e.target.closest('.shot-card');
    if (!card) return;
    dragFrom = Number(card.dataset.pos);
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', String(dragFrom));
  });
  shotList.addEventListener('dragover', e => { if (dragFrom >= 0) e.preventDefault(); });
  shotList.addEventListener('drop', e => {
    if (dragFrom < 0) return;
    e.preventDefault();
    e.stopPropagation();
    const card = e.target.closest('.shot-card');
    if (card) move(dragFrom, Number(card.dataset.pos));
    dragFrom = -1;
  });

  startBtn?.addEventListener('click', () => start(deviceSelect.hidden ? null : deviceSelect.value));
  shotBtn?.addEventListener('click', () => capture());
  deviceSelect?.addEventListener('change', () => start(deviceSelect.value));
  document.getElementById('scanClear')?.addEventListener('click', () => clear());

  // 다른 화면으로 옮겨 가면 카메라 불을 꺼 준다.
  window.addEventListener('hashchange', () => { if (root.hidden) stop(); });

  return { show, hide, stop, capture, clear, getFiles, count, supported: SUPPORTED };
})();
