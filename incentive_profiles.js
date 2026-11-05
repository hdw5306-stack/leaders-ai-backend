'use strict';
// ─────────────────────────────────────────────────────────────────────────────
// 보험사별 고정 기준표 — 매달 거의 바뀌지 않는 내용(건당 인정 한도, 제외 상품군, 지급 시기 표기 등)은
// AI가 읽은 결과에 의존하지 않고 이 표대로 항상 똑같이 적용합니다.
// 새 보험사는 공지를 한 번 원문과 대조해 확인한 뒤 이 표에 추가합니다.
// 필드
//   cap:        { default: 건당 인정 한도(원) — 한도가 비어 있는 계산 시책에 채움(재물·단체·펫 시책 제외) }
//   driver:     { cap, titleRe } — 운전자보험은 건당 한도가 달라 '운전자'와 '그 외'로 나눌 시책(제목 패턴)
//   stripNot:   제외 상품군에서 빼야 할 이름(예: 롯데의 "실손(…유병자 등)"을 유병자 제외로 읽은 경우)
//   ensureNot:  { titleRe, tags } — 상품군을 따로 지정하지 않은 해당 시책에 반드시 들어가야 할 제외 상품군
//   pay:        [{ re, offset }] 제목이 패턴에 맞으면 지급 시기(개월 뒤)를 고정
// ─────────────────────────────────────────────────────────────────────────────
const PROFILES = {
  '롯데손보': {
    note: '건당 25만원(운전자 10만원), 실손·단체·재물·저축·연금 제외, 대리점 자체 180%는 익익월',
    cap: { default: 250000 },
    driver: { cap: 100000, titleRe: /기본시상|대리점\s*자체/ },
    stripNot: ['유병자'],
    ensureNot: { titleRe: /기본시상|대리점\s*자체/, tags: ['실손', '연금·저축', '화재·재물', '단체', '단체(1년)', '펫'] },
    pay: [{ re: /대리점\s*자체/, offset: 2 }],
  },
  '에이스(라이나)': {
    note: '건당 20만원 한도(전 시책), 엠금융 자체시상 300%는 익월',
    cap: { default: 200000 },
    pay: [{ re: /엠금융.*자체|자체시상/, offset: 1 }],
  },
  '메리츠화재': {
    note: '건당 30만원(운전자 10만원), 인보험 시책에서 함께하는단체보험·펫퍼민트·실손 제외, 엠금융 선지급 250%는 익익월',
    cap: { default: 300000 },
    driver: { cap: 100000, titleRe: /정규\s*시상\s*인보험|선지급/ },
    ensureNot: { titleRe: /인보험|선지급/, tags: ['실손', '연금·저축', '화재·재물', '단체', '단체(1년)', '펫'] },
    pay: [{ re: /선지급/, offset: 2 }],
    warn: '메리츠: 상해(운전자)는 한 상품군이라 운전자 건당 한도 10만원이 일반 상해보험에도 같이 적용됩니다(일반 상해는 원래 30만원).',
  },
  '현대해상': {
    note: '건당 30만원(운전자 10만원), 인보험 시책에서 실손·단체·펫·연금·재물 제외, 인보험 추가시상은 익익월',
    cap: { default: 300000 },
    driver: { cap: 100000, titleRe: /인보험\s*(기본|추가)시상/ },
    ensureNot: { titleRe: /인보험\s*(기본|추가)시상/, tags: ['실손', '연금·저축', '화재·재물', '단체', '단체(1년)', '펫'] },
    pay: [{ re: /인보험\s*추가시상|하이바이크.*추가시상|어린이종합.*추가시상/, offset: 2 }],
  },
  '흥국화재': {
    note: '건당 30만원(운전자·치매·치매간병 10만원), 흥국 200%는 익월·엠금융 선지원 250%는 익익월, 실손·본인계약·영업용 운전자 제외',
    cap: { default: 300000 },
    driver: { cap: 100000, titleRe: /기본\s*시상/ },
    ensureNot: { titleRe: /기본\s*시상/, tags: ['실손', '연금·저축', '화재·재물', '단체(1년)', '펫'] },
    pay: [{ re: /흥국화재\s*\d+\s*%/, offset: 1 }, { re: /선지원|선지급/, offset: 2 }],
    warn: '흥국화재: 공통사항의 “치매·치매간병 담보는 건당 10만원까지 인정”과 “보장P 구성비 50% 미만(운전자 30% 미만) 제외”는 자동 계산하지 않습니다. 해당 계약은 직접 확인하세요.',
  },
  'DB손보': {
    note: '일반 건당 30만원 한도(운전자 등 10만원·치아사랑 7만원은 안내), 인보험 250%는 엠금융 익익월',
    cap: { default: 300000 },
  },
};

