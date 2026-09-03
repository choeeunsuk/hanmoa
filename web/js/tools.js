/*
 * tools.js — 도구 목록.
 *
 * 도구 하나는 다음을 알려주면 된다: 어떤 파일을 받는지, 어떤 설정이 필요한지,
 * 그리고 run() 에서 무엇을 만들어 내는지. run 은 [{blob, name}] 을 돌려준다.
 * needsEngine 이 true 인 도구만 로컬 엔진이 필요하고 나머지는 브라우저에서 끝난다.
 */
'use strict';

const PDF_ONLY = ['.pdf'];
const IMAGE_EXT = ['.jpg', '.jpeg', '.png', '.gif', '.bmp', '.webp', '.tif', '.tiff'];
const DOC_EXT = ['.hwp', '.hwpx', '.hml', '.doc', '.docx', '.rtf', '.odt', '.txt',
                 '.xls', '.xlsx', '.csv', '.ppt', '.pptx'];

const POSITION_CHOICES = [
  { value: 'bottom-center', label: '아래 가운데' },
  { value: 'bottom-right', label: '아래 오른쪽' },
  { value: 'bottom-left', label: '아래 왼쪽' },
  { value: 'top-center', label: '위 가운데' },
  { value: 'top-right', label: '위 오른쪽' },
  { value: 'top-left', label: '위 왼쪽' },
];

