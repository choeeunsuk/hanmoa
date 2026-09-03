/*
 * ocr.js — 스캔한 문서에서 글자를 읽어낸다.
 *
 * Tesseract 를 WebAssembly 로 브라우저 안에서 돌린다. 서버로 보내지 않으므로
 * 개인정보가 담긴 문서도 안심하고 넣을 수 있고, GitHub Pages 에 올린 판에서도
 * 그대로 동작한다. 한국어·영어 학습 데이터를 함께 담아 인터넷 없이도 된다.
 */
'use strict';

const OCR = (() => {

  // 모두 우리 저장소 안의 파일이다. 외부 CDN 을 부르지 않는다.
  //
  // 학습 데이터는 tessdata_fast 판을 쓴다. 표준 판(6배 크다)도 시험해 봤는데
  // 한글을 "경 상 남 도" 처럼 글자마다 띄어 읽어 오히려 결과가 나빴다. 용량도
  // 작고 정확도도 나은 쪽을 골랐다.
  //
  // 언어는 kor+eng 를 함께 쓰는 편이 낫다. kor 만 쓰면 문서 안의 영문·숫자가
  // 한글 글자로 잘못 읽힌다(실측: "Hanmoa OCR test" -> "『3101008 0ㅁ다 1651").
  const PATHS = {
    workerPath: 'vendor/tesseract.worker.min.js',
    corePath: 'vendor/tesseract-core',
    langPath: 'vendor/tessdata',
  };

  let worker = null;
  let workerLangs = '';

  /**
   * 작업자를 준비한다. 언어 데이터를 읽는 데 몇 초 걸리므로 한 번 만든 것을
   * 계속 쓰고, 언어 조합이 바뀔 때만 다시 만든다.
   */
  async function getWorker(langs, onStatus) {
    if (worker && workerLangs === langs) return worker;
    if (worker) { await worker.terminate(); worker = null; }

    onStatus?.('글자 인식 엔진 준비 중');
    worker = await Tesseract.createWorker(langs, 1, {
      ...PATHS,
      logger: m => {
        if (m.status === 'loading language traineddata') onStatus?.('언어 데이터 읽는 중');
        else if (m.status === 'initializing api') onStatus?.('엔진 초기화 중');
      },
    });
    workerLangs = langs;
    return worker;
  }

  /** 다 쓰고 나면 메모리를 놓아준다. */
  async function release() {
    if (worker) { await worker.terminate(); worker = null; workerLangs = ''; }
  }

  /**
   * PDF 나 이미지에서 글자를 읽어 "검색되는 PDF" 를 만든다.
   *
   * 눈에 보이는 그림은 그대로 두고 그 아래에 투명한 글자층을 깐다. 그래서 보기에는
   * 원본과 같은데 Ctrl+F 로 찾을 수 있고 복사도 된다. 이 글자층은 Tesseract 가
   * 직접 만들어 주므로 글자 위치가 정확히 맞는다.
   */
  async function toSearchablePdf(file, { langs = 'kor+eng', dpi = 200, onProgress } = {}) {
    const w = await getWorker(langs, msg => onProgress?.(0, 1, msg));
    const { PDFDocument } = PDFLib;
    const out = await PDFDocument.create();
    const texts = [];

    const isImage = (file.type || '').startsWith('image/');
    const sources = isImage
      ? [{ render: async () => await blobToCanvas(file) }]
      : await pdfPageSources(file, dpi);

    for (let i = 0; i < sources.length; i++) {
      onProgress?.(i, sources.length, `${i + 1}/${sources.length}쪽 글자 읽는 중`);
      const canvas = await sources[i].render();
      const { data } = await w.recognize(canvas, {}, { pdf: true, text: true });
      texts.push(data.text || '');

      const pagePdf = await PDFDocument.load(new Uint8Array(data.pdf));
      const copied = await out.copyPages(pagePdf, pagePdf.getPageIndices());
      copied.forEach(p => out.addPage(p));
      canvas.width = canvas.height = 0;      // 큰 문서에서 메모리를 즉시 놓아준다
    }

    onProgress?.(sources.length, sources.length, '');
    const bytes = await out.save();
    return {
      blob: new Blob([bytes], { type: 'application/pdf' }),
      text: texts.join('\n\n'),
      pageCount: sources.length,
    };
  }

  /** 각 쪽을 필요할 때 그리도록 만들어 둔다. 미리 다 그리면 메모리를 크게 쓴다. */
  async function pdfPageSources(file, dpi) {
    const pdf = await Core.openWithPdfjs(file);
    const scale = dpi / 72;
    return Array.from({ length: pdf.numPages }, (_, i) => ({
      render: () => Core.renderPage(pdf, i + 1, scale),
    }));
  }

  function blobToCanvas(blob) {
    return new Promise((resolve, reject) => {
      const url = URL.createObjectURL(blob);
      const img = new Image();
      img.onload = () => {
        const cv = document.createElement('canvas');
        cv.width = img.naturalWidth;
        cv.height = img.naturalHeight;
        const ctx = cv.getContext('2d');
        ctx.fillStyle = '#ffffff';
        ctx.fillRect(0, 0, cv.width, cv.height);
        ctx.drawImage(img, 0, 0);
        URL.revokeObjectURL(url);
        resolve(cv);
      };
      img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('이미지를 읽을 수 없습니다.')); };
      img.src = url;
    });
  }

  return { toSearchablePdf, release };
})();
