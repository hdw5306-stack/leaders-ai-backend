/**
 * incentive_validate.js — AI가 만든 시책 규칙을 프로그램에 넣기 전에 점검·정리합니다.
 * AI가 상품명을 지어내거나 숫자 단위를 틀렸을 때, 사람이 확인해야 할 곳에 "확인 필요"를 붙입니다.
 */
const TYPES = ['monthly', 'joiner', 'weekly', 'month13', 'goods', 'tier', 'note'];
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const norm = x => String(x == null ? '' : x).replace(/\s+/g, ' ').trim();
const squash = x => norm(x).replace(/\s/g, '');

function addNote(r, msg) {
  r.review_note = (r.review_note ? r.review_note + ' · ' : '') + msg;
  if (r.review_note.length > 400) r.review_note = r.review_note.slice(0, 397) + '…';
}
function monthRange(period, today) {
  const m = /^(\d{4})-(\d{2})$/.exec(period || '');
  const y = m ? +m[1] : +today.slice(0, 4), mo = m ? +m[2] : +today.slice(5, 7);
  const last = new Date(y, mo, 0).getDate();
  const p = n => String(n).padStart(2, '0');
  return [`${y}-${p(mo)}-01`, `${y}-${p(mo)}-${p(last)}`];
}

const STD_CATS = ['상해(운전자)', '건강(의료)', '어린이', '유병자', '연금·저축', '화재·재물', '펫', '치아', '간병', '실손', '단체'];
const TAG_ALIAS = { '재물&단체': '화재·재물', '재물·단체': '화재·재물', '재물 & 단체': '화재·재물', '단독실손': '실손', '실손보험': '실손', '단체보험': '단체' };
const CAT_WORDS = [['펫', ['펫', '반려']], ['화재·재물', ['화재', '재물']], ['실손', ['실손']], ['단체', ['단체']], ['상해(운전자)', ['운전자', '상해']], ['치아', ['치아']], ['간병', ['간병', '치매']], ['연금·저축', ['연금', '저축']], ['어린이', ['어린이']], ['유병자', ['유병자', '간편']], ['건강(의료)', ['건강', '의료', '실손']]];
function normTag(t) {
  t = String(t || '').replace(/\s+/g, ' ').trim();
  if (!t || STD_CATS.includes(t)) return t;
  if (TAG_ALIAS[t]) return TAG_ALIAS[t];
  const hit = CAT_WORDS.filter(([, ws]) => ws.some(w => t.includes(w))).map(([k]) => k);
  return hit.length === 1 && t.length <= 14 ? hit[0] : t; // 짧은 이름이 한 상품군에만 해당하면 표준 이름으로, 아니면 그대로(추가 조건)
}
function normTagStr(s) { return String(s).split('+').map(g => g.split(',').map(normTag).filter(Boolean).join(',')).filter(Boolean).join('+'); }