const TOOLS = [

  /* ── 한글·오피스 (로컬 엔진) ───────────────────── */
  {
    id: 'hwp-merge',
    name: '한글 파일 병합',
    desc: '한글(HWP/HWPX) 문서 여러 개를 하나의 PDF로 묶습니다. 워드·PDF도 섞어서 넣을 수 있습니다.',
    icon: '한', category: '한글·오피스', tag: 'new',
    accept: [...DOC_EXT, '.pdf', ...IMAGE_EXT],
    acceptLabel: 'HWP · HWPX · DOCX · XLSX · PPTX · PDF · 이미지',
    multiple: true, needsEngine: 'hwp',
    options: [
      { key: 'filename', type: 'text', label: '저장할 파일 이름', value: '병합문서.pdf' },
      { key: 'bookmarks', type: 'checkbox', label: '파일 이름으로 목차(북마크) 만들기', value: true },
    ],
    async run(files, opts, ctx) {
      const result = await Backend.mergeDocuments(files, {
        bookmarks: opts.bookmarks,
        filename: opts.filename || '병합문서.pdf',
        onProgress: (pct, msg) => ctx.progress(pct, msg),
      });
      return [result];
    },
  },
  {
    id: 'doc-to-pdf',
    name: '문서를 PDF로',
    desc: '한글·워드·엑셀·파워포인트 문서를 원본 서식 그대로 PDF로 바꿉니다.',
    icon: '📤', category: '한글·오피스',
    accept: DOC_EXT,
    acceptLabel: 'HWP · HWPX · DOCX · XLSX · PPTX',
    multiple: true, needsEngine: 'hwp',
    options: [],
    async run(files, opts, ctx) {
      const out = [];
      for (let i = 0; i < files.length; i++) {
        ctx.progress(Math.round(i * 100 / files.length), `(${i + 1}/${files.length}) ${files[i].name}`);
        out.push(await Backend.convertToPdf(files[i]));
      }
      ctx.progress(100, '');
      return out;
    },
  },

  /* ── PDF 정리 ─────────────────────────────────── */
  {
    id: 'merge',
    name: 'PDF 병합',
    desc: 'PDF 여러 개를 원하는 순서대로 하나로 합칩니다.',
    icon: '🔗', category: 'PDF 정리',
    accept: PDF_ONLY, acceptLabel: 'PDF 파일 여러 개', multiple: true,
    options: [
      { key: 'filename', type: 'text', label: '저장할 파일 이름', value: '병합문서.pdf' },
      { key: 'bookmarks', type: 'checkbox', label: '파일 이름으로 목차(북마크) 만들기', value: true },
    ],
    async run(files, opts, ctx) {
      if (files.length < 2) throw new Error('병합하려면 PDF가 2개 이상 필요합니다.');
      const blob = await Core.mergePdfs(files, {
        bookmarks: opts.bookmarks,
        password: ctx.password,
        onProgress: (i, n, name) => ctx.progress(Math.round(i * 100 / n), name ? `${name} 처리 중` : ''),
      });
      const name = (opts.filename || '병합문서.pdf').replace(/(\.pdf)?$/i, '.pdf');
      return [{ blob, name }];
    },
  },
  {
    id: 'split',
    name: 'PDF 분할',
    desc: '한 개의 PDF를 여러 파일로 나눕니다. 쪽수 단위로도, 원하는 구간으로도 나눌 수 있습니다.',
    icon: '✂️', category: 'PDF 정리',
    accept: PDF_ONLY, acceptLabel: 'PDF 파일 1개', multiple: false,
    options: [
      { key: 'mode', type: 'select', label: '나누는 방식', value: 'every', choices: [
        { value: 'every', label: 'N쪽씩 잘라서' },
        { value: 'single', label: '한 쪽씩 전부' },
        { value: 'ranges', label: '지정한 구간으로' },
      ]},
      { key: 'size', type: 'number', label: '몇 쪽씩', value: 1, min: 1, max: 5000,
        showIf: v => v.mode === 'every' },
      { key: 'ranges', type: 'text', label: '구간', value: '1-3, 4-6',
        placeholder: '예: 1-3, 4-6, 10-',
        desc: '쉼표로 구분한 구간마다 파일이 하나씩 만들어집니다.',
        showIf: v => v.mode === 'ranges' },
    ],
    async run(files, opts, ctx) {
      const parts = await Core.splitPdf(files[0], { ...opts, password: ctx.password });
      ctx.progress(100, '');
      if (parts.length > 8) {
        return [await Core.zipAll(parts, `${Core.baseName(files[0].name)}_분할.zip`)];
      }
      return parts;
    },
  },
  {
    id: 'extract-pages',
    name: '페이지 추출',
    desc: '필요한 쪽만 골라 새 PDF로 만듭니다.',
    icon: '📑', category: 'PDF 정리',
    accept: PDF_ONLY, acceptLabel: 'PDF 파일 1개', multiple: false,
    options: [
      { key: 'pages', type: 'text', label: '남길 페이지', value: '1', placeholder: '예: 1, 3, 5-8',
        desc: '입력한 순서가 아니라 문서 순서대로 담깁니다.' },
    ],
    async run(files, opts, ctx) {
      const doc = await Core.loadDoc(files[0], ctx.password);
      const idx = Core.parsePageRanges(opts.pages, doc.getPageCount());
      if (!idx.length) throw new Error('남길 페이지를 하나 이상 지정해 주세요.');
      const blob = await Core.pickPages(files[0], idx, ctx.password);
      return [{ blob, name: `${Core.baseName(files[0].name)}_추출.pdf` }];
    },
  },
  {
    id: 'remove-pages',
    name: '페이지 삭제',
    desc: '필요 없는 쪽을 빼고 나머지를 새 PDF로 만듭니다.',
    icon: '🗑️', category: 'PDF 정리',
    accept: PDF_ONLY, acceptLabel: 'PDF 파일 1개', multiple: false,
    options: [
      { key: 'pages', type: 'text', label: '뺄 페이지', value: '1', placeholder: '예: 2, 5-7' },
    ],
    async run(files, opts, ctx) {
      const doc = await Core.loadDoc(files[0], ctx.password);
      const total = doc.getPageCount();
      const drop = new Set(Core.parsePageRanges(opts.pages, total));
      if (!drop.size) throw new Error('뺄 페이지를 지정해 주세요.');
      const keep = Array.from({ length: total }, (_, i) => i).filter(i => !drop.has(i));
      if (!keep.length) throw new Error('모든 페이지를 뺄 수는 없습니다. 최소 한 쪽은 남겨야 합니다.');
      const blob = await Core.pickPages(files[0], keep, ctx.password);
      return [{ blob, name: `${Core.baseName(files[0].name)}_수정.pdf` }];
    },
  },
  {
    id: 'organize',
    name: '페이지 정리',
    desc: '쪽을 펼쳐 놓고 끌어서 순서를 바꾸거나, 돌리거나, 빼냅니다. 한 화면에서 전부 정리합니다.',
    icon: '🗂️', category: 'PDF 정리',
    accept: PDF_ONLY, acceptLabel: 'PDF 파일 1개', multiple: false,
    workspace: 'pages',
    options: [
      { key: 'filename', type: 'text', label: '저장할 파일 이름', value: '' ,
        placeholder: '비워두면 원본이름_정리.pdf' },
    ],
    async run(files, opts, ctx) {
      const state = PageWork.getState();
      if (!state.length) throw new Error('모든 쪽을 뺐습니다. 최소 한 쪽은 남겨 주세요.');
      const blob = await Core.buildFromPages(files[0], state, ctx.password);
      const st = PageWork.stats();
      ctx.note(st.removed
        ? `${st.total}쪽 중 ${st.kept}쪽을 남겼습니다.`
        : `${st.kept}쪽을 정리했습니다.`);
      const stem = Core.baseName(files[0].name);
      const name = String(opts.filename || '').trim() || `${stem}_정리.pdf`;
      return [{ blob, name: name.replace(/(\.pdf)?$/i, '.pdf') }];
    },
  },
  {
    id: 'rotate',
    name: 'PDF 회전',
    desc: '가로로 누운 페이지를 바로 세웁니다. 특정 쪽만 돌릴 수도 있습니다.',
    icon: '🔄', category: 'PDF 정리',
    accept: PDF_ONLY, acceptLabel: 'PDF 파일 1개', multiple: false,
    options: [
      { key: 'angle', type: 'select', label: '회전 각도', value: '90', choices: [
        { value: '90', label: '오른쪽으로 90°' },
        { value: '180', label: '180° 뒤집기' },
        { value: '270', label: '왼쪽으로 90°' },
      ]},
      { key: 'which', type: 'text', label: '대상 페이지', value: '',
        placeholder: '비워두면 전체', desc: '예: 2, 5-7' },
    ],
    async run(files, opts, ctx) {
      const blob = await Core.rotatePdf(files[0], { ...opts, password: ctx.password });
      return [{ blob, name: `${Core.baseName(files[0].name)}_회전.pdf` }];
    },
  },
  {
    id: 'crop',
    name: '여백 자르기',
    desc: '페이지 사방의 여백을 비율로 깎아 본문을 키웁니다.',
    icon: '⬜', category: 'PDF 정리',
    accept: PDF_ONLY, acceptLabel: 'PDF 파일 1개', multiple: false,
    options: [
      { key: 'top', type: 'number', label: '위 (%)', value: 5, min: 0, max: 45 },
      { key: 'bottom', type: 'number', label: '아래 (%)', value: 5, min: 0, max: 45 },
      { key: 'left', type: 'number', label: '왼쪽 (%)', value: 5, min: 0, max: 45 },
      { key: 'right', type: 'number', label: '오른쪽 (%)', value: 5, min: 0, max: 45 },
    ],
    async run(files, opts, ctx) {
      const blob = await Core.cropPdf(files[0], { ...opts, password: ctx.password });
      return [{ blob, name: `${Core.baseName(files[0].name)}_자름.pdf` }];
    },
  },

  /* ── 변환 ─────────────────────────────────────── */
  {
    id: 'jpg-to-pdf',
    name: '이미지를 PDF로',
    desc: '사진과 스캔 이미지를 한 권의 PDF로 묶습니다.',
    icon: '🖼️', category: '변환',
    accept: IMAGE_EXT, acceptLabel: 'JPG · PNG · GIF · BMP · WEBP', multiple: true,
    options: [
      { key: 'pageSize', type: 'select', label: '페이지 크기', value: 'a4', choices: [
        { value: 'a4', label: 'A4 용지에 맞춤' },
        { value: 'fit', label: '이미지 원본 크기' },
      ]},
      { key: 'orientation', type: 'select', label: '방향', value: 'auto', choices: [
        { value: 'auto', label: '이미지에 맞게 자동' },
        { value: 'portrait', label: '세로 고정' },
        { value: 'landscape', label: '가로 고정' },
      ], showIf: v => v.pageSize === 'a4' },
      { key: 'margin', type: 'number', label: '여백 (pt)', value: 20, min: 0, max: 150 },
      { key: 'filename', type: 'text', label: '저장할 파일 이름', value: '이미지모음.pdf' },
    ],
    async run(files, opts, ctx) {
      const blob = await Core.imagesToPdf(files, {
        ...opts,
        onProgress: (i, n, name) => ctx.progress(Math.round(i * 100 / n), name),
      });
      return [{ blob, name: (opts.filename || '이미지모음.pdf').replace(/(\.pdf)?$/i, '.pdf') }];
    },
  },
  {
    id: 'pdf-to-jpg',
    name: 'PDF를 이미지로',
    desc: '각 페이지를 JPG 또는 PNG 이미지 파일로 뽑아냅니다.',
    icon: '📷', category: '변환',
    accept: PDF_ONLY, acceptLabel: 'PDF 파일 1개', multiple: false,
    options: [
      { key: 'format', type: 'select', label: '이미지 형식', value: 'jpeg', choices: [
        { value: 'jpeg', label: 'JPG (용량이 작음)' },
        { value: 'png', label: 'PNG (화질 우선)' },
      ]},
      { key: 'dpi', type: 'select', label: '해상도', value: '150', choices: [
        { value: '96', label: '보통 (화면용, 96 DPI)' },
        { value: '150', label: '높음 (150 DPI)' },
        { value: '300', label: '인쇄용 (300 DPI)' },
      ]},
    ],
    async run(files, opts, ctx) {
      const images = await Core.pdfToImages(files[0], {
        dpi: Number(opts.dpi), format: opts.format, password: ctx.password,
        onProgress: (i, n, msg) => ctx.progress(Math.round(i * 100 / n), msg),
      });
      if (images.length > 8) {
        return [await Core.zipAll(images, `${Core.baseName(files[0].name)}_이미지.zip`)];
      }
      return images;
    },
  },

  /* ── 편집 ─────────────────────────────────────── */
  {
    id: 'ocr',
    name: '스캔 문서 글자 인식',
    desc: '스캔한 PDF나 사진에서 글자를 읽어, 검색·복사가 되는 PDF로 만듭니다. 한국어를 인식합니다.',
    icon: '🔍', category: '변환', tag: 'new',
    accept: [...PDF_ONLY, ...IMAGE_EXT],
    acceptLabel: 'PDF 또는 이미지 1개', multiple: false,
    note: '글자 인식은 여러분의 컴퓨터에서 처리됩니다. 문서가 밖으로 나가지 않습니다.',
    options: [
      { key: 'langs', type: 'select', label: '인식할 언어', value: 'kor+eng', choices: [
        { value: 'kor+eng', label: '한국어 + 영어' },
        { value: 'kor', label: '한국어만' },
        { value: 'eng', label: '영어만' },
      ]},
      { key: 'dpi', type: 'select', label: '인식 해상도', value: '200', choices: [
        { value: '150', label: '빠름 (150 DPI)' },
        { value: '200', label: '보통 (200 DPI)' },
        { value: '300', label: '정확 (300 DPI · 느림)' },
      ], desc: '글씨가 작거나 흐리면 해상도를 올려 보세요.' },
      { key: 'alsoText', type: 'checkbox', label: '읽어낸 글자를 텍스트 파일로도 저장', value: false },
    ],
    async run(files, opts, ctx) {
      const file = files[0];
      const { blob, text, pageCount } = await OCR.toSearchablePdf(file, {
        langs: opts.langs,
        dpi: Number(opts.dpi),
        onProgress: (i, n, msg) => ctx.progress(Math.round(i * 100 / Math.max(n, 1)), msg),
      });
      const chars = text.replace(/\s/g, '').length;
      ctx.note(chars
        ? `${pageCount}쪽에서 글자 ${chars.toLocaleString()}자를 읽었습니다.`
        : `${pageCount}쪽을 처리했지만 글자를 찾지 못했습니다. 해상도를 올려 다시 시도해 보세요.`);

      const stem = Core.baseName(file.name);
      const out = [{ blob, name: `${stem}_인식.pdf` }];
      if (opts.alsoText && text.trim()) {
        out.push({ blob: new Blob([text], { type: 'text/plain;charset=utf-8' }),
                   name: `${stem}_인식.txt` });
      }
      return out;
    },
  },
  {
    id: 'scan',
    name: '카메라로 스캔',
    desc: '카메라로 종이 문서를 찍어 바로 PDF로 만듭니다. 스캐너가 없을 때 쓰세요.',
    icon: '📸', category: '변환',
    accept: [], acceptLabel: '', multiple: false,
    workspace: 'camera', optionalFiles: true,
    note: '찍은 사진은 브라우저 안에만 있습니다. 어디로도 올라가지 않습니다.',
    options: [
      { key: 'pageSize', type: 'select', label: '페이지 크기', value: 'a4', choices: [
        { value: 'a4', label: 'A4 용지에 맞춤' },
        { value: 'fit', label: '사진 원본 크기' },
      ]},
      { key: 'margin', type: 'number', label: '여백 (pt)', value: 16, min: 0, max: 120 },
      { key: 'filename', type: 'text', label: '저장할 파일 이름', value: '스캔문서.pdf' },
    ],
    async run(files, opts, ctx) {
      const shots = Scanner.getFiles();
      if (!shots.length) throw new Error('먼저 카메라로 한 장 이상 찍어 주세요.');
      const blob = await Core.imagesToPdf(shots, {
        pageSize: opts.pageSize, margin: opts.margin, orientation: 'auto',
        onProgress: (i, n, name) => ctx.progress(Math.round(i * 100 / n), name),
      });
      ctx.note(shots.length + '장을 한 권으로 묶었습니다.');
      const name = (opts.filename || '스캔문서.pdf').replace(/(\.pdf)?$/i, '.pdf');
      return [{ blob, name }];
    },
  },
  {
    id: 'page-numbers',
    name: '페이지 번호',
    desc: '쪽 번호를 넣습니다. 한글이 섞인 형식도 그대로 들어갑니다.',
    icon: '#️⃣', category: '편집',
    accept: PDF_ONLY, acceptLabel: 'PDF 파일 1개', multiple: false,
    options: [
      { key: 'format', type: 'text', label: '표시 형식', value: '{n}',
        desc: '{n}은 현재 쪽, {total}은 전체 쪽수입니다. 예: - {n} -  또는  {n} / {total}쪽' },
      { key: 'position', type: 'select', label: '위치', value: 'bottom-center', choices: POSITION_CHOICES },
      { key: 'fontSize', type: 'number', label: '글자 크기 (pt)', value: 11, min: 6, max: 40 },
      { key: 'startAt', type: 'number', label: '시작 번호', value: 1, min: 0, max: 9999 },
      { key: 'skipFirst', type: 'checkbox', label: '첫 페이지는 넣지 않기 (표지)', value: false },
    ],
    async run(files, opts, ctx) {
      const blob = await Core.addPageNumbers(files[0], { ...opts, password: ctx.password });
      return [{ blob, name: `${Core.baseName(files[0].name)}_쪽번호.pdf` }];
    },
  },
  {
    id: 'watermark',
    name: '워터마크',
    desc: '“대외비”처럼 문구를 페이지 위에 겹쳐 찍습니다.',
    icon: '💧', category: '편집',
    accept: PDF_ONLY, acceptLabel: 'PDF 파일 1개', multiple: false,
    options: [
      { key: 'text', type: 'text', label: '문구', value: '대외비' },
      { key: 'fontSize', type: 'number', label: '글자 크기 (pt)', value: 60, min: 10, max: 300 },
      { key: 'color', type: 'text', label: '색상', value: '#d92d20', desc: '#RRGGBB 형식으로 적어 주세요.' },
      { key: 'opacity', type: 'number', label: '투명도 (0~1)', value: 0.25, min: 0.05, max: 1, step: 0.05 },
      { key: 'rotation', type: 'number', label: '기울기 (도)', value: 45, min: -90, max: 90 },
      { key: 'tile', type: 'checkbox', label: '페이지 전체에 반복해서 채우기', value: false },
    ],
    async run(files, opts, ctx) {
      const blob = await Core.addWatermark(files[0], { ...opts, password: ctx.password });
      return [{ blob, name: `${Core.baseName(files[0].name)}_워터마크.pdf` }];
    },
  },

  /* ── 최적화 · 보안 ─────────────────────────────── */
  {
    id: 'sign',
    name: '서명 넣기',
    desc: '이름을 직접 그리거나 도장 그림을 올려 문서 원하는 자리에 넣습니다.',
    icon: '✍️', category: '편집', tag: 'new',
    accept: PDF_ONLY, acceptLabel: 'PDF 파일 1개', multiple: false,
    workspace: 'canvas', editorMode: 'image',
    note: '오른쪽 칸에 서명을 그린 뒤 "이 서명 사용"을 누르고, 문서에서 넣을 자리를 누르세요.',
    options: [],
    async run(files, opts, ctx) {
      return stampEdits(files[0], ctx, '_서명');
    },
  },
  {
    id: 'add-text',
    name: '글자 넣기',
    desc: '문서 위에 글자를 얹습니다. 접수번호나 안내 문구를 넣을 때 쓰세요.',
    icon: '🅣', category: '편집',
    accept: PDF_ONLY, acceptLabel: 'PDF 파일 1개', multiple: false,
    workspace: 'canvas', editorMode: 'text',
    note: '문서에서 글자를 넣을 자리를 누르면 입력창이 뜹니다. 넣은 뒤 끌어서 옮기고 모서리로 크기를 바꿉니다.',
    options: [
      { key: 'color', type: 'text', label: '글자 색', value: '#111111',
        desc: '#RRGGBB 형식으로 적어 주세요.' },
      { key: 'bold', type: 'checkbox', label: '굵게', value: true },
    ],
    async run(files, opts, ctx) {
      return stampEdits(files[0], ctx, '_글자');
    },
  },
  {
    id: 'redact',
    name: '내용 지우기',
    desc: '개인정보처럼 가려야 할 부분을 되살릴 수 없게 지웁니다.',
    icon: '⬛', category: '최적화 · 보안', tag: 'new',
    accept: PDF_ONLY, acceptLabel: 'PDF 파일 1개', multiple: false,
    workspace: 'canvas', editorMode: 'redact',
    note: '가릴 곳을 끌어서 상자로 덮으세요. 검은 칠을 한 쪽은 그림으로 다시 구워지므로 가린 글자가 정말로 사라집니다(그 쪽은 글자 검색이 되지 않습니다).',
    options: [
      { key: 'redactDpi', type: 'select', label: '다시 굽는 해상도', value: '150', choices: [
        { value: '110', label: '낮음 (용량 작음)' },
        { value: '150', label: '보통' },
        { value: '220', label: '높음 (인쇄용)' },
      ]},
    ],
    async run(files, opts, ctx) {
      return stampEdits(files[0], ctx, '_지움', Number(opts.redactDpi));
    },
  },
  {
    id: 'compress',
    name: 'PDF 압축',
    desc: '용량을 줄입니다. 메일 첨부 용량 제한에 걸릴 때 쓰세요.',
    icon: '📉', category: '최적화 · 보안',
    accept: PDF_ONLY, acceptLabel: 'PDF 파일 1개', multiple: false,
    options: [
      { key: 'level', type: 'select', label: '압축 강도', value: 'light', choices: [
        { value: 'light', label: '약함 — 글자 그대로 유지 (안전)' },
        { value: 'medium', label: '보통 — 페이지를 이미지로 (120 DPI)' },
        { value: 'strong', label: '강함 — 페이지를 이미지로 (96 DPI)' },
      ], desc: '보통·강함은 용량이 크게 줄지만 글자 검색과 복사가 되지 않습니다.' },
    ],
    async run(files, opts, ctx) {
      const before = files[0].size;
      const blob = await Core.compressPdf(files[0], {
        level: opts.level, password: ctx.password,
        onProgress: (i, n, msg) => ctx.progress(Math.round(i * 100 / n), msg),
      });
      const name = `${Core.baseName(files[0].name)}_압축.pdf`;

      // 글자 위주의 가벼운 문서를 이미지로 다시 그리면 오히려 커진다.
      // 압축 도구가 파일을 키워서 돌려주는 일은 없어야 하므로 원본을 그대로 준다.
      if (blob.size >= before) {
        ctx.note(`이미 충분히 작은 문서라 더 줄일 수 없었습니다 (${Core.formatBytes(before)}). `
               + '원본을 그대로 내려받습니다.');
        return [{ blob: files[0], name: files[0].name }];
      }

      const saved = before - blob.size;
      ctx.note(`${Core.formatBytes(before)} → ${Core.formatBytes(blob.size)} · ${Math.round(saved * 100 / before)}% 줄었습니다.`);
      return [{ blob, name }];
    },
  },
  {
    id: 'compare',
    name: 'PDF 비교',
    desc: '두 PDF를 견줘 달라진 곳을 붉게 표시하고, 바뀐 글자 목록을 뽑아 줍니다.',
    icon: '🔀', category: '최적화 · 보안',
    accept: PDF_ONLY, acceptLabel: 'PDF 파일 2개 (예전 것 먼저)', multiple: true,
    note: '먼저 올린 파일을 예전 판, 나중 것을 새 판으로 봅니다. 카드를 끌어 순서를 바꿀 수 있습니다.',
    options: [
      { key: 'sensitivity', type: 'select', label: '민감도', value: '26', choices: [
        { value: '46', label: '낮음 — 큰 차이만' },
        { value: '26', label: '보통' },
        { value: '12', label: '높음 — 미세한 차이까지' },
      ], desc: '민감도를 높이면 글꼴이 살짝 밀린 것까지 잡힙니다.' },
    ],
    async run(files, opts, ctx) {
      if (files.length !== 2) throw new Error('비교하려면 PDF를 정확히 2개 올려 주세요.');
      const { blob, report, totalPages, changedPages } = await Core.comparePdfs(files[0], files[1], {
        tolerance: Number(opts.sensitivity),
        onProgress: (i, n, msg) => ctx.progress(Math.round(i * 100 / Math.max(n, 1)), msg),
      });
      ctx.note(changedPages
        ? `${totalPages}쪽 중 ${changedPages}쪽이 다릅니다.`
        : `${totalPages}쪽 모두 같습니다.`);
      const stem = Core.baseName(files[1].name);
      return [
        { blob, name: `${stem}_비교.pdf` },
        { blob: new Blob([report], { type: 'text/plain;charset=utf-8' }),
          name: `${stem}_비교.txt` },
      ];
    },
  },
  {
    id: 'protect',
    name: '암호 걸기',
    desc: '열 때 암호를 묻도록 PDF를 잠급니다.',
    icon: '🔒', category: '최적화 · 보안',
    accept: PDF_ONLY, acceptLabel: 'PDF 파일 1개', multiple: false,
    options: [
      { key: 'userPassword', type: 'password', label: '열기 암호', value: '',
        desc: '이 암호를 모르면 문서를 열 수 없습니다. 잊어버리면 되돌릴 수 없으니 따로 적어 두세요.' },
      { key: 'allowPrinting', type: 'checkbox', label: '인쇄 허용', value: true },
      { key: 'allowCopying', type: 'checkbox', label: '내용 복사 허용', value: false },
    ],
    async run(files, opts) {
      const blob = await Core.protectPdf(files[0], opts);
      return [{ blob, name: `${Core.baseName(files[0].name)}_암호.pdf` }];
    },
  },
  {
    id: 'unlock',
    name: '암호 해제',
    desc: '암호를 알고 있는 PDF에서 암호를 제거합니다.',
    icon: '🔓', category: '최적화 · 보안',
    accept: PDF_ONLY, acceptLabel: 'PDF 파일 1개', multiple: false,
    options: [
      { key: 'password', type: 'password', label: '현재 암호', value: '',
        desc: '본인이 권한을 가진 문서에만 사용하세요.' },
    ],
    async run(files, opts) {
      const blob = await Core.unlockPdf(files[0], opts);
      return [{ blob, name: `${Core.baseName(files[0].name)}_해제.pdf` }];
    },
  },

  /* ── 2차: PDF 에서 다른 형식으로 ─────────────── */
  {
    id: 'pdf-to-word',
    name: 'PDF를 Word로',
    desc: '글자와 표, 배치를 살려 편집 가능한 Word 문서로 바꿉니다.',
    icon: '📝', category: '변환',
    accept: PDF_ONLY, acceptLabel: 'PDF 파일 (여러 개 가능)', multiple: true,
    needsEngine: 'export',
    options: [],
    async run(files, opts, ctx) {
      return runExport(files, 'docx', ctx);
    },
  },
  {
    id: 'pdf-to-excel',
    name: 'PDF를 Excel로',
    desc: 'PDF 안의 표를 찾아 시트로 옮깁니다. 선이 뚜렷한 표에서 잘 동작합니다.',
    icon: '📊', category: '변환',
    accept: PDF_ONLY, acceptLabel: 'PDF 파일 (여러 개 가능)', multiple: true,
    needsEngine: 'export',
    options: [],
    async run(files, opts, ctx) {
      return runExport(files, 'xlsx', ctx);
    },
  },
  {
    id: 'pdf-to-ppt',
    name: 'PDF를 PowerPoint로',
    desc: '각 쪽을 슬라이드 한 장으로 만듭니다. 발표나 화면 공유용으로 좋습니다.',
    icon: '📽️', category: '변환',
    accept: PDF_ONLY, acceptLabel: 'PDF 파일 (여러 개 가능)', multiple: true,
    needsEngine: 'export',
    options: [],
    note: '쪽 모양을 그대로 담은 그림 슬라이드가 됩니다. 슬라이드 안의 글자를 다시 편집할 수는 없습니다.',
    async run(files, opts, ctx) {
      return runExport(files, 'pptx', ctx);
    },
  },
  {
    id: 'html-to-pdf',
    name: '웹페이지를 PDF로',
    desc: '주소를 넣거나 HTML 파일을 올리면 그대로 인쇄한 PDF를 만듭니다.',
    icon: '🌐', category: '변환',
    accept: ['.html', '.htm'], acceptLabel: 'HTML 파일 (주소만 넣어도 됩니다)',
    multiple: false, optionalFiles: true,
    needsEngine: 'browser',
    options: [
      { key: 'url', type: 'text', label: '웹페이지 주소', value: '',
        placeholder: 'https://www.example.com',
        desc: 'HTML 파일을 올렸다면 비워 두세요.' },
      { key: 'paper', type: 'select', label: '용지', value: 'A4', choices: [
        { value: 'A4', label: 'A4' }, { value: 'A3', label: 'A3' },
        { value: 'Letter', label: 'Letter' }, { value: 'Legal', label: 'Legal' },
      ], desc: '용지 설정은 올린 HTML 파일에만 적용됩니다. 주소로 받은 페이지는 그 페이지의 인쇄 설정을 따릅니다.' },
      { key: 'landscape', type: 'checkbox', label: '가로 방향으로', value: false },
      { key: 'marginMm', type: 'number', label: '여백 (mm)', value: 12, min: 0, max: 50 },
    ],
    async run(files, opts, ctx) {
      const file = files[0] || null;
      if (!file && !String(opts.url || '').trim()) {
        throw new Error('웹페이지 주소를 넣거나 HTML 파일을 올려 주세요.');
      }
      const result = await Backend.htmlToPdf({
        url: file ? '' : opts.url,
        file,
        paper: opts.paper,
        landscape: opts.landscape,
        marginMm: opts.marginMm,
        onProgress: (pct, msg) => ctx.progress(pct, msg),
      });
      return [result];
    },
  },

  /* ── 2차: 보존 · 복구 ─────────────────────────── */
  {
    id: 'pdf-to-pdfa',
    name: 'PDF/A로 변환',
    desc: '글꼴을 문서 안에 모두 넣어 오랜 시간 뒤에도 같은 모양으로 열리게 만듭니다. 기록물 보존용 형식입니다.',
    icon: '🏛️', category: '최적화 · 보안',
    accept: PDF_ONLY, acceptLabel: 'PDF 파일 (여러 개 가능)', multiple: true,
    needsEngine: 'ghostscript',
    options: [],
    async run(files, opts, ctx) {
      return runExport(files, 'pdfa', ctx);
    },
  },
  {
    id: 'repair',
    name: 'PDF 복구',
    desc: '열리지 않는 PDF에서 살릴 수 있는 부분을 건져냅니다.',
    icon: '🔧', category: '최적화 · 보안',
    accept: PDF_ONLY, acceptLabel: 'PDF 파일 1개', multiple: false,
    options: [],
    async run(files, opts, ctx) {
      const file = files[0];
      // 먼저 브라우저에서 시도한다. 가벼운 손상은 여기서 끝난다.
      try {
        ctx.progress(30, '브라우저에서 복구 시도 중');
        const { blob, pageCount } = await Core.repairPdf(file);
        ctx.note(`${pageCount}쪽을 살렸습니다.`);
        return [{ blob, name: `${Core.baseName(file.name)}_복구.pdf` }];
      } catch (e) {
        // 손상이 심하면 로컬 엔진의 MuPDF 가 훨씬 잘 건진다.
        if (!Backend.isReady()) {
          throw new Error(
            '브라우저에서는 복구하지 못했습니다. start.bat 을 실행해 로컬 엔진을 켜면 ' +
            '더 강력한 복구를 시도할 수 있습니다.');
        }
        ctx.progress(60, '로컬 엔진으로 복구 시도 중');
        const result = await Backend.exportPdf(file, 'repair', {
          onProgress: (pct, msg) => ctx.progress(pct, msg),
        });
        ctx.note('브라우저로는 안 되어 로컬 엔진이 복구했습니다.');
        return [result];
      }
    },
  },
];