const norm = x => String(x == null ? '' : x).replace(/\s+/g, ' ').trim();
const key = n => String(n || '').replace(/\(주\)|주식회사|[()\s]/g, '');
const profileOf = company => {
  const k = key(company);
  const hit = Object.keys(PROFILES).find(n => key(n) === k);
  return hit ? PROFILES[hit] : null;
};
const SKIP_CAP_TAG = /재물|단체|펫|반려|적립|연금|저축/;

function applyProfiles(batches, warnings) {
  batches.forEach(ba => {
    const b = ba.batch;
    if (b.grp !== 'nonlife') return;
    const p = profileOf(b.company);
    if (!p) {
      warnings.push(`${b.company}: 이 보험사는 아직 고정 기준표가 없는 처음 읽는 공지입니다 — 건당 한도·제외 상품군·지급 시기를 원문과 꼭 대조하세요. 확인이 끝나면 기준표에 등록됩니다.`);
      return;
    }
    const done = { cap: 0, strip: 0, ensure: 0, pay: 0, split: 0 };
    const money = ba.rules.filter(r => r.itype !== 'note' && r.itype !== 'goods');
    // ① 지급 시기 고정
    (p.pay || []).forEach(x => money.forEach(r => {
      if (r.itype === 'monthly' && x.re.test(r.title || '') && (r.pay_offset || 1) !== x.offset) { r.pay_offset = x.offset; done.pay++; }
    }));
    // ② 제외 상품군 정리
    (p.stripNot || []).forEach(t => money.forEach(r => {
      if (Array.isArray(r.not_tags) && r.not_tags.includes(t)) { r.not_tags = r.not_tags.filter(x => x !== t); done.strip++; }
    }));
    if (p.ensureNot) money.forEach(r => {
      if (r.itype !== 'monthly' && r.itype !== 'month13' && r.itype !== 'tier') return;
      if (r.tag || !p.ensureNot.titleRe.test(r.title || '')) return;
      const cur = Array.isArray(r.not_tags) ? r.not_tags.slice() : [];
      const add = p.ensureNot.tags.filter(t => !cur.includes(t));
      if (add.length) { r.not_tags = cur.concat(add); done.ensure++; }
    });
    // ③ 건당 한도 채우기
    if (p.cap && p.cap.default) money.forEach(r => {
      if (r.cap_premium) return;
      if (SKIP_CAP_TAG.test(`${r.tag || ''} ${r.title || ''}`)) return;
      r.cap_premium = p.cap.default; done.cap++;
    });
    // ④ 운전자 분리
    if (p.driver) {
      const add = [];
      money.forEach(r => {
        if (r.itype !== 'monthly' && r.itype !== 'month13') return;
        if (r.tag || !p.driver.titleRe.test(r.title || '')) return;
        if (Array.isArray(r.not_tags) && r.not_tags.includes('상해(운전자)')) return;
        if (/운전자\s*$/.test(r.title || '')) return;
        if (ba.rules.some(x => x !== r && x.tag === '상해(운전자)' && x.itype === r.itype && Number(x.value) === Number(r.value) && (x.pay_offset || 0) === (r.pay_offset || 0))) return;
        const base = String(r.title).replace(/\s*[—-]\s*운전자\s*외\s*$/, '');
        const c = JSON.parse(JSON.stringify(r));
        c.title = norm(base + ' — 운전자'); c.tag = '상해(운전자)'; c.cap_premium = p.driver.cap; c.not_tags = [];
        c.review_note = ''; c.memo = norm(`운전자보험은 건당 인정 한도 ${p.driver.cap / 10000}만원으로 따로 적용`);
        r.title = norm(base + ' — 운전자 외'); r.not_tags = (Array.isArray(r.not_tags) ? r.not_tags : []).concat('상해(운전자)');
        if (/운전자.*(분리|별도)/.test(r.review_note || '')) r.review_note = '';
        add.push(c); done.split++;
      });
      if (add.length) ba.rules.push(...add);
    }
    if (p.warn) warnings.push(p.warn);
    const parts = [];
    if (done.pay) parts.push(`지급 시기 ${done.pay}건`);
    if (done.strip) parts.push(`제외 상품군 정정 ${done.strip}건`);
    if (done.ensure) parts.push(`제외 상품군 보완 ${done.ensure}건`);
    if (done.cap) parts.push(`건당 한도 ${done.cap}건`);
    if (done.split) parts.push(`운전자 분리 ${done.split}건`);
    if (parts.length) warnings.push(`${b.company}: 고정 기준표(${p.note})를 적용해 ${parts.join(', ')}을(를) 맞췄습니다.`);
  });
}
module.exports = { applyProfiles, profileOf, PROFILES };