// AI가 'KB손해보험', '라이나손해보험'처럼 적어도 수수료표의 이름('KB손보', '에이스(라이나)')으로 맞춥니다
function coKey(n) { return String(n || '').replace(/\(주\)|주식회사|[()\s]/g, '').replace(/손해보험|화재해상보험|화재해상|생명보험|손보|생보|보험|생명|라이프|화재|해상/g, ''); }
function matchCompany(name, names) {
  const n = norm(name); if (!n) return n;
  if (names.includes(n)) return n;
  const sq = squash(n); const bySq = names.find(x => squash(x) === sq); if (bySq) return bySq;
  const k = coKey(n); if (!k) return n;
  const exact = names.filter(x => coKey(x) === k); if (exact.length === 1) return exact[0];
  const part = names.filter(x => { const kx = coKey(x); return kx && k.length >= 2 && kx.length >= 2 && (kx.includes(k) || k.includes(kx)); });
  return part.length === 1 ? part[0] : n;
}
function validate(raw, ctx) {
  const warnings = [];
  const products = ctx.products || {};
  const today = ctx.today;
  let batches = raw && Array.isArray(raw.batches) ? raw.batches : null;
  if (!batches) throw new Error('AI 응답 형식이 올바르지 않습니다(batches 없음).');
  const out = [];
  for (const b0 of batches) {
    const batch = Object.assign({ name: '', company: '', grp: 'life', source: ctx.filename || '', period: '', notes: '' }, b0.batch || {});
    batch.company = norm(batch.company);
    batch.grp = batch.grp === 'nonlife' ? 'nonlife' : 'life';
    {
      const lifeNames = Object.keys(products), nonNames = Object.keys(ctx.nonlife || {});
      if (ctx.force && (lifeNames.includes(ctx.force) || nonNames.includes(ctx.force))) {
        // 본사가 보험사를 직접 골라서 올린 경우: AI가 무엇을 적었든 선택한 보험사로 고정
        const oldCo = batch.company;
        batch.company = ctx.force; batch.grp = nonNames.includes(ctx.force) ? 'nonlife' : 'life';
        if (batch.name) batch.name = oldCo && oldCo !== ctx.force && batch.name.includes(oldCo) ? batch.name.split(oldCo).join(ctx.force) : (batch.name.includes(ctx.force) ? batch.name : ctx.force + ' ' + batch.name);
      } else {
      const hint = ctx.filename || ''; // 파일 이름으로 손해/생명 구분
      if (batch.grp === 'life' && /손보|손해|화재|해상/.test(hint) && !/생명|생보|라이프/.test(hint)) {
        // 파일 이름이 손해보험인데 생명보험사로 읽힌 경우(예: 라이나손보 → 라이나생명) 바로잡음
        const k = coKey(batch.company);
        const cand = k ? nonNames.filter(x => { const kx = coKey(x); return kx && (kx.includes(k) || k.includes(kx)); }) : [];
        if (cand.length === 1) { warnings.push(`파일 이름이 손해보험이라 보험사를 ${batch.company} → ${cand[0]}(으)로 바로잡았습니다. 결과를 꼭 확인해 주세요.`); batch.company = cand[0]; batch.grp = 'nonlife'; }
      }
      const first = batch.grp === 'nonlife' ? nonNames : lifeNames, second = batch.grp === 'nonlife' ? lifeNames : nonNames;
      let m = matchCompany(batch.company, first);
      if (!first.includes(m)) { const m2 = matchCompany(batch.company, second); if (second.includes(m2)) { m = m2; batch.grp = batch.grp === 'nonlife' ? 'life' : 'nonlife'; } }
      if (m !== batch.company) { const old = batch.company; batch.company = m; if (batch.name) batch.name = batch.name.split(old).join(m); }
      }
    }
    batch.source = norm(batch.source) || ctx.filename || '';
    batch.name = norm(batch.name) || `${batch.company} ${batch.period || today.slice(0, 7)} 시책`;
    const labels = products[batch.company] || null;
    const labelByNorm = new Map(), labelBySquash = new Map();
    if (labels) labels.forEach(l => { labelByNorm.set(norm(l), l); labelBySquash.set(squash(l), l); });
    if (!batch.company) { warnings.push('보험사를 알 수 없는 시책 묶음이 있어 제외했습니다.'); continue; }
    if (labels === null && batch.grp === 'life') warnings.push(`${batch.company}: 수수료표에서 상품 목록을 찾지 못해 상품 연결을 하지 못했습니다(보험사 이름이 수수료표와 같은지 확인).`);

    const rules = [];
    (b0.rules || []).forEach((r0, i) => {
      const r = Object.assign({}, r0);
      r.itype = TYPES.includes(r.itype) ? r.itype : 'note';
      r.title = norm(r.title).slice(0, 200) || `${batch.company} 시책 ${i + 1}`;
      r.calc = r.calc === 'fixed' ? 'fixed' : 'pct';
      r.value = Number(r.value) || 0;
      if (r.itype !== 'tier' && r.itype !== 'note' && r.itype !== 'goods' && Array.isArray(r.tiers) && r.tiers.length) {
        // AI가 구간표를 월·13차월 시책 형식으로 잘못 분류한 경우 구간 시상으로 바로잡음
        if (r.itype === 'month13' || Number(r.pay_offset) >= 13) r.tier_bucket = 'm13';
        r.itype = 'tier'; r.value = 0;
      }
      r.stackable = r.stackable === 0 || r.stackable === false ? 0 : 1;
      if (r.itype !== 'note' && r.itype !== 'goods') {
        const tx = `${r.title || ''} ${r.src_text || ''} ${r.memo || ''}`;
        if (/현금/.test(tx) && /(여행|바우처|상품권|골드|(?:^|[^현])금\s*\d+\.?\d*돈|포인트|택\s*1|택일)/.test(tx) && !/현금\s*선택/.test(r.title || '')) {
          r.title = norm(String(r.title || '').slice(0, 180) + ' (현금 선택 시)');
          r.memo = norm(((r.memo ? r.memo + ' · ' : '') + '여행·상품 대신 현금으로 받는 경우의 금액입니다').slice(0, 500));
        }
      }
      if (r.pay_offset != null && r.pay_offset !== '') {
        let po = Math.round(Number(r.pay_offset)) || 0;
        if (po > 16) po = 16;
        if (po >= 4 && po <= 12) addNote(r, `지급 시기 ${po}차월은 드문 값입니다 — 공지 확인 필요`);
        r.pay_offset = po > 0 ? po : undefined;
      }
      if (Array.isArray(r.prod_kw)) {
        const seenKw = new Set();
        r.prod_kw = r.prod_kw.map(x => norm(x).slice(0, 40)).filter(x => x.length >= 2 && !seenKw.has(x) && seenKw.add(x)).slice(0, 60);
        if (!r.prod_kw.length || batch.grp !== 'nonlife') delete r.prod_kw;
      } else delete r.prod_kw;
      r.review_note = r.review_note ? norm(r.review_note).slice(0, 400) : undefined;
      if (r.src_text) r.src_text = norm(r.src_text).slice(0, 300);
      if (r.memo) r.memo = norm(r.memo).slice(0, 500);

      // 기간
      if (!DATE.test(r.start || '') || !DATE.test(r.end || '') || r.end < r.start) {
        const [s, e] = monthRange(batch.period, today);
        r.start = s; r.end = e; addNote(r, '공지에서 기간을 읽지 못해 해당 월 전체로 가정했습니다 — 기간 확인 필요');
      }
      // 금액·단위 점검
      if (['monthly', 'weekly', 'joiner', 'month13'].includes(r.itype)) {
        if (!(r.value > 0)) { r.itype = 'note'; addNote(r, '금액(%)을 읽지 못해 계산에서 제외했습니다 — 확인 필요'); }
        else if (r.calc === 'pct' && r.value > 1500) addNote(r, `비율 ${r.value}%가 매우 큽니다 — 공지 확인 필요`);
        else if (r.calc === 'fixed' && r.value < 1000) addNote(r, `정액 ${r.value}원이 너무 작습니다 — 단위(만원/원) 확인 필요`);
        if (r.itype === 'month13' && !r.pay_offset) r.pay_offset = 13;
        if (r.itype === 'monthly' && !r.pay_offset) r.pay_offset = 1;
      }
      if (r.itype === 'tier') {
        let tiers = Array.isArray(r.tiers) ? r.tiers : [];
        tiers = tiers.map(t => ({ min: Number(t.min), pay: Number(t.pay), ...(t.prev != null && t.prev !== '' ? { prev: Number(t.prev) } : {}) }))
          .filter(t => t.min > 0 && t.pay > 0);
        if (!tiers.length) { r.itype = 'note'; delete r.tiers; addNote(r, '구간표를 읽지 못해 계산에서 제외했습니다 — 확인 필요'); }
        else {
          r.tiers = tiers;
          if (tiers.some(t => t.min < 1000 || t.pay < 1000)) addNote(r, '구간 금액이 1,000원 미만입니다 — 단위(만원/원) 확인 필요');
          const span = (new Date(r.end) - new Date(r.start)) / 86400000;
          if (span > 62) { r.itype = 'note'; delete r.tiers; addNote(r, `기간이 ${Math.round(span)}일(2개월 초과)이라 한 달 입력으로 판정할 수 없어 계산에서 제외했습니다 — 여러 달 연속 조건 확인`); }
          else {
          r.tier_bucket = r.tier_bucket === 'm13' ? 'm13' : 'next';
          // 연속가동형(전기간 조건이 있는 구간표)의 짝 맞춤 점검: 이번 기간 기준(min)은 같고, 전기간(prev)이 커질수록 시상이 커져야 정상
          const withPrev = tiers.filter(t => t.prev);
          if (withPrev.length) {
            const mins = new Set(withPrev.map(t => t.min));
            const sorted = [...withPrev].sort((a, b) => a.prev - b.prev);
            const mono = sorted.every((t, i) => i === 0 || t.pay >= sorted[i - 1].pay);
            const dupPrev = new Set(withPrev.map(t => t.prev)).size !== withPrev.length;
            const samePairs = withPrev.every(t => t.min === t.prev) || (Array.isArray(r.prereq) && r.prereq.some(p => p && p.same_level));
            if (!samePairs && (mins.size > 1 || !mono || dupPrev)) addNote(r, '전기간 실적과 시상금의 짝이 공지 표와 맞는지 확인이 필요합니다 (이번 기간 기준이 서로 다르거나 시상금이 순서대로 늘지 않음)');
          }
          if (Array.isArray(r.prereq)) r.prereq = r.prereq.filter(p => DATE.test(p.start || '') && DATE.test(p.end || ''));
          }
        }
      }
      // 상품 연결 점검
      if (Array.isArray(r.targets)) {
        if (labels) {
          const fixed = [], bad = [];
          for (const t of r.targets) {
            const hit = labelByNorm.get(norm(t)) || labelBySquash.get(squash(t));
            if (hit) { if (!fixed.includes(hit)) fixed.push(hit); } else bad.push(t);
          }
          if (bad.length) {
            addNote(r, `AI가 적은 상품 ${bad.length}건이 수수료표에 없어 제외했습니다 (예: ${bad.slice(0, 2).map(norm).join(' / ').slice(0, 80)})`);
            warnings.push(`${batch.company} · ${r.title}: 수수료표에 없는 상품명 ${bad.length}건 제외`);
          }
          if (!fixed.length) {
            if (r.itype !== 'note' && r.itype !== 'goods') { addNote(r, '대상 상품을 수수료표에서 찾지 못해 계산에서 제외했습니다 — 본사 확인 필요'); r.itype = 'note'; }
            delete r.targets;
          } else r.targets = fixed;
        } else if (batch.grp === 'life') delete r.targets;
      } else delete r.targets;
      if (batch.grp === 'nonlife') { delete r.targets; if (r.tag) r.tag = normTagStr(r.tag); if (Array.isArray(r.not_tags)) r.not_tags = r.not_tags.map(normTag).filter(Boolean); }
      // 안전장치: 손해보험에서 '일부 상품에만 적용'이라고 읽었는데 상품군 조건(tag)이 비어 있으면, 보험사 전체에 적용되는 오류가 나므로
      // 범위 미정('?범위미정')으로 표시해 본사가 정하기 전까지 계산에서 제외하고 확정도 막습니다.
      if (batch.grp === 'nonlife' && r.itype !== 'note' && r.itype !== 'goods' && !r.tag && !(r.prod_kw && r.prod_kw.length)) {
        const mm = String(r.memo || '');
        const limited = /상품\s*범위/.test(String(r.review_note || '')) || (/대상\s*상품\s*[:：]/.test(mm) && !/대상\s*상품\s*[:：]\s*(전체|모든|전 상품)/.test(mm));
        if (limited) { r.tag = '?범위미정'; addNote(r, '일부 상품에만 적용되는 시책입니다 — 상품군을 정하기 전까지 계산에서 제외됩니다'); warnings.push(`${batch.company} · ${r.title}: 상품 범위 미정 (계산 제외)`); }
      }
      r.grp = batch.grp; r.company = batch.company;
      Object.keys(r).forEach(k => r[k] === undefined && delete r[k]);
      rules.push(r);
    });
    // 같은 상품에 같은 종류·같은 지급시점의 시책이 둘 이상 겹치면 합산되므로 눈에 띄게 표시
    const money = rules.filter(r => ['monthly', 'weekly', 'joiner', 'month13'].includes(r.itype) && Array.isArray(r.targets));
    for (let i = 0; i < money.length; i++) {
      for (let j = i + 1; j < money.length; j++) {
        const a = money[i], b = money[j];
        if (a.itype !== b.itype || (a.pay_offset || 0) !== (b.pay_offset || 0)) continue;
        if (a.end < b.start || b.end < a.start) continue;
        const sa = new Set(a.targets);
        const shared = b.targets.filter(t => sa.has(t)).length;
        if (!shared) continue;
        const msg = `같은 상품 ${shared}건에 같은 종류 시책이 둘 이상 겹쳐 합산됩니다 — 「${a.title.slice(0, 30)}」와(과) 함께 맞는지 확인`;
        addNote(b, msg); if (!a.review_note || !/겹쳐 합산/.test(a.review_note)) addNote(a, `「${b.title.slice(0, 30)}」와(과) 같은 상품이 겹쳐 합산됩니다 — 확인 필요`);
        warnings.push(`${batch.company}: ${a.title} / ${b.title} — 같은 상품 ${shared}건이 겹침`);
      }
    }
    if (!rules.length) { warnings.push(`${batch.company}: 읽어낸 시책이 없습니다.`); continue; }
    batch.notes = ('AI가 공지에서 읽어 만든 초안입니다. 원본 공지와 대조해 확인한 뒤 확정하세요.' + (batch.notes ? ' ' + batch.notes : '')).slice(0, 480);
    out.push({ batch, rules });
  }
  if (!out.length) throw new Error('공지에서 시책을 읽어내지 못했습니다. 시책 공지가 맞는지, 파일이 깨지지 않았는지 확인해 주세요.');
  return { batches: out, warnings };
}

module.exports = { validate, norm };