/** 파일 여러 개를 하나씩 로컬 엔진으로 내보낸다. 도구 여럿이 공유한다. */
async function runExport(files, target, ctx) {
  const out = [];
  for (let i = 0; i < files.length; i++) {
    ctx.progress(Math.round(i * 100 / files.length), `(${i + 1}/${files.length}) ${files[i].name}`);
    out.push(await Backend.exportPdf(files[i], target, {
      onProgress: (pct, msg) => {
        const base = i * 100 / files.length;
        ctx.progress(Math.round(base + pct / files.length), msg);
      },
    }));
  }
  ctx.progress(100, '');
  return out;
}


const CATEGORY_ORDER = ['한글·오피스', 'PDF 정리', '변환', '편집', '최적화 · 보안'];

function findTool(id) { return TOOLS.find(t => t.id === id) || null; }

/** 편집기에 올린 항목을 PDF 에 새긴다. 서명·글자·지우기 도구가 함께 쓴다. */
async function stampEdits(file, ctx, suffix, redactDpi) {
  const items = Editor.getItems();
  if (!items.length) {
    throw new Error('문서에 올린 항목이 없습니다. 넣을 자리를 먼저 지정해 주세요.');
  }
  const { blob, rasterized } = await Core.applyEdits(file, items, {
    password: ctx.password,
    redactDpi: redactDpi || 150,
    onProgress: (i, n, msg) => ctx.progress(Math.round(i * 100 / Math.max(n, 1)), msg),
  });
  ctx.note(rasterized
    ? `${items.length}개 항목을 새겼습니다. ${rasterized}쪽은 내용을 지우기 위해 그림으로 다시 구웠습니다.`
    : `${items.length}개 항목을 새겼습니다.`);
  return [{ blob, name: `${Core.baseName(file.name)}${suffix}.pdf` }];
}
