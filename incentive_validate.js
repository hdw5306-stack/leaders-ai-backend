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
      r.stackable = r.stackable === 0 || r.stackable === false ? 0 : 1;
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
          r.tier_bucket = r.tier_bucket === 'm13' ? 'm13' : 'next';
          if (Array.isArray(r.prereq)) r.prereq = r.prereq.filter(p => DATE.test(p.start || '') && DATE.test(p.end || ''));
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
