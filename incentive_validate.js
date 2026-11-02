/**
 * incentive_validate.js — AI가 만든 시책 규칙을 프로그램에 넣기 전에 점검·정리합니다.
 * AI가 상품명을 지어내거나 숫자 단위를 틀렸을 때, 사람이 확인해야 할 곳에 "확인 필요"를 붙입니다.
 */
const TYPES = ['monthly', 'joiner', 'weekly', 'month13', 'goods', 'tier', 'note'];
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const norm = x => String(x == null ? '' : x).replace(/\s+/g, ' ').trim();
const squash = x => norm(x).replace(/\s/g, '');

// 공지 원문(src_text)에 "5만↑ 3만, 10만↑ 5만" 처럼 구간과 금액이 함께 적혀 있으면 {구간(원) → 시상금(원)} 으로 읽어 AI가 읽은 금액과 대조합니다.
function pairsFromText(t) {
  const m = new Map(), re = /(\d+(?:[.,]\d+)?)\s*만\s*원?\s*(?:↑|이상)\s*[:：]?\s*(\d+(?:[.,]\d+)?)\s*만/g;
  let x; const n = v => Math.round(parseFloat(String(v).replace(/,/g, '')) * 10000);
  while ((x = re.exec(String(t || '')))) m.set(n(x[1]), n(x[2]));
  return m;
}
// 공통기준에 적힌 "건당 20만원 한도" 같은 인정 한도(원)를 모읍니다.
function capsFromText(t) {
  const set = new Set(), re = /건당\s*P?\s*(?:최대\s*)?(\d+(?:[.,]\d+)?)\s*만\s*원?\s*(?:초과|이상)?[^.\n]{0,12}?(?:한도|限|인정|까지)/g;
  let x; while ((x = re.exec(String(t || '')))) set.add(Math.round(parseFloat(x[1].replace(/,/g, '')) * 10000));
  return set;
}
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

