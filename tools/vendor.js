/*
 * tools/vendor.js — web/vendor 안의 라이브러리를 node_modules 에서 다시 복사한다.
 *
 * vendor 폴더의 파일이 어디서 왔는지 이 파일이 곧 기록이다.
 * 라이브러리를 올릴 일이 있으면 package.json 의 버전을 바꾸고
 *   npm install && npm run vendor
 * 를 돌린 뒤, THIRD-PARTY-NOTICES.md 도 함께 갱신할 것.
 *
 * 언어 학습 데이터(web/vendor/tessdata)는 npm 패키지가 아니라서 여기서 다루지 않는다.
 * tessdata_fast 저장소에서 kor/eng 를 받아 gzip 해 둔 것이다.
 */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const OUT = path.join(ROOT, 'web', 'vendor');

const FILES = [
  ['@cantoo/pdf-lib/dist/pdf-lib.min.js', 'pdf-lib.min.js'],
  ['pdfjs-dist/build/pdf.min.js', 'pdf.min.js'],
  ['pdfjs-dist/build/pdf.worker.min.js', 'pdf.worker.min.js'],
  ['jszip/dist/jszip.min.js', 'jszip.min.js'],
  ['tesseract.js/dist/tesseract.min.js', 'tesseract.min.js'],
  ['tesseract.js/dist/worker.min.js', 'tesseract.worker.min.js'],
  // Tesseract 워커는 wasm 이 통째로 들어 있는 단일 파일을 부른다.
  // .js + .wasm 로 나뉜 판을 두면 importScripts 가 실패한다(실측).
  ['tesseract.js-core/tesseract-core-simd-lstm.wasm.js', 'tesseract-core/tesseract-core-simd-lstm.wasm.js'],
  ['tesseract.js-core/tesseract-core-lstm.wasm.js', 'tesseract-core/tesseract-core-lstm.wasm.js'],
];

let copied = 0;
for (const [from, to] of FILES) {
  const src = path.join(ROOT, 'node_modules', from);
  const dst = path.join(OUT, to);
  if (!fs.existsSync(src)) {
    console.error('없음: ' + from + '  (npm install 을 먼저 실행하세요)');
    process.exitCode = 1;
    continue;
  }
  fs.mkdirSync(path.dirname(dst), { recursive: true });
  fs.copyFileSync(src, dst);
  const kb = Math.round(fs.statSync(dst).size / 1024);
  console.log(String(kb).padStart(6) + ' KB  ' + to);
  copied++;
}
console.log('\n' + copied + '/' + FILES.length + '개 복사 완료');
