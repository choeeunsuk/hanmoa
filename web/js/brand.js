/*
 * brand.js — 앱 이름과 문구를 한곳에 모아둔다.
 *
 * 이름을 바꿀 일이 생기면 이 파일만 고치면 된다. 화면의 제목, 로고, 탭 제목,
 * 푸터가 여기 값을 읽어 간다.
 */
'use strict';

const BRAND = {
  name: '한모아',
  nameLatin: 'Hanmoa',
  mark: '한',
  tagline: '한글까지 되는 무료 PDF 도구',

  heroTitle: ['모든 PDF 작업을 ', '브라우저 안에서'],
  heroSub: [
    '파일이 서버로 올라가지 않습니다. 변환은 여러분의 컴퓨터에서 끝납니다.',
    '그리고 <strong>한글(HWP) 문서 여러 개를 하나의 PDF로</strong> 묶을 수 있습니다.',
  ],

  footer: '무료 · 오픈소스 · 파일은 브라우저를 떠나지 않습니다',

  disclaimer:
    '독립적인 오픈소스 프로젝트입니다. 한글과컴퓨터, Microsoft 를 비롯한 ' +
    '어떤 회사와도 제휴하거나 후원받지 않았습니다. 각 상표는 해당 소유자의 자산입니다.',
};

/** 문서 제목과 화면의 브랜드 표기를 BRAND 값으로 채운다. */
function applyBrand() {
  document.title = BRAND.name + ' — ' + BRAND.tagline;

  const mark = document.querySelector('.brand-mark');
  if (mark) mark.textContent = BRAND.mark;

  const nameEl = document.querySelector('.brand-name');
  if (nameEl) nameEl.textContent = BRAND.name;

  const brandLink = document.querySelector('.brand');
  if (brandLink) brandLink.setAttribute('aria-label', BRAND.name + ' 홈');

  const h1 = document.querySelector('.hero h1');
  if (h1) {
    h1.textContent = BRAND.heroTitle[0];
    const em = document.createElement('em');
    em.textContent = BRAND.heroTitle[1];
    h1.appendChild(em);
  }

  const sub = document.querySelector('.hero-sub');
  if (sub) sub.innerHTML = BRAND.heroSub.join('<br>');

  const foot = document.querySelector('.site-footer');
  if (foot) {
    foot.textContent = '';
    const p = document.createElement('p');
    p.textContent = BRAND.name + ' (' + BRAND.nameLatin + ') · ' + BRAND.footer;
    const small = document.createElement('p');
    small.className = 'disclaimer';
    small.textContent = BRAND.disclaimer;
    foot.append(p, small);
  }
}