// ── 건당 최소 보험료 조건("30만↑건 限") 자동 반영 ──
const MINP_RE = /(\d+(?:\.\d+)?)\s*(천만|만|억)?\s*원?\s*(?:↑|이상)\s*건\s*(?:限|限定|한정|만\s*(?:인정|시상|적용))|(\d+(?:\.\d+)?)\s*(천만|만|억)?\s*원?\s*이상\s*(?:인|의)?\s*건에?\s*(?:한|限)/;
function minpFrom(text) {
  const m = MINP_RE.exec(String(text || '')); if (!m) return null;
  const n = parseFloat(m[1] || m[3]), u = m[2] || m[4];
  const v = Math.round(n * (u === '억' ? 1e8 : u === '천만' ? 1e7 : u === '만' ? 1e4 : 1));
  return v >= 10000 ? v : null;
}
const COND_KEYS = ['재물', '단체', '인보험', '펫', '건강', '어린이', '운전자', '연금', '저축', '치아', '간병', '실손', '종신', '정기', '암'];
// 옮겨 적은 조건 문구(tr.conds)에서 최소 보험료를 찾아 해당 시책에 적용 (열 이름이 맞는 시책만)
function applyMinFromConds(r, tr) {
  if (!tr || !Array.isArray(tr.conds) || r.min_premium) return;
  if (r.itype === 'tier' || r.itype === 'note' || r.itype === 'goods') return;
  const rt = `${r.title || ''} ${r.tag || ''}`;
  for (const c0 of tr.conds) {
    const c = String(c0 || ''), mp = minpFrom(c); if (!mp) continue;
    const keys = COND_KEYS.filter(k => c.includes(k)); if (keys.length && !keys.some(k => rt.includes(k))) continue;
    if (!keys.length && simil(r.title, c) < 0.2) continue;
    if (c.includes('추가') && !rt.includes('추가')) continue;
    if (c.includes('기본') && !c.includes('추가') && !rt.includes('기본')) continue;
    r.min_premium = mp; r.memo = norm(((r.memo ? r.memo + ' · ' : '') + `건당 ${mp.toLocaleString('ko-KR')}원 이상 건만 인정 (공지 표 머리글)`).slice(0, 500)); return;
  }
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
      if (r.min_premium != null && r.min_premium !== '') { const mp = Math.round(Number(r.min_premium)); if (mp > 0) r.min_premium = mp; else delete r.min_premium; } else delete r.min_premium;
      if (!r.min_premium && r.itype !== 'tier' && r.itype !== 'note' && r.itype !== 'goods') { const mp = minpFrom(`${r.src_text || ''} ${r.memo || ''} ${r.title || ''}`); if (mp) { r.min_premium = mp; r.memo = norm(((r.memo ? r.memo + ' · ' : '') + `건당 ${mp.toLocaleString('ko-KR')}원 이상 건만 인정`).slice(0, 500)); } }
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
          { // 공지 원문과 금액 대조 — 어긋나면 원문 기준으로 바로잡고 확인 표시
            const pr = pairsFromText(r.src_text);
            if (pr.size >= 2) {
              let fixedN = 0;
              tiers.forEach(t => { if (!t.prev && pr.has(t.min) && pr.get(t.min) !== t.pay) { t.pay = pr.get(t.min); fixedN++; } });
              if (fixedN) { addNote(r, `AI가 읽은 금액 ${fixedN}건이 공지 원문과 달라 원문 기준으로 바로잡았습니다 — 확인 필요`); warnings.push(`${batch.company} · ${r.title}: 금액 ${fixedN}건을 원문 기준으로 정정`); }
            }
          }
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
            if (samePairs) addNote(r, '연속가동 짝 확인: 두 번째 기간 기준이 구간마다 똑같은 구간인지, 합쳐진 한 칸(모든 구간 공통 기준)인지 공지 표에서 확인 필요');
            if (!samePairs && (mins.size > 1 || !mono || dupPrev)) addNote(r, '전기간 실적과 시상금의 짝이 공지 표와 맞는지 확인이 필요합니다 (이번 기간 기준이 서로 다르거나 시상금이 순서대로 늘지 않음)');
          }
          if (Array.isArray(r.prereq)) r.prereq = r.prereq.filter(p => DATE.test(p.start || '') && DATE.test(p.end || ''));
          // 연속가동: 본 기간(start~end)은 '나중 기간', prereq 는 '앞 기간'이어야 합니다. 둘이 같게 읽혔으면 원문의 기간들로 바로잡습니다.
          if (Array.isArray(r.prereq) && r.prereq.length === 1 && r.prereq[0].start === r.start && r.prereq[0].end === r.end) {
            const yr = +r.start.slice(0, 4), rm = +r.start.slice(5, 7), out2 = [];
            const re = /(\d{1,2})\.(\d{1,2})\s*~\s*(?:(\d{1,2})\.)?(\d{1,2})/g; let m;
            const iso = (mo, d) => `${yr + (mo < rm - 6 ? 1 : 0)}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
            while ((m = re.exec(String(r.src_text || '')))) out2.push([iso(+m[1], +m[2]), iso(+(m[3] || m[1]), +m[4])]);
            if (out2.length >= 2 && out2[0][0] !== out2[out2.length - 1][0]) {
              const first = out2[0], last = out2[out2.length - 1];
              r.prereq = [Object.assign({}, r.prereq[0], { start: first[0], end: first[1], label: `${+first[0].slice(5, 7)}.${+first[0].slice(8)}~${+first[1].slice(5, 7)}.${+first[1].slice(8)}` })];
              r.start = last[0]; r.end = last[1];
              addNote(r, '연속가동의 앞·뒤 기간이 같게 읽혀 공지 원문의 기간 순서로 바로잡았습니다(앞 기간 → 뒤 기간) — 확인 필요');
            } else addNote(r, '연속가동의 앞 기간과 뒤 기간이 같게 읽혔습니다 — 공지 표에서 기간 확인 필요');
          }
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
    // 공통기준에 인정 한도(건당 N만원)가 한 가지로 적혀 있으면 한도가 비어 있는 계산 대상 시책에 적용
    {
      const caps = new Set();
      rules.filter(r => r.itype === 'note').forEach(r => capsFromText(`${r.title} ${r.src_text || ''} ${r.memo || ''}`).forEach(c => caps.add(c)));
      if (caps.size === 1) {
        const cap = [...caps][0];
        let n = 0;
        rules.forEach(r => { if (r.itype !== 'note' && r.itype !== 'goods' && !r.cap_premium) { r.cap_premium = cap; n++; } });
        if (n) warnings.push(`${batch.company}: 공통기준 ‘건당 ${cap / 10000}만원 한도’를 시책 ${n}건에 적용`);
      } else if (caps.size > 1) {
        rules.filter(r => r.itype === 'note').forEach(r => { if (capsFromText(`${r.title} ${r.src_text || ''} ${r.memo || ''}`).size) addNote(r, '건당 인정 한도가 여러 가지입니다 — 시책별 한도(cap)를 직접 확인하세요'); });
      }
    }
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

// ───────── 교차 검증: 두 번 읽은 결과 비교 + 공지 원문 옮겨 적기(숫자 짝) 대조 ─────────
function parseWon(x) {
  const t = String(x == null ? '' : x).replace(/\s+/g, '');
  const m = /(\d+(?:,\d{3})*(?:\.\d+)?)(천만|만|억|원)?/.exec(t);
  if (!m) return null;
  const n = parseFloat(m[1].replace(/,/g, ''));
  const u = m[2];
  const v = u === '억' ? n * 1e8 : u === '천만' ? n * 1e7 : u === '만' ? n * 1e4 : n;
  return Math.round(v);
}
const won = n => Number(n).toLocaleString('ko-KR') + '원';
function ruleSig(r) {
  return {
    유형: r.itype, 시작: r.start, 끝: r.end, 단위: r.calc, 값: Number(r.value) || 0, 지급시기: r.pay_offset || 0,
    상품군: r.tag || '', 제외: (r.not_tags || []).slice().sort().join(','), 한도: r.cap_premium || 0,
    상품명: (r.prod_kw || []).slice().sort().join(','), 대상상품: (r.targets || []).slice().sort().join('|'),
    구간: (r.tiers || []).map(t => `${t.prev || 0}/${t.min}/${t.pay}`).join(','), 구간지급: r.tier_bucket || '',
  };
}
function bigrams(x) { const s = squash(x); const o = new Set(); for (let i = 0; i < s.length - 1; i++) o.add(s.slice(i, i + 2)); return o; }
function simil(a, b) { const A = bigrams(a), B = bigrams(b); let n = 0; A.forEach(g => { if (B.has(g)) n++; }); return n / Math.max(1, Math.min(A.size, B.size)); }
// 지급시기: 공지 문구(13회차 유지 → 13차월 이후, 익월 → 1~3차월)와 A 읽기가 스스로 맞으면 두 번째 읽기와 달라도 문제 삼지 않습니다
function offsetOk(r) {
  const t = `${r.title || ''} ${r.src_text || ''}`, o = Number(r.pay_offset) || 0;
  if (/13\s*(회차|차월)|13차/.test(t)) return o >= 13;
  if (/익월|익익월/.test(t)) return o >= 1 && o <= 3;
  return false;
}
function diffText(a, b) {
  const sa = ruleSig(a), sb = ruleSig(b), out = [];
  for (const k of Object.keys(sa)) {
    if (String(sa[k]) === String(sb[k])) continue;
    if (k === '지급시기' && offsetOk(a)) continue;
    if (k === '구간') {
      const f = x => (x.tiers || []).map(t => `${t.prev ? '전기간 ' + won(t.prev) + '+' : ''}${won(t.min)}↑ ${won(t.pay)}`).join(', ');
      out.push(`구간·금액 다름 → 다른 쪽 읽기: ${f(b)}`.slice(0, 220));
    } else out.push(`${k} 다름(다른 쪽: ${String(sb[k]).slice(0, 40) || '없음'})`);
  }
  return out;
}
function trPairs(tr) {
  const out = [];
  (tr && tr.pairs || []).forEach(p => {
    if (/%/.test(String(p.value))) return;
    const h = parseWon(p.head), v = parseWon(p.value);
    if (h != null && v != null) out.push({ ctx: String(p.ctx || ''), h, v });
  });
  return out;
}
// 이 시책의 표(제목 + 시작일 행)에 해당하는 옮겨 적은 칸들만 골라냅니다. 못 찾으면 null.
function tableSpecific(r, pairs) {
  const m = /^\d{4}-(\d{2})-(\d{2})$/.exec(r.start || ''); if (!m) return null;
  const mo = +m[1], d = +m[2];
  const re = new RegExp(`(^|[^0-9])${mo}\\s*[.월/]\\s*${d}(?![0-9])`);
  const groups = new Map();
  pairs.forEach(p => { if (re.test(p.ctx)) { if (!groups.has(p.ctx)) groups.set(p.ctx, []); groups.get(p.ctx).push(p); } });
  if (!groups.size) return null;
  let best = null, bs = 0.25;
  groups.forEach((g, ctx) => { const sc = simil(r.title, ctx); if (sc > bs) { bs = sc; best = g; } });
  return best && best.length >= 2 ? best : null;
}
// 반환: { msgs: [...], specific: 표를 정확히 찾아 대조했는지 }
function auditAgainstTranscript(r, tr) {
  const res = { msgs: [], specific: false };
  if (!tr) return res;
  const pairs = trPairs(tr);
  const pairSet = new Set(pairs.map(p => `${p.h}:${p.v}`)), valSet = new Set(pairs.map(p => p.v)), pctSet = new Set();
  const grabPct = t => { const re = /(\d+(?:\.\d+)?)\s*%/g; let x; while ((x = re.exec(String(t || '')))) pctSet.add(parseFloat(x[1])); };
  (tr.percents || []).forEach(grabPct); grabPct(tr.text); (tr.pairs || []).forEach(p => grabPct(p.value));
  const re2 = /(\d+(?:[.,]\d+)?)\s*만\s*원?\s*(?:↑|이상)\s*[:：]?\s*(\d+(?:[.,]\d+)?)\s*만/g; let y;
  while ((y = re2.exec(String(tr.text || '')))) { const h = Math.round(parseFloat(y[1].replace(/,/g, '')) * 1e4), v = Math.round(parseFloat(y[2].replace(/,/g, '')) * 1e4); pairSet.add(`${h}:${v}`); valSet.add(v); }
  if (r.itype === 'tier' && Array.isArray(r.tiers) && pairSet.size >= 2) {
    const spec = tableSpecific(r, pairs);
    const useSet = spec ? new Set(spec.map(p => `${p.h}:${p.v}`)) : pairSet;
    res.specific = !!spec;
    const bad = r.tiers.filter(t => !t.prev && !useSet.has(`${t.min}:${t.pay}`));
    const badPrev = r.tiers.filter(t => t.prev && valSet.size && !valSet.has(t.pay));
    if (bad.length) res.msgs.push(`공지 ${spec ? '해당 표' : '표'}에서 ${bad.slice(0, 2).map(t => `${won(t.min)}↑→${won(t.pay)}`).join(', ')}${bad.length > 2 ? ' 등' : ''} 짝을 찾지 못했습니다`);
    if (badPrev.length) res.msgs.push(`시상금 ${badPrev.slice(0, 2).map(t => won(t.pay)).join(', ')}이(가) 공지에서 확인되지 않습니다`);
  } else if (r.itype !== 'tier' && r.itype !== 'note' && r.itype !== 'goods') {
    if (r.calc === 'pct' && pctSet.size >= 1 && r.value > 0 && !pctSet.has(r.value)) res.msgs.push(`${r.value}%가 공지의 % 표기에서 확인되지 않습니다`);
    if (r.calc === 'fixed' && valSet.size >= 2 && r.value > 0 && !valSet.has(r.value)) res.msgs.push(`${won(r.value)}이(가) 공지에서 확인되지 않습니다`);
  }
  return res;
}
// A 읽기 결과(out)에 B 읽기 결과와 옮겨 적기 대조 결과를 반영합니다. 반환: 요약 정보
function crossCheck(outA, outB, tr) {
  const warnings = [];
  let total = 0, agreed = 0, flagged = 0;
  const money = r => r.itype !== 'note' && r.itype !== 'goods';
  const pickB = (a, pool, used) => {
    let cands = pool.filter(b => !used.has(b) && b.itype === a.itype && b.start === a.start && b.end === a.end);
    if (!cands.length) cands = pool.filter(b => !used.has(b) && b.start === a.start && b.end === a.end);
    let best = null, bs = -1;
    cands.forEach(b => {
      const sc = simil(a.title, b.title) + (a.tag === b.tag ? 0.5 : 0) + ((a.tiers || []).filter(t => (b.tiers || []).some(u => u.min === t.min && (u.prev || 0) === (t.prev || 0))).length) * 0.2 + (a.value && a.value === b.value ? 0.5 : 0);
      if (sc > bs) { bs = sc; best = b; }
    });
    return best;
  };
  let bUsable = false;
  for (const ba of outA) {
    const bb = outB ? outB.find(x => x.batch.company === ba.batch.company) : null;
    const pool = bb ? bb.rules.filter(money).slice() : [];
    // ① 두 번째 읽기가 믿을 만한지 먼저 판단: 첫 번째 읽기 항목 중 절반 이상을 찾아내지 못하면 두 번째 읽기는 부실한 것으로 보고 비교에 쓰지 않습니다
    const aMoney = ba.rules.filter(money);
    const probe = new Set(); let hit = 0;
    aMoney.forEach(a => { const b = pickB(a, pool, probe); if (b) { probe.add(b); hit++; } });
    const bGood = !!bb && aMoney.length > 0 && hit / aMoney.length >= 0.6;
    if (bGood) bUsable = true;
    const used = new Set();
    for (const a of ba.rules) {
      if (!money(a)) continue;
      total++;
      const msgs = [];
      let bestB = null;
      if (bGood) {
        const best = pickB(a, pool, used);
        if (!best) { if (!tr) msgs.push('두 번째 읽기에서는 이 항목이 나오지 않았습니다'); }
        else { bestB = best; used.add(best); const d = diffText(a, best); if (d.length) msgs.push('두 번 읽은 결과가 다릅니다 — ' + d.slice(0, 3).join(' / ')); }
      }
      applyMinFromConds(a, tr);
      // 독립적인 대조가 전혀 없어도, 항목의 숫자가 자기가 인용한 공지 문구(src_text)와 다르면 걸러냅니다
      if (a.calc === 'pct' && a.value > 0 && a.src_text) {
        const ps = []; String(a.src_text).replace(/(\d+(?:\.\d+)?)\s*%/g, (m, x) => { ps.push(parseFloat(x)); });
        if (ps.length && !ps.includes(Number(a.value))) msgs.push(`입력된 ${a.value}%가 인용한 공지 문구(${ps.join('·')}%)와 다릅니다`);
      }
      const au = auditAgainstTranscript(a, tr);
      const bAudit = bestB ? auditAgainstTranscript(bestB, tr) : { msgs: ['-'], specific: false };
      if (au.specific && !au.msgs.length) {
        msgs.length = 0; // 공지의 해당 표와 한 칸씩 일치 — 두 번째 읽기와 달라도 신뢰
      } else {
        if (au.msgs.length && a.itype === 'tier' && bestB && bestB.itype === 'tier' && Array.isArray(bestB.tiers) && !bAudit.msgs.length && (bAudit.specific || !tr)) {
          a.tiers = bestB.tiers.map(t => Object.assign({}, t)); au.msgs.length = 0; msgs.length = 0;
          msgs.push('첫 번째 읽기의 구간 금액이 공지 숫자와 달라 공지와 일치하는 두 번째 읽기 결과로 바꿨습니다');
        } else if (tr && !au.msgs.length && bestB && bAudit.msgs.length) {
          msgs.length = 0;
        }
        au.msgs.forEach(m => msgs.push(m));
      }
      if (msgs.length) { flagged++; addNote(a, msgs.join(' · ')); } else agreed++;
    }
    const only = bGood ? pool.filter(b => !used.has(b)) : [];
    if (only.length) warnings.push(`${ba.batch.company}: 두 번째 읽기에만 나온 항목 ${only.length}건 — ${only.slice(0, 3).map(b => `${b.title.slice(0, 24)}(${b.start}~${b.end})`).join(', ')}${only.length > 3 ? ' 등' : ''}. 공지에서 빠진 시책이 없는지 확인하세요.`);
  }
  const how = [bUsable ? '두 번 읽기 비교' : null, tr ? '공지 숫자 대조' : null].filter(Boolean).join(' + ');
  if (!how && total) warnings.push('자동 대조를 하지 못했습니다(두 번째 읽기가 부실하고 숫자 옮겨 적기도 실패). 항목마다 경고를 붙이지 않았으니 공지와 직접 대조한 뒤 확정하세요.');
  const summary = how ? `교차검증(${how}): 계산 대상 ${total}건 중 ${agreed}건 일치, ${flagged}건 확인 필요` : '자동 교차검증 불가 — 공지와 직접 대조 필요';
  return { warnings, summary, total, agreed, flagged, bUsable };
}

module.exports = { validate, norm, crossCheck, parseWon };
