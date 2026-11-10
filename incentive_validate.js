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
  const m = new Map(), re = /(\d+(?:[.,]\d+)?)\s*만\s*원?\s*(?:↑|이상)\s*[:：]?\s*(\d+(?:[.,]\d+)?)\s*만(?!\s*원?\s*(?:↑|이상))/g;
  let x; const n = v => Math.round(parseFloat(String(v).replace(/,/g, '')) * 10000);
  while ((x = re.exec(String(t || '')))) m.set(n(x[1]), n(x[2]));
  return m;
}
// 표의 칸 구분이 사라져 숫자만 한 줄로 옮겨진 경우 — "구간 n개 뒤에 금액 n개"(위·아래 두 줄 표) 또는 "구간 금액 구간 금액…"(한 줄 표) 순서가
// 구간표와 그대로 일치하는지 봅니다. 값이 겹쳐도(20만이 구간이자 금액) 순서로 판단하므로 짝 사전보다 정확합니다.
function sequenceConfirms(tiers, text) {
  const own = (tiers || []).filter(t => !t.prev); const n = own.length; if (n < 2) return false;
  const nums = []; String(text || '').replace(/(\d+(?:[.,]\d+)?)\s*만(?!\s*원?\s*(?:↑|이상))?/g, (m, x) => { nums.push(Math.round(parseFloat(x.replace(/,/g, '')) * 10000)); });
  for (let st = 0; st < nums.length; st++) {
    if (st + 2 * n <= nums.length && own.every((t, i) => nums[st + i] === t.min && nums[st + n + i] === t.pay)) return true;
    if (st + 2 * n <= nums.length && own.every((t, i) => nums[st + 2 * i] === t.min && nums[st + 2 * i + 1] === t.pay)) return true;
  }
  return false;
}
// "510% (익월 160 + 13회 350)"처럼 % 기호 없이 익월·13회 뒤에 적힌 지급률도 공지의 숫자로 인정합니다
function pctWords(t) {
  const out = [], re = /(?:익월|13\s*(?:회차?|차월)|15\s*차월|1차년|2차년)\s*[:：]?\s*(\d+(?:\.\d+)?)(?!\s*(?:년|회|개|월|일|만))/g; let x;
  while ((x = re.exec(String(t || '')))) out.push(parseFloat(x[1]));
  return out;
}
// 공통기준에 적힌 "건당 20만원 한도" 같은 인정 한도(원)를 모읍니다.
function capsFromText(t) {
  const set = new Set(), re = /건당\s*P?\s*(?:최대\s*)?(\d+(?:[.,]\d+)?)\s*만\s*원?\s*(?:초과|이상)?[^.\n]{0,12}?(?:한도|限|인정|까지)/g;
  let x; while ((x = re.exec(String(t || '')))) set.add(Math.round(parseFloat(x[1].replace(/,/g, '')) * 10000));
  // "월납P 25만원 이상건은 25만원으로 인정", "월납p 10만 이상건은 10만원까지만 인정", "월납p 최대 100만원까지 인정" 같은 표기도 한도로 봅니다
  const re2 = /(\d+(?:[.,]\d+)?)\s*만\s*원?\s*이상\s*건?은?\s*(\d+(?:[.,]\d+)?)\s*만\s*원?\s*(?:으로|까지)/g;
  while ((x = re2.exec(String(t || '')))) set.add(Math.round(parseFloat(x[2].replace(/,/g, '')) * 10000));
  const re3 = /(?:월납\s*[pP]?|보험료)\s*최대\s*(\d+(?:[.,]\d+)?)\s*만\s*원?\s*까지/g;
  while ((x = re3.exec(String(t || '')))) set.add(Math.round(parseFloat(x[1].replace(/,/g, '')) * 10000));
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

const STD_CATS = ['상해(운전자)', '건강(의료)', '어린이', '유병자', '연금·저축', '화재·재물', '펫', '치아', '간병', '실손', '단체', '단체(1년)'];
const TAG_ALIAS = { '재물&단체': '화재·재물,단체', '재물·단체': '화재·재물,단체', '재물 & 단체': '화재·재물,단체', '재물/단체': '화재·재물,단체', '재물,단체': '화재·재물,단체', '단독실손': '실손', '실손보험': '실손', '단체보험': '단체', '1년단체': '단체(1년)', '1년 단체': '단체(1년)', '단체 1년': '단체(1년)', '단체(1년만기)': '단체(1년)', '단체 1년만기': '단체(1년)' };
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
    // 다른 시상(다건 시상·보너스·출시기념·특별시상 등)에 딸린 최소 보험료 문구는 그 시상의 이름이 시책 제목에 있을 때만 적용합니다
    const SEC = /다건|보너스|특약\s*활성|출시\s*기념|특별\s*시상|전략|기관장/;
    if (SEC.test(c) && !SEC.test(rt)) continue;
    // "보험료 3만원 이상 건에 한함"처럼 표 머리글이 아닌 문장형 조건은, 문장 안에 이 시책의 상품명(제목의 낱말)이 실제로 있을 때만 적용합니다
    // ("건강" 같은 넓은 낱말만 겹쳐서 다른 상품에 붙는 것을 막습니다)
    const mm = MINP_RE.exec(c);
    if (mm && mm[3] != null) {
      const words = String(r.title || '').split(/[\s,·]+/).filter(w => w.length >= 4 && !/^\d/.test(w) && !/(년납|익월|13회차|시상|시책)$/.test(w));
      if (!words.some(w => c.includes(w))) continue;
    }
    if (!keys.length && simil(r.title, c) < 0.2) continue;
    if (c.includes('추가') && !rt.includes('추가')) continue;
    if (c.includes('기본') && !c.includes('추가') && !rt.includes('기본')) continue;
    r.min_premium = mp; if (r.cap_premium && Number(r.cap_premium) === mp) delete r.cap_premium; r.title = norm(String(r.title || '').replace(/(\d+)\s*만\s*↑?\s*건\s*(?:한도|限)/, '건당 $1만원 이상')); r.memo = norm(((r.memo ? r.memo + ' · ' : '') + `건당 ${mp.toLocaleString('ko-KR')}원 이상 건만 인정 (공지 표 머리글)`).slice(0, 500)); return;
  }
}

// ── 공통기준의 "입금보험료 30만원 이상건 30만원 한도인정" 같은 건당 인정 한도를 해당 범위(인보험)에만 적용 ──
function applyScopedCaps(rules, trText, company, warnings) {
  const s = String(trText || '');
  const m = /입금\s*(?:보험료|P)\s*(\d+(?:\.\d+)?)\s*만\s*원?\s*이상\s*건?\s*(\d+(?:\.\d+)?)\s*만\s*원?\s*한도/.exec(s);
  if (!m) return;
  const cap = Math.round(parseFloat(m[2]) * 1e4);
  const noGroup = /단체\s*보험\s*은\s*한도\s*미적용/.test(s);
  let n = 0;
  rules.forEach(r => {
    if (r.itype === 'note' || r.itype === 'goods' || r.cap_premium) return;
    const nt = (r.not_tags || []).join(',') + ' ' + (r.title || '');
    const tag = String(r.tag || '');
    if (noGroup && (/단체/.test(tag) || /단체/.test(r.title || ''))) return;   // 단체보험은 한도 미적용
    if (/펫|재물|화재/.test(tag) || /펫보험|재물보험/.test(r.title || '')) return;   // 인보험 한도이므로 펫·재물은 제외
    r.cap_premium = cap; n++;
  });
  if (n) {
    const ex = /온가족든든[^.。\n]{0,40}(\d+)\s*만|치아[^.。\n]{0,20}(\d+)\s*만|운전자[^.。\n]{0,30}(\d+)\s*만/.test(s);
    warnings.push(`${company}: 공지의 ‘입금보험료 ${m[1]}만원 이상 건 ${m[2]}만원 한도’를 인보험 시책 ${n}건에 적용했습니다.` + (ex ? ' 다만 온가족든든·치아·운전자보험은 더 낮은 한도(공지 참조)가 따로 있어 자동 반영되지 않습니다 — 해당 상품 계약은 보험료를 그 한도로 입력해 보세요.' : ''));
  }
}

// AI가 "수수료표에서 대응 상품을 찾지 못함"으로 안내(note)로 내린 시책 중, 제목이 "상품 / 납입기간 / 익월·13차월 N%" 꼴로 단순한 것은
// 프로그램이 상품 이름과 납입기간으로 직접 라벨을 찾아 연결합니다(이름이 긴 보험사 대비). 모든 상품 이름이 라벨에서 확인될 때만 연결합니다.
const sqLow = x => squash(x).toLowerCase().replace(/[()\[\]·,.\-_]/g, '');
function periodBucket(label) {
  const t = squash(label);
  let m = t.match(/(\d+)년이상(\d+)년미만납?/); if (m) return { lo: +m[1], hi: +m[2] - 1 };
  m = t.match(/(\d+)년이상납?/); if (m) return { lo: +m[1], hi: 99 };
  m = t.match(/(\d+)-(\d+)년(?!납)/); if (m) return { lo: +m[1], hi: +m[2] };
  m = t.match(/(\d+)년초과/); if (m) return { lo: +m[1] + 1, hi: 99 };
  m = t.match(/(\d+)년납/); if (m) return m[0].includes('초과') ? { lo: +m[1] + 1, hi: 99 } : { lo: +m[1], hi: +m[1] };
  m = t.match(/(\d+)년$/); if (m) return { lo: +m[1], hi: +m[1] };
  return null;
}
function rescueTargets(r, labels) {
  const title = norm(r.title);
  const m = title.match(/^(.+?)\s+((?:납기\s*무관|\d+\s*년\s*납?)(?:\s*[·,/]\s*\d+\s*년\s*납?)*(?:\s*(?:이상|미만|이하|초과))?)\s+(익월|익익월|\d+\s*차월|\d+\s*회|\d+\s*차년도)\s+(\d+(?:\.\d+)?)\s*%$/);
  if (!m) return null;
  const prodPart = m[1], per = m[2], when = m[3], pct = Number(m[4]);
  const toks = prodPart.split(/[\/·,]/).map(x => sqLow(x)).filter(x => x.length >= 2);
  if (!toks.length) return null;
  const families = new Map();
  labels.forEach(l => { const name = sqLow(String(l).replace(/\s{2,}.*$/, '')); families.set(l, name); });
  // '간편가입 X'는 수수료표에 'X … 간편심사형'(또는 '간편가입 X')으로 적힌 같은 상품입니다. 간편 표기가 없으면 간편 상품은 뺍니다.
  const hitsByTok = toks.map(t => {
    const simple = t.startsWith('간편가입'), core = simple ? t.slice(4) : t;
    const pick = (match) => labels.filter(l => { const sq = squash(l); if (!match(families.get(l))) return false; const isSimple = /간편가입|간편심사/.test(sq); return simple ? isSimple : !isSimple; });
    const exact = pick(f => f.includes(core));
    if (exact.length) return exact;
    // 영문 한 글자 차이(예: 공지 '경영인정기' ↔ 라벨 '경영인H정기보험')는 영문을 뺀 이름으로 한 번 더 찾습니다
    const core2 = core.replace(/[a-z]/g, '');
    return core2.length >= 3 ? pick(f => f.replace(/[a-z]/g, '').includes(core2)) : [];
  });
  if (hitsByTok.some(h => !h.length)) return null;
  let picked = [].concat(...hitsByTok);
  picked = picked.filter((l, i) => picked.indexOf(l) === i);
  const free = /납기\s*무관/.test(per);
  let ok = picked;
  if (!free) {
    const nums = (per.match(/\d+/g) || []).map(Number);
    const cmp = /이상/.test(per) ? 'ge' : /미만/.test(per) ? 'lt' : /이하/.test(per) ? 'le' : /초과/.test(per) ? 'gt' : 'eq';
    ok = picked.filter(l => {
      const b = periodBucket(l); if (!b) return false;
      const n = nums[0];
      if (cmp === 'ge') return b.lo >= n;
      if (cmp === 'gt') return b.lo > n;
      if (cmp === 'lt') return b.hi < n;
      if (cmp === 'le') return b.hi <= n;
      return nums.some(x => b.lo <= x && x <= b.hi);
    });
  }
  // 수수료표 라벨에 납입기간 구분이 전혀 없는 상품(전기납 등)이면 납입기간 조건은 보지 않고 상품 전체를 연결합니다
  if (!ok.length && picked.length && picked.every(l => !periodBucket(l))) ok = picked;
  if (!ok.length) return null;
  let off = when === '익월' ? 1 : when === '익익월' ? 2 : Number((when.match(/\d+/) || [1])[0]);
  if (/차년도/.test(when)) { const mm = `${r.memo || ''} ${r.src_text || ''}`.match(/(\d+)\s*회/); off = mm ? Number(mm[1]) : 13; }
  return { targets: ok, pct, off, month13: off >= 13 };
}

// "상기외 보장성 익월 80%"처럼 표에 나열되지 않은 '나머지 상품'을 뜻하는 시책: 같은 공지의 다른 시책 대상에 들어가지 않은 수수료표 상품 중
// 보장성 상품(연금·저축 제외, 공지가 '모든 프로모션에서 제외'한다고 적은 상품 제외)을 프로그램이 직접 골라 연결합니다.
const REST_RE = /상기\s*외|표\s*(?:에\s*)?(?:열거|나열|적힌|기재)된?\s*(?:상품|보험)?\s*외|열거되지\s*않은|그\s*외\s*보장성/;
function excludedNamesFromNotes(rules) {
  const names = [];
  rules.forEach(r => {
    const t = String(r.src_text || '') + ' ' + String(r.memo || '');
    const re = /([^□■※\n.]{2,200}?)(?:은|는)\s*(?:[가-힣\s]{0,12})?(?:모든\s*(?:프로모션|시책)(?:에서)?|전\s*시책(?:에서)?)\s*(?:산출\s*)?제외/g; let m;
    while ((m = re.exec(t))) m[1].split(/[,，、·\/]/).forEach(x => { const n = x.replace(/\([^)]*\)/g, '').replace(/\s+/g, '').replace(/(?:등|및)$/, ''); if (n.length >= 3) names.push(sqLow(n)); });
  });
  return Array.from(new Set(names));
}
// ── 공지에 나열된 상품 이름(예: "상품 : 오튼튼 / 3.10.5.5 / 3.8.5.5 …")이 수수료표에 있는데도 연결되지 않은 경우, 이름으로 직접 찾아 연결합니다
const PREFER_SUBSTR = { '흥국생명': '간편' }; // 같은 이름의 상품이 '간편'과 일반으로 둘 다 있으면 '간편'만 (본사 확인)
const GENERIC_NAME_RE = /^(?:종신|건강|암|상해|보험|전상품|전체|해당|해당상품|상품|신상품|정기|치매|간병|종신보험|건강보험)$/;
function listedProducts(r) {
  const t = String(r.src_text || '');
  const m = /상품\s*[:：]\s*(.+)$/.exec(t);
  if (!m) return [];
  const out = [];
  m[1].split(/\s*[\/,，、]\s*/).forEach(x => {
    x = norm(x).replace(/\s+(?:\d|현금|\(?\d).*$/, '').replace(/^[\s\-–*·]+|[\s\-–*·]+$/g, '');
    if (/^(?:현금|시상|지급|[\d,]+\s*(?:만|원|%))/.test(x)) return;
    if (squash(x).length >= 3 && !GENERIC_NAME_RE.test(squash(x))) out.push(x);
  });
  return out;
}
// 수수료표 상품명에 'N'이 숫자 자리 표시로 들어간 경우(예: 3.N.5.N플러스간편건강보험)는 3.8.5.5·3.6.5.1처럼 N 자리에 숫자가 들어간 이름과 같은 상품으로 봅니다
function nameMatches(label, tok) {
  const pl = x => sqLow(x).replace(/플러스/g, 'plus');   // 'Plus'와 '플러스'는 같은 표기
  if (pl(label).includes(pl(tok))) return true;
  const m = /^((?:\d+|N)(?:\.(?:\d+|N))+)/.exec(String(label).trim().split(/\s+/)[0]);
  if (!m || !/N/.test(m[1])) return false;
  const re = new RegExp('^' + m[1].split('.').map(x => (x === 'N' ? '\\d+' : x)).join('\\.') + '$');
  return re.test(String(tok).replace(/\s+/g, ''));
}
function linkNamedProducts(rules, labels, company, warnings) {
  if (!labels || !labels.length) return;
  const UN_RE = /연결되지 않|대응 상품을 찾지 못|대상 상품을 수수료표에서 찾지 못|대응하는 .*라벨이 없/;
  const prefer = PREFER_SUBSTR[company];
  const covers = (targets, tok) => (targets || []).some(l => nameMatches(l, tok));
  const sources = rules.filter(r => r.itype !== 'note' && r.itype !== 'goods' && Array.isArray(r.targets) && r.targets.length && listedProducts(r).length >= 2);
  sources.forEach(S => {
    const toks = listedProducts(S);
    const linked = [];
    const before = toks.map(t => covers(S.targets, t));
    toks.forEach(tok => {
      if (covers(S.targets, tok)) return;
      let found = labels.filter(l => nameMatches(l, tok));
      if (prefer && found.some(l => l.includes(prefer)) && found.some(l => !l.includes(prefer))) found = found.filter(l => l.includes(prefer));
      found = found.filter(l => !S.targets.includes(l));
      if (!found.length || found.length > 8) return;
      S.targets = S.targets.concat(found); linked.push(`${tok}(${found.length}개)`);
    });
    linked.length = 0; toks.forEach((t, k) => { if (!before[k] && covers(S.targets, t)) linked.push(t); });
    const left = toks.filter(t => !covers(S.targets, t));
    // [근본 원칙] "상품을 찾지 못함/연결되지 않음/누락" 같은 연결 상태 문장은 AI가 아니라 확정된 연결 결과로 다시 씁니다.
    // 공지에 상품 이름이 나열된 시책은 연결 여부를 프로그램이 직접 확인할 수 있으므로, AI의 연결 관련 문장은 모두 지우고 사실대로 다시 적습니다.
    const CLAIM = /찾지 못|대응|연결|라벨|누락|없어|없음|별도 안내/;
    let touched = false;
    if (S.review_note) {
      const segs = String(S.review_note).split(/\s+·\s+/);
      const keep = segs.filter(x => !(CLAIM.test(x) && toks.some(t => x.includes(t))) && !/대응하는 .*라벨이 없|누락될 수/.test(x));
      if (keep.length !== segs.length) touched = true;
      S.review_note = keep.join(' · ') || undefined;
    }
    if (S.memo) {
      const ss = String(S.memo).split(/(?<=[.。])\s+/);
      const keepM = ss.filter(x => !(CLAIM.test(x) && (toks.some(t => x.includes(t)) || /연결 가능한|나머지 상품은 별도 안내|연결하지 못|찾지 못/.test(x))));
      if (keepM.length !== ss.length) touched = true;
      S.memo = keepM.join(' ');
    }
    if (left.length && (touched || linked.length)) {
      S.review_note = [S.review_note, `확인 필요 — 공지 상품 ${left.join('·')}에 대응하는 수수료표 상품이 없어 해당 상품 실적이 합계에서 빠집니다`].filter(Boolean).join(' · ');
    }
    if (linked.length) {
      S.memo = norm(((S.memo ? S.memo + ' · ' : '') + `공지에 적힌 상품 이름 ${linked.join(', ')}을(를) 수수료표에서 이름으로 찾아 연결했습니다`).slice(0, 500));
      warnings.push(`${company}: '${String(S.title).slice(0, 24)}' — 공지 상품 ${linked.join(', ')}을(를) 수수료표 이름으로 연결했습니다(대상 상품 목록 확인)`);
    } else if (S.memo !== undefined) S.memo = norm(S.memo).slice(0, 500);
    // 같은 상품 목록을 안내(note)로 따로 적어 둔 "미연결 상품" 카드도 확정된 연결 결과에 맞춥니다
    for (let i = rules.length - 1; i >= 0; i--) {
      const N = rules[i];
      if (N.itype !== 'note' || N === S) continue;
      const nt = listedProducts(N);
      if (nt.length < 2 || !UN_RE.test(`${N.review_note || ''} ${N.title || ''} ${N.memo || ''}`)) continue;
      if (!nt.every(t => toks.includes(t))) continue;
      if (nt.every(t => covers(S.targets, t))) rules.splice(i, 1);
      else {
        const lf = nt.filter(t => !covers(S.targets, t));
        N.memo = norm(`${lf.join('·')}은(는) 수수료표에 대응 상품이 없어 연결하지 못했습니다. 나머지 상품은 수수료표 이름으로 연결했습니다`).slice(0, 500);
      }
    }
  });
}
// ── 한 구간표(월초 합계 구간 시상)에 인정 비율이 다른 상품(표준형 월초 50% 등)이 섞여 규칙이 둘로 나뉘면, 하나의 구간표로 합쳐
//    "표준형은 월초 50%만 더해서 한 번만 판정"하도록 합니다(나뉜 채로 두면 구간 시상이 두 번 지급되고 합계 판정도 틀립니다)
function mergeTierFactors(rules, company, warnings) {
  const f = r => Number(r.premium_factor) || 1;
  const sig = r => JSON.stringify([r.start, r.end, r.pay_offset || 0, r.tier_bucket || '', (r.tiers || []).map(t => [t.min, t.pay, t.prev || 0]), r.cap_premium || 0, r.min_premium || 0, r.max_premium || 0, r.tag || '', r.prereq || null]);
  let merged = 0;
  for (let i = 0; i < rules.length; i++) {
    const a = rules[i];
    if (a.itype !== 'tier' || !Array.isArray(a.targets) || !a.targets.length || !Array.isArray(a.tiers) || !a.tiers.length || a.sub_factor) continue;
    for (let j = i + 1; j < rules.length; j++) {
      const b = rules[j];
      if (b.itype !== 'tier' || !Array.isArray(b.targets) || !b.targets.length || b.sub_factor) continue;
      if (sig(a) !== sig(b) || f(a) === f(b)) continue;
      if (b.targets.some(t => a.targets.includes(t))) continue;
      const main = f(a) > f(b) ? a : b, sub = main === a ? b : a;
      main.sub_factor = { factor: f(sub), targets: sub.targets.slice() };
      main.targets = main.targets.concat(sub.targets);
      main.title = norm(String(main.title || '').replace(/\s*[—\-–]\s*표준형(?:\s*외)?\s*$/, '')).slice(0, 200);
      const keep = x => x ? (String(x).split(/\s+·\s+/).filter(y => !/나누어 기재|중복 방지|동일 가동|인정 비율|겹쳐 합산/.test(y)).join(' · ') || undefined) : undefined;
      main.review_note = keep(main.review_note);
      main.memo = norm(((main.memo ? main.memo + ' · ' : '') + `표준형 등 ${sub.targets.length}개 상품은 월초의 ${Math.round(f(sub) * 100)}%만 합산하여 한 번에 구간을 판정합니다`).slice(0, 500));
      rules.splice(rules.indexOf(sub), 1);
      merged++;
      if (sub === a) { i = -1; }
      break;
    }
  }
  if (merged) warnings.push(`${company}: 인정 비율이 다른 상품(표준형 50% 등)으로 나뉜 구간 시상 ${merged}건을 하나로 합쳤습니다 — 표준형은 월초의 50% 등 상품별 비율만 합산해 구간을 한 번만 판정합니다`);
  return merged;
}
// ── 일반 시책(익월·13회차 등)에서 표준형(월초 50% 인정) 상품이 한 규칙에 같이 들어오면, 표준형 상품만 따로 떼어 월초×50% 규칙으로 나눕니다
//    (나누지 않으면 표준형 실적이 100%로 계산되어 시책이 과하게 예측됩니다)
const STD50_RE = /표준형[^\n]{0,40}(?:월초|보험료)?[^\n]{0,12}50\s*%|표준형[^\n]{0,30}(?:월초|보험료)\s*[×x*]\s*0?\.?5\b/;
function splitStandardRules(rules, company, warnings) {
  const kinds = new Set(['monthly', 'month13', 'weekly', 'joiner']);
  let n = 0, amb = new Set();
  for (let i = 0; i < rules.length; i++) {
    const r = rules[i];
    if (!kinds.has(r.itype) || !Array.isArray(r.targets) || !r.targets.length) continue;
    if ((Number(r.premium_factor) || 1) !== 1) continue;
    if (!STD50_RE.test(`${r.title || ''} ${r.memo || ''} ${r.review_note || ''}`)) continue;
    const isAmb = l => /다재다능/.test(l) && /표준형/.test(l);
    const std = r.targets.filter(l => /표준형/.test(l) && !isAmb(l));
    const rest = r.targets.filter(l => !/표준형/.test(l));
    r.targets.filter(isAmb).forEach(l => amb.add(l));
    if (!std.length || !rest.length) { if (r.targets.some(isAmb)) r.targets = r.targets.filter(l => !isAmb(l)); continue; }
    const base = String(r.title || '').replace(/\s*[—\-–]\s*표준형(?:\s*외)?\s*$/, '');
    const half = Object.assign({}, r, { title: norm(base + ' — 표준형').slice(0, 200), targets: std, premium_factor: 0.5 });
    half.memo = norm(`표준형은 월초의 50%를 ${r.itype === 'month13' ? '13회차' : '시상'} 실적으로 인정합니다`).slice(0, 500);
    r.title = norm(base + ' — 표준형 외').slice(0, 200);
    r.targets = rest;
    rules.splice(i + 1, 0, half);
    i++; n++;
  }
  if (n) warnings.push(`${company}: 표준형 상품은 월초의 50%만 인정하는 시책 ${n}건을 '표준형 외'와 '표준형(월초×0.5)' 규칙으로 나누었습니다.`);
  if (amb.size) warnings.push(`${company}: '해약환급금 미지급형 표준형' 라벨이 함께 적힌 다재다능 계열 ${amb.size}개 상품은 표준형 50% 인정 여부를 구분할 수 없어 계산에서 뺐습니다 — 본사 확인 필요`);
}
function applyRestOfProducts(rules, labels, company, warnings) {
  if (!labels || !labels.length) return;
  rules.forEach(r => {
    if (r.itype !== 'note' || (Array.isArray(r.targets) && r.targets.length)) return;
    if (!REST_RE.test(`${r.title || ''} ${r.src_text || ''}`)) return;
    const pm = /(\d+(?:\.\d+)?)\s*%/.exec(`${r.title || ''}`) || /(\d+(?:\.\d+)?)\s*%/.exec(String(r.src_text || ''));
    if (!pm) return;
    const covered = new Set();
    rules.forEach(x => { if (x !== r && x.itype !== 'note' && x.itype !== 'goods' && Array.isArray(x.targets)) x.targets.forEach(t => covered.add(t)); });
    const excl = excludedNamesFromNotes(rules);
    const rest = labels.filter(l => {
      if (covered.has(l)) return false;
      // 보장성 상품만: 저축·연금·투자·적립·교육 성격은 빼고, 보장(종신·정기·건강·암·치매·간병·상해·질병·통합 등) 성격의 이름이 있는 상품만 남깁니다
      if (/연금|저축|펀드|변액|적립|교육|학자금|양로|목돈|이자|금리연동|유니버셜/.test(l)) return false;
      if (!/종신|정기|건강|암|치매|간병|질병|상해|통합|보장|치아|어린이|유병자|사망|CI|입원|수술|재해/i.test(l)) return false;
      const f = sqLow(String(l).replace(/\([^)]*\)/g, '').replace(/\s{2,}.*$/, '')), g = sqLow(String(l).replace(/\([^)]*\)/g, ''));
      return !excl.some(e => f.includes(e) || g.includes(e));
    });
    if (!rest.length) {
      r.review_note = undefined;
      addNote(r, `나머지 보장성 상품을 수수료표에서 찾아 보았으나, 다른 시책에 이미 들어갔거나 제외 상품이어서 남은 상품이 없습니다(수수료표 상품 ${labels.length}개 중 다른 시책 대상 ${covered.size}개) — 계산할 상품 없음`);
      return;
    }
    r.itype = 'monthly'; r.calc = 'pct'; r.value = Number(pm[1]); r.pay_offset = /익익월/.test(`${r.title}${r.src_text}`) ? 2 : 1;
    r.targets = rest; r.review_note = undefined;
    addNote(r, `공지에 나열되지 않은 나머지 보장성 상품으로, 프로그램이 수수료표에서 ${rest.length}개 라벨을 골라 연결했습니다(다른 시책 대상·연금저축·공지의 제외 상품 뺌) — '대상 상품' 목록을 확인해 주세요`);
    warnings.push(`${company}: '${String(r.title).slice(0, 24)}' — 나머지 보장성 상품 ${rest.length}개를 프로그램이 골라 연결했습니다(확인 필요)`);
  });
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
    if (labels && !labels.length && batch.grp === 'life') warnings.push(`${batch.company}: 수수료표에서 받은 상품 목록이 0개입니다 — 상품 연결을 할 수 없습니다(수수료표의 '보험상품' 범위 확인).`);
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
        if (po > 48) po = 48; // 2·3차년도 시상(예: 18회차·28회차 유지 후 지급)은 16차월을 넘습니다
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
              if (fixedN) { r.memo = norm(((r.memo ? r.memo + ' · ' : '') + `금액 ${fixedN}건을 공지 원문 숫자에 맞춰 바로잡음`).slice(0, 500)); warnings.push(`${batch.company} · ${r.title}: 금액 ${fixedN}건을 원문 기준으로 정정`); }
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
            // 공지에 행마다 두 기간의 기준이 따로 적혀 있으면("50만↑ 50만↑ 300만, 40만↑ 40만↑ 200만") 합쳐진 칸이 아니라고 확실하므로 경고하지 않습니다
            const rowPairs = (String(r.src_text || '').match(/(\d+(?:\.\d+)?)\s*만\s*원?\s*↑\s*[,/·\s]?\s*\1\s*만\s*원?\s*↑/g) || []).length;
            const explicitRows = withPrev.every(t => t.min === t.prev) && rowPairs >= withPrev.length;
            if (samePairs && !explicitRows) addNote(r, '연속가동 짝 확인: 두 번째 기간 기준이 구간마다 똑같은 구간인지, 합쳐진 한 칸(모든 구간 공통 기준)인지 공지 표에서 확인 필요');
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
      // AI가 대응 상품을 못 찾았다고 내린 단순 시책은 프로그램이 이름·납입기간으로 다시 연결해 봅니다
      if (r.itype === 'note' && batch.grp === 'life' && labels && labels.length && !(Array.isArray(r.targets) && r.targets.length) && /대응 상품을 찾지 못함|대상 상품을 수수료표에서 찾지 못/.test(String(r.review_note || ''))) {
        const rs = rescueTargets(r, labels);
        if (rs) {
          r.itype = rs.month13 ? 'month13' : 'monthly'; r.calc = 'pct'; r.value = rs.pct;
          r.pay_offset = rs.month13 ? (rs.off !== 13 ? rs.off : (/15\s*(?:차월|회)/.test(`${r.memo || ''} ${r.src_text || ''}`) ? 15 : 13)) : rs.off;
          r.targets = rs.targets;
          r.review_note = undefined;
          addNote(r, `AI가 상품을 연결하지 못해 프로그램이 상품 이름·납입기간으로 ${rs.targets.length}개 라벨을 연결했습니다 — '대상 상품' 목록을 원본과 대조해 주세요`);
          warnings.push(`${batch.company} · ${r.title}: 프로그램이 상품 ${rs.targets.length}개를 이름으로 연결했습니다(대조 필요)`);
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
        const list = [...caps].sort((a, b) => b - a).map(c => `${c / 10000}만원`).join('·');
        rules.filter(r => r.itype === 'note').forEach(r => { if (capsFromText(`${r.title} ${r.src_text || ''} ${r.memo || ''}`).size) r.memo = norm(((r.memo ? r.memo + ' · ' : '') + `건당 인정 한도가 상품별로 여러 가지입니다(${list})`).slice(0, 500)); });
        warnings.push(`${batch.company}: 건당 인정 한도가 여러 가지(${list})입니다. 시책에 이미 들어간 한도 외에 상품별로 다른 한도(예: 운전자보험 10만원)는 자동 반영되지 않으니 공지와 확인하세요.`);
      }
    }
    // 건당 보험료 구간 사다리(20만↑ 160% / 10만↑ 80%)에서 AI가 낮은 구간 행을 '겹친다'며 안내로 돌린 경우, 계산 시책으로 되돌립니다(아래 사다리 변환이 합산을 바로잡습니다)
    {
      const ladderMin = r => { const m = /건당\s*(\d+(?:\.\d+)?)\s*만\s*원?\s*(?:이상|↑)/.exec(`${r.title || ''} ${r.src_text || ''}`); return m ? Math.round(parseFloat(m[1]) * 10000) : null; };
      rules.filter(n => n.itype === 'note' && Array.isArray(n.targets) && n.targets.length && /겹치|중복|이중|제외/.test(`${n.review_note || ''} ${n.memo || ''}`)).forEach(n => {
        const nm = ladderMin(n); const pm = /(\d+(?:\.\d+)?)\s*%/.exec(`${n.src_text || ''} ${n.title || ''}`);
        if (!nm || !pm) return;
        const sib = rules.find(r => r !== n && ['monthly', 'month13'].includes(r.itype) && r.min_premium && r.min_premium > nm && r.calc === 'pct' && Array.isArray(r.targets) && r.targets.length === n.targets.length && n.targets.every(t => r.targets.includes(t)) && (r.pay_offset || 0) === (n.pay_offset || r.pay_offset || 0));
        if (!sib) return;
        n.itype = sib.itype; n.calc = 'pct'; n.value = parseFloat(pm[1]); n.min_premium = nm; n.pay_offset = sib.pay_offset; n.start = sib.start; n.end = sib.end;
        n.review_note = ''; n.memo = norm(`건당 ${nm / 10000}만원 이상 구간 시책(건당 ${sib.min_premium / 10000}만원 이상은 ${sib.value}% 하나만 적용)`);
        warnings.push(`${batch.company}: 건당 보험료 구간 시책 「${String(n.title).slice(0, 30)}」을 안내에서 계산 시책으로 되돌렸습니다.`);
      });
    }
    if (batch.grp === 'life') applyRestOfProducts(rules, labels, batch.company, warnings);
    if (batch.grp === 'life') { linkNamedProducts(rules, labels, batch.company, warnings); splitStandardRules(rules, batch.company, warnings); mergeTierFactors(rules, batch.company, warnings); }
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
        // "20만↑ 160%, 10만↑ 80%"처럼 건당 보험료 구간별로 높은 구간 하나만 적용되는 사다리 표기: 같은 상품에 두 시책이 겹치면
        // 높은 구간 시책의 지급률을 차액(상위-하위)으로 바꿔 합산해도 상위 지급률 하나가 되게 합니다
        if (a.min_premium && b.min_premium && a.min_premium !== b.min_premium && a.calc === 'pct' && b.calc === 'pct' && shared === a.targets.length && shared === b.targets.length) {
          const hi = a.min_premium > b.min_premium ? a : b, lo = hi === a ? b : a;
          if (Number(hi.value) > Number(lo.value) && !lo.max_premium) {
            // 높은 구간(예: 20만원↑ 160%)이 따로 있으면 낮은 구간(10만원↑ 80%)은 그 구간 '미만'에만 적용합니다 → 두 시책이 겹치지 않고, 카드에는 원본 그대로 160%·80%로 보입니다
            lo.max_premium = hi.min_premium;
            lo.title = norm(String(lo.title || '').replace(/건당\s*(\d+(?:\.\d+)?)\s*만\s*원?\s*이상/, `건당 $1만원 이상 ${hi.min_premium / 10000}만원 미만`)).slice(0, 120);
            lo.memo = norm(((lo.memo ? lo.memo + ' · ' : '') + `건당 ${hi.min_premium / 10000}만원 이상은 ${Number(hi.value)}% 시책이 적용되므로 이 시책은 ${hi.min_premium / 10000}만원 미만에만 적용`).slice(0, 500));
            if (lo.review_note) lo.review_note = lo.review_note.split(/\s+·\s+/).filter(x => !/겹쳐 합산/.test(x)).join(' · ');
            if (hi.review_note) hi.review_note = hi.review_note.split(/\s+·\s+/).filter(x => !/겹쳐 합산/.test(x)).join(' · ');
            warnings.push(`${batch.company}: 건당 보험료 구간 시책은 ${lo.min_premium / 10000}만원 이상 ${hi.min_premium / 10000}만원 미만 ${Number(lo.value)}%, ${hi.min_premium / 10000}만원 이상 ${Number(hi.value)}%로 나누어 적용합니다.`);
            continue;
          }
        }
        // 한쪽에만 건당 최소 보험료가 있는 사다리(예: 5·7년납 400% / 5년납 건당 150만원↑ 450%): 높은 쪽 상품은 낮은 시책을 '미만'으로 한정하고,
        // 낮은 시책에만 있는 상품(7년납)은 그대로 둡니다 → 어느 계약도 두 시책이 겹쳐 합산되지 않습니다.
        if (a.calc === 'pct' && b.calc === 'pct' && !!a.min_premium !== !!b.min_premium) {
          const hi = a.min_premium ? a : b, lo = hi === a ? b : a;
          const inLo = new Set(lo.targets);
          if (Number(hi.value) > Number(lo.value) && !lo.max_premium && hi.targets.every(t => inLo.has(t))) {
            const hiSet = new Set(hi.targets), mp = hi.min_premium, mpTxt = `${mp / 10000}만원`;
            const note = `건당 ${mpTxt} 이상은 「${String(hi.title).slice(0, 24)}」 ${Number(hi.value)}%가 적용되므로 이 시책은 ${mpTxt} 미만에만 적용`;
            const rest = lo.targets.filter(t => !hiSet.has(t));
            if (rest.length) {
              const part = Object.assign({}, lo, { targets: lo.targets.filter(t => hiSet.has(t)), max_premium: mp, title: norm(`${lo.title} (건당 ${mpTxt} 미만)`).slice(0, 120), memo: norm(((lo.memo ? lo.memo + ' · ' : '') + note).slice(0, 500)) });
              lo.targets = rest;
              rules.splice(rules.indexOf(lo) + 1, 0, part);
            } else {
              lo.max_premium = mp; lo.title = norm(`${lo.title} (건당 ${mpTxt} 미만)`).slice(0, 120); lo.memo = norm(((lo.memo ? lo.memo + ' · ' : '') + note).slice(0, 500));
            }
            [lo, hi].forEach(x => { if (x.review_note) x.review_note = x.review_note.split(/\s+·\s+/).filter(y => !/겹쳐 합산|중복 지급하지 않/.test(y)).join(' · ') || undefined; });
            warnings.push(`${batch.company}: 건당 보험료 구간 시책은 ${mpTxt} 미만 ${Number(lo.value)}%, ${mpTxt} 이상 ${Number(hi.value)}%로 나누어 적용합니다.`);
            continue;
          }
        }
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
function diffText(a, b, support) {
  const sa = ruleSig(a), sb = ruleSig(b), out = [];
  const sup = String(support || '') + ' ' + String(a.src_text || '') + ' ' + String(a.memo || '');
  for (const k of Object.keys(sa)) {
    if (String(sa[k]) === String(sb[k])) continue;
    // 첫 번째 읽기가 공지 문구(공통기준)에 적힌 인정 한도를 담았고 두 번째 읽기는 빠뜨린 경우 — 공지가 뒷받침하므로 문제 삼지 않음
    if (k === '한도' && a.cap_premium && !b.cap_premium && capsFromText(sup).has(Number(a.cap_premium))) continue;
    // 제외 상품군: 두 번째 읽기가 첫 번째의 일부이고, 더 많은 쪽의 나머지가 공지 문구에 적혀 있으면 문제 삼지 않음
    if (k === '제외') {
      const ta = (a.not_tags || []), tb = (b.not_tags || []);
      const tagTok = String(a.tag || '').split(/[,+]/).map(x => x.trim()).filter(Boolean);
      if (tagTok.length && [...ta, ...tb].every(t => !tagTok.includes(t) && !(t === '단체' && tagTok.includes('단체(1년)')))) continue;   // 상품군을 이미 좁게 지정했으면 다른 상품군 제외는 의미 없음
      const baseOk = t => (['실손', '연금·저축', '펫', '화재·재물', '단체(1년)', '단체'].includes(t) && /인보험|장기|보장성/.test(sup)) || (t === '상해(운전자)' && /운전자/.test(sup));
      if (tb.every(t => ta.includes(t)) && ta.filter(t => !tb.includes(t)).every(t => sup.includes(String(t).replace(/보험$/, '')) || baseOk(t))) continue;
    }
    if (k === '단위' && a.itype === 'tier' && b.itype === 'tier') continue;   // 구간표는 단위(정액/비율)가 의미 없음
    if (k === '제외' && (b.not_tags || []).length && !(a.not_tags || []).length) {   // 두 번째 읽기가 공지에 없는 제외 상품군을 붙인 경우는 문제 삼지 않음
      if ((b.not_tags || []).every(t => !sup.includes(String(t).replace(/보험$/, '').replace(/\(.*\)/, '')))) continue;
    }
    if (k === '구간' && ((a.tiers || []).some(t => t.prev) || (b.tiers || []).some(t => t.prev)) && (a.tiers || []).map(t => t.pay).join() === (b.tiers || []).map(t => t.pay).join()) continue;   // 연속가동은 앞 기간 조건 표기만 다르고 지급액이 같으면 같은 것으로 봄
    if (k === '지급시기' && offsetOk(a)) continue;
    if (k === '상품군') {
      const tk = x => String(x || '').split(/[,+]/).map(z => z.trim()).filter(Boolean);
      const ta2 = tk(a.tag), tb2 = tk(b.tag);
      if (tb2.length && tb2.every(t => ta2.includes(t)) && ta2.length > tb2.length) continue;   // 첫 번째 읽기가 추가 조건(납입기간·플랜 등)을 더 적은 경우
    }
    if (k === '상품군' && /펫|반려/.test(`${a.title || ''} ${a.src_text || ''}`) && /펫/.test(String(sa[k]))) continue;   // 반려견·반려묘 시상의 펫 조건은 공지 문구가 뒷받침
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
// 글 속에 금액이 "5만", "5만원", "50,000", "50000" 어느 모양으로든 적혀 있는지(앞뒤가 다른 숫자에 붙어 있지 않게)
function moneyIn(text, won) {
  const v = Math.round(Number(won) || 0); if (v <= 0) return false;
  const forms = [];
  if (v % 10000 === 0) forms.push(String(v / 10000) + '\\s*만');
  forms.push(v.toLocaleString('en-US').replace(/,/g, ',?'));
  return forms.some(f => new RegExp('(^|[^0-9.,])' + f + '(?![0-9])').test(String(text || '')));
}
function auditAgainstTranscript(r, tr) {
  const res = { msgs: [], specific: false };
  if (!tr) return res;
  const pairs = trPairs(tr);
  const pairSet = new Set(pairs.map(p => `${p.h}:${p.v}`)), valSet = new Set(pairs.map(p => p.v)), pctSet = new Set();
  const grabPct = t => { const re = /(\d+(?:\.\d+)?)\s*%/g; let x; while ((x = re.exec(String(t || '')))) pctSet.add(parseFloat(x[1])); pctWords(t).forEach(v => pctSet.add(v)); };
  (tr.percents || []).forEach(grabPct); grabPct(tr.text); (tr.pairs || []).forEach(p => grabPct(p.value));
  // 공지 표는 머리글에 '(%)'만 적고 칸에는 % 없이 숫자만 적는 경우가 많습니다(익월 400 / 2차년도 300).
  // 그래서 단위(원·년·회·차월 등)가 붙지 않은 표의 숫자도 모두 '공지에 있는 지급률 후보'로 인정합니다.
  // (공지에 아예 없는 숫자만 걸러내므로, AI가 숫자를 잘못 옮긴 경우는 그대로 잡힙니다)
  {
    const reB = /(?<![\d.,])(\d{2,4})(?![\d.,]|\s*(?:년|회|차|월|일|세|만|원|종|개|%))/g; let xb;
    const srcs = [String(tr.text || '')].concat((tr.pairs || []).map(p => String(p.value == null ? '' : p.value)));
    srcs.forEach(t => { reB.lastIndex = 0; while ((xb = reB.exec(t))) pctSet.add(parseInt(xb[1], 10)); });
  }
  const re2 = /(\d+(?:[.,]\d+)?)\s*만\s*원?\s*(?:↑|이상)\s*[:：]?\s*(\d+(?:[.,]\d+)?)\s*만/g; let y;
  while ((y = re2.exec(String(tr.text || '')))) { const h = Math.round(parseFloat(y[1].replace(/,/g, '')) * 1e4), v = Math.round(parseFloat(y[2].replace(/,/g, '')) * 1e4); pairSet.add(`${h}:${v}`); valSet.add(v); }
  if (r.itype === 'tier' && Array.isArray(r.tiers) && pairSet.size >= 2) {
    const spec = tableSpecific(r, pairs);
    const useSet = spec ? new Set(spec.map(p => `${p.h}:${p.v}`)) : pairSet;
    res.specific = !!spec;
    let bad = r.tiers.filter(t => !t.prev && !useSet.has(`${t.min}:${t.pay}`));
    // 표 모양과 무관한 최후 확인: 구간이 1~2개뿐인 작은 표(예: "5만 이상 시 / 지급액 10만")는 열이 밀릴 위험이 없으므로,
    // 기준 금액과 시상금 두 숫자가 모두 공지 원문에 적혀 있으면 짝이 맞는 것으로 봅니다(공지에 없는 숫자는 그대로 걸립니다).
    if (bad.length && r.tiers.filter(t => !t.prev).length <= 2) {
      const blob = [String(tr.text || '')].concat((tr.pairs || []).map(p => `${p.h == null ? '' : p.h} ${p.value == null ? '' : p.value}`)).join(' \n ');
      bad = bad.filter(t => !(moneyIn(blob, t.min) && moneyIn(blob, t.pay)));
    }
    if (bad.length && (sequenceConfirms(r.tiers, tr.text) || sequenceConfirms(r.tiers, (tr.pairs || []).map(p => `${p.h == null ? '' : p.h} ${p.value == null ? '' : p.value}`).join(' ')))) bad = [];
    // 합쳐진 칸이 있는 표는 옮겨 적기가 일부 칸을 빠뜨릴 수 있습니다. 일부 칸은 확인되고 나머지는 시책이 인용한 공지 문구(src_text)에 그대로 적혀 있으면 문제 삼지 않습니다.
    const prevTiers = r.tiers.filter(t => t.prev);
    const okCnt = prevTiers.filter(t => valSet.has(t.pay)).length;
    const inQuote = t => new RegExp(`(^|[^0-9.])${t.pay / 10000}\\s*만`).test(String(r.src_text || ''));
    const badPrev = prevTiers.filter(t => valSet.size && !valSet.has(t.pay) && !(okCnt >= 1 && inQuote(t)));
    if (bad.length) res.msgs.push(`공지 ${spec ? '해당 표' : '표'}에서 ${bad.slice(0, 2).map(t => `${won(t.min)}↑→${won(t.pay)}`).join(', ')}${bad.length > 2 ? ' 등' : ''} 짝을 찾지 못했습니다`);
    if (badPrev.length) res.msgs.push(`시상금 ${badPrev.slice(0, 2).map(t => won(t.pay)).join(', ')}이(가) 공지에서 확인되지 않습니다`);
  } else if (r.itype !== 'tier' && r.itype !== 'note' && r.itype !== 'goods') {
    if (r.calc === 'pct' && pctSet.size >= 1 && r.value > 0 && !pctSet.has(r.value)) res.msgs.push(`${r.value}%가 공지의 % 표기에서 확인되지 않습니다`);
    if (r.calc === 'fixed' && valSet.size >= 2 && r.value > 0 && !valSet.has(r.value)) res.msgs.push(`${won(r.value)}이(가) 공지에서 확인되지 않습니다`);
  }
  return res;
}
// A 읽기 결과(out)에 B 읽기 결과와 옮겨 적기 대조 결과를 반영합니다. 반환: 요약 정보

// ── 구역 제목·각주에 "250% : 엠금융 익익월 지급"처럼 % 옆에 적힌 지급 시기를 시책에 반영 ──
function applyPayTiming(rules, text, company, warnings) {
  const t = String(text || '').replace(/\s+/g, ' ');
  const money = r => r.itype !== 'note' && r.itype !== 'goods' && r.itype !== 'tier';
  // "N% … 익익월" 처럼 % 바로 뒤(같은 괄호 안, 다른 %·익월 표기가 끼지 않는 범위)에 익익월이 올 때만 그 %에 묶습니다
  const bind = str => {
    const set = new Set(); const src = String(str || '').replace(/\s+/g, ' '); let x;
    // % 뒤에 익익월이 오는 경우 — "+"·"&" 로 이어 붙인 다른 항목(예: "200% + 익익월 엠금융 250%")은 건너뛰지 않습니다
    const re = /(\d+(?:\.\d+)?)\s*%(?:(?!(?<!익)익월)[^%)/+&]){0,30}?익익월/g;
    while ((x = re.exec(src))) set.add(parseFloat(x[1]));
    // 항목 맨 앞의 "익익월 엠금융 선지원 250%" — 지급 시기가 % 앞에 적힌 경우
    const re2 = /(?:^|[+&,/·]\s*)익익월\s*[^%+&)/\d]{0,20}?(\d+(?:\.\d+)?)\s*%/g;
    while ((x = re2.exec(src))) set.add(parseFloat(x[1]));
    return set;
  };
  const pcts = bind(t);
  const fixed = [];
  const setTo2 = r => { r.pay_offset = 2; r.memo = norm(((r.memo ? r.memo + ' · ' : '') + '지급 시기: 익익월 (공지 구역 제목 표기)').slice(0, 500)); fixed.push(r.title); };
  rules.forEach(r => {
    if (!money(r) || r.pay_offset === 2 || (r.pay_offset >= 13)) return;
    const own = bind(r.src_text);
    // ① 제목에 익익월이 적혀 있거나 ② 시책이 인용한 공지 문구에서 자기 지급률(%)이 익익월에 묶여 있을 때
    // (같은 구역 제목을 인용한 다른 %의 시책까지 바꾸지 않도록 "인용문에 익익월이 있다"만으로는 바꾸지 않습니다)
    if (/익익월/.test(r.title || '') || (r.calc === 'pct' && own.has(Number(r.value)))) setTo2(r);
  });
  // ③ 공지 전체에서 "N% … 익익월"로 묶인 %와 같은 월 시책이 하나뿐이면 그것
  pcts.forEach(v => {
    const same = rules.filter(r => money(r) && r.calc === 'pct' && Number(r.value) === v && !(r.pay_offset >= 13));
    same.filter(r => r.pay_offset !== 2).forEach(r => {
      const other = same.length > 1 && !/엠금융|익익월|자체|선지급/.test(`${r.title || ''} ${r.memo || ''}`);
      if (!other) setTo2(r);
    });
  });
  if (fixed.length) warnings.push(`${company}: 공지에 ‘익익월 지급’으로 적힌 시책 ${fixed.length}건의 지급 시기를 익익월(2개월 뒤)로 맞췄습니다 — ${fixed.slice(0, 3).join(', ')}`);
}

// ── "실손(실손, 실손전환, 유병자 등)"처럼 실손의 한 종류로 적힌 유병자는 '유병자 상품군 제외'가 아닙니다 ──
function fixSilsonYubyeong(rules, text, company, warnings) {
  const t = String(text || '');
  if (!/실손[^)\n]{0,25}유병자/.test(t)) return;
  if (/유병자/.test(t.replace(/실손[^)\n]{0,25}유병자/g, ''))) return;   // 다른 곳에도 유병자가 나오면 건드리지 않음
  let n = 0;
  rules.forEach(r => {
    if (!Array.isArray(r.not_tags) || !r.not_tags.includes('유병자')) return;
    r.not_tags = r.not_tags.filter(x => x !== '유병자'); n++;
    r.memo = norm(((r.memo ? r.memo + ' · ' : '') + '공지의 "실손(…유병자 등)"은 유병자 실손을 뜻하므로 유병자 상품군은 제외하지 않음').slice(0, 500));
  });
  if (n) warnings.push(`${company}: 공지의 "실손(실손·실손전환·유병자 등)"은 유병자 실손을 뜻하므로, 시책 ${n}건에서 유병자 상품군 제외를 풀었습니다.`);
}

// ── 운전자보험은 건당 인정 한도가 다르다고 안내된 시책을 '운전자'와 '그 외'로 나눕니다 ──
function splitDriverCap(rules, text, company, warnings) {
  const t = String(text || '');
  const add = [];
  rules.forEach(r => {
    if (r.itype !== 'monthly' && r.itype !== 'month13') return;
    if (!r.cap_premium || r.tag) return;
    if (Array.isArray(r.not_tags) && r.not_tags.includes('상해(운전자)')) return;
    const own = `${r.memo || ''} ${r.review_note || ''}`;
    if (!/운전자/.test(own)) return;
    const hay = own + ' ' + t;
    const m = /운전자[^.\n]{0,40}?(\d+(?:\.\d+)?)\s*만\s*원?\s*(?:까지|한도|이상\s*건은\s*\d+\s*만\s*원)/.exec(hay) || /운전자[^.\n]{0,40}?한도[^.\n]{0,10}?(\d+(?:\.\d+)?)\s*만\s*원/.exec(hay);
    if (!m) return;
    const cap = Math.round(parseFloat(m[1]) * 10000);
    if (!cap || cap >= r.cap_premium) return;
    if (rules.some(x => x !== r && x.tag === '상해(운전자)' && x.itype === r.itype && Number(x.value) === Number(r.value) && (x.pay_offset || 0) === (r.pay_offset || 0))) return;
    const c = JSON.parse(JSON.stringify(r));
    c.title = norm(String(r.title).replace(/\s*[—-]\s*운전자\s*외\s*$/, '') + ' — 운전자'); c.tag = '상해(운전자)'; c.cap_premium = cap; c.not_tags = [];
    c.review_note = ''; c.memo = norm(`운전자보험은 건당 인정 한도 ${cap / 10000}만원으로 따로 적용`);
    r.not_tags = (Array.isArray(r.not_tags) ? r.not_tags : []).concat('상해(운전자)');
    r.title = norm(String(r.title).replace(/\s*[—-]\s*운전자\s*외\s*$/, '') + ' — 운전자 외');
    r.review_note = /운전자.*(분리|별도)/.test(r.review_note || '') ? '' : r.review_note;
    add.push(c);
  });
  if (add.length) { rules.push(...add); warnings.push(`${company}: 운전자보험은 건당 인정 한도가 달라 시책 ${add.length}건을 ‘운전자’와 ‘그 외’로 나누었습니다.`); }
}

// ── "장기인보험/인보험" 시책의 상품 범위(본사 확정 기준) ──
// 장기인보험 = 상해(운전자)·건강(의료)·어린이·유병자·치아·간병 + 3년 이상 단체보험.
// 실손(단독)·연금·저축·펫·화재·재물·1년 만기 단체보험은 장기인보험이 아니므로, 공지가 "포함"이라고 명시하지 않았다면 제외합니다.
const INS_BASE_EXCL = ['실손', '연금·저축', '펫', '화재·재물', '단체(1년)'];
function applyInsuranceScope(rules, company, warnings) {
  let n = 0;
  rules.forEach(r => {
    if (r.itype === 'note' || r.itype === 'goods') return;
    const q = `${r.title || ''} ${r.src_text || ''}`;
    if (!/인보험/.test(q)) return;
    if (/^\s*(펫|반려|재물|단체|적립|화재)/.test(r.title || '') || /(펫보험|반려견|반려묘|재물보험|단체보험|적립보험료)\s*(기본|추가)?\s*시상/.test(r.title || '')) return;
    const inc = t => new RegExp(String(t).replace(/\(.*\)/, '').replace(/·/g, '.?') + '[^,.;/\\n]{0,8}포함').test(q);
    const base = INS_BASE_EXCL.filter(t => !inc(t));
    const tagList = String(r.tag || '').split(',').map(x => x.trim()).filter(Boolean);
    const changed = [];
    if (tagList.length) {
      const keep = tagList.filter(t => !(base.includes(t) && t !== '단체(1년)'));
      if (keep.length && keep.length !== tagList.length) { r.tag = keep.join(','); changed.push(...tagList.filter(t => !keep.includes(t))); }
    } else {
      const cur = Array.isArray(r.not_tags) ? r.not_tags.slice() : [];
      const add = base.filter(t => !cur.includes(t));
      if (add.length) { r.not_tags = cur.concat(add); changed.push(...add); }
    }
    if (changed.length) { n++; r.memo = norm(((r.memo ? r.memo + ' · ' : '') + `장기인보험 기준에 따라 ${changed.map(x => x.replace(/\(.*\)/, '')).join('·')}은(는) 이 시책에서 제외`).slice(0, 500)); }
  });
  if (n) warnings.push(`${company}: 인보험 시책 ${n}건에 본사 기준(장기인보험에 포함되지 않는 실손·연금저축·펫·재물·1년 단체)을 적용해 제외 상품군을 보완했습니다.`);
}

// ── 같은 확인 문구가 여러 시책에 되풀이되면 시책마다 빨간 표시를 달지 않고 한 번만 안내합니다 ──
function hoistCommonNotes(rules, company, warnings) {
  const parts = rules.map(r => r.itype === 'note' || !r.review_note ? [] : String(r.review_note).split(/\s+·\s+/).map(x => x.trim()).filter(x => x.length >= 12 && !/확인되지 않|짝을 찾지|두 번 읽은|다릅니다|바꿨습니다|바로잡|정정/.test(x)));
  const hoisted = [];
  parts.forEach((ps, i) => ps.forEach(seg => {
    if (hoisted.some(h => simil(h, seg) >= 0.6)) return;
    const holders = parts.map((qs, j) => qs.some(q => simil(q, seg) >= 0.6) ? j : -1).filter(j => j >= 0);
    if (holders.length >= 3) hoisted.push(seg);
  }));
  if (!hoisted.length) return;
  rules.forEach((r, i) => {
    if (!parts[i].length) return;
    const keep = parts[i].filter(seg => !hoisted.some(h => simil(h, seg) >= 0.6));
    r.review_note = keep.join(' · ');
  });
  hoisted.forEach(h => warnings.push(`${company}: 여러 시책에 공통인 확인 사항 — ${h.slice(0, 260)}`));
}

// ── 단체 전용 시책에 화재·재물이 섞이거나, 상품군과 추가 조건이 한 덩어리 이름으로 붙은 경우를 바로잡습니다 ──
function fixMixedTags(rules) {
  rules.forEach(r => {
    if (!r.tag || r.itype === 'note' || r.itype === 'goods') return;
    const groups = String(r.tag).split('+').map(g => g.trim()).filter(Boolean);
    const out = [];
    groups.forEach(g => {
      const toks = g.split(',').map(x => x.trim()).filter(Boolean);
      if (toks.length === 1 && !STD_CATS.includes(toks[0]) && toks[0].includes('·') && !/플랜|생상종|생활상해/.test(toks[0])) {
        // "단체보험·보장P 15% 이상" → "단체" + "보장P 15% 이상"
        const ps = toks[0].split('·').map(x => normTag(x)).filter(Boolean);
        ps.forEach(x => out.push(x));
      } else out.push(toks.map(normTag).filter(Boolean).join(','));
    });
    let res = out.filter(Boolean);
    // 단체 전용 시책(제목이 단체로 시작)이면 화재·재물 조건을 빼고, 반대로 재물 전용이면 단체를 뺍니다
    if (/^\s*단체/.test(r.title || '') && !/재물/.test(r.title || '')) res = res.filter(x => x !== '화재·재물');
    if (/^\s*재물/.test(r.title || '') && !/단체/.test(r.title || '')) res = res.filter(x => x !== '단체');
    // 운전자·생활상해 단체플랜 시책: 단체보험이 대상이므로 '상해(운전자)'를 함께 요구하면 아무 계약도 맞지 않게 됩니다
    if (res.includes('단체') && res.includes('상해(운전자)') && /플랜|생상종|생활상해/.test(`${r.title || ''} ${r.tag || ''} ${r.src_text || ''}`)) res = res.filter(x => x !== '상해(운전자)');
    const next = Array.from(new Set(res)).join('+');
    if (next && next !== r.tag) { r.memo = norm(((r.memo ? r.memo + ' · ' : '') + `상품군 조건을 ‘${next}’로 정리`).slice(0, 500)); r.tag = next; }
  });
}


// ── 본사 기준상 이미 정리된 사항에 대해 AI가 붙인 "확인 필요"는 빨간 표시 대신 조용한 메모로 바꿉니다 ──
function calmKnownNotes(rules) {
  rules.forEach(r => {
    if (!r.review_note || r.itype === 'note') return;
    const rn = String(r.review_note);
    if (/두 번 읽은 결과가 다릅니다|두 번째 읽기에서는 이 항목이 나오지 않았|공지 숫자|원문 기준|짝을 찾지/.test(rn)) return;   // 교차검증이 붙인 경고는 건드리지 않음
    let memo = '';
    if (/상해\s*[·\/,]?\s*운전자[^.]{0,30}(하나의 상품군|함께 포함|묶여)|상해보험과 운전자보험이 함께|상해보험도 별도 운전자 규칙|일반\s*상해[^.]{0,60}(통합|같은 상품군|구분|적용)|일반\s*상해[^.]{0,80}운전자|운전자[^.]{0,80}일반\s*상해/.test(rn) && !/[0-9]+\s*만\s*원[^.]{0,10}(한도|초과)/.test(rn.replace(/운전자보험만 건당 인정 한도 10만원이 적용되도록 확인 필요/, ''))) memo = '상해(운전자)는 한 상품군으로 취급합니다(일반 상해보험과 운전자보험을 구분하지 않음)';
    else if (r.itype === 'tier' && /운전자[^.]{0,40}(한도|별도)/.test(rn)) memo = '운전자 계약은 건당 인정 한도가 달라 구간 합산에는 자동 반영되지 않습니다(공통 안내 참조)';
    else if (/지급\s*예시[^.]{0,40}2028|실제 지급월 확인|13회차[^.]{0,80}(응당월|익월)[^.]{0,60}(확인|다르|상이)/.test(rn)) memo = '13회차 유지 확정 후 지급(공통기준 예시: 2026년 11월 계약 → 2028년 1월 지급)';
    if (memo) { r.review_note = ''; r.memo = norm(((r.memo ? r.memo + ' · ' : '') + memo).slice(0, 500)); }
  });
}

// ── 상품명 속 숫자(355입원, 간편31 등)를 설명 문장에서 비슷한 숫자로 잘못 적은 경우, 공지 각주 옮겨 적기의 숫자로 바로잡습니다 ──
function fixProductDigits(rules, trProducts, company, warnings) {
  const P = (Array.isArray(trProducts) ? trProducts : []).join(' ');
  if (!P) return;
  const pats = [/(\d{3})(?=입원)/g, /간편\s?(\d{2,3})/g];
  let n = 0;
  pats.forEach(re => {
    const want = new Set(); let m; const r1 = new RegExp(re.source, 'g');
    while ((m = r1.exec(P))) want.add(m[1]);
    if (!want.size) return;
    rules.forEach(r => ['memo', 'title'].forEach(f => {
      if (!r[f]) return;
      const r2 = new RegExp(re.source, 'g');
      r[f] = String(r[f]).replace(r2, (all, d) => {
        if (want.has(d)) return all;
        const cand = [...want].filter(w => w.length === d.length && [...w].filter((c, i) => c !== d[i]).length === 1);
        if (cand.length !== 1) return all;
        n++; return all.replace(d, cand[0]);
      });
    }));
  });
  if (n) warnings.push(`${company}: 설명 문장 속 상품명 숫자 ${n}곳을 공지 각주의 숫자에 맞춰 바로잡았습니다.`);
}

// ───────────────────────────────────────────────────────────────────────────
// [근본 원칙] 빨간 "확인 필요"는 **읽기 자체가 불확실할 때**(숫자·구간·기간·지급시기가 두 번 읽기와 다르거나 공지 숫자와 다를 때,
// 글자가 흐릴 때 등)에만 붙입니다. "프로그램이 자동 계산하지 못하는 사업 조건"(구성비, 한도, 제외 상품 등)에 대한 AI의 걱정은
// 시책 카드에 빨간 표시로 달지 않고, 보험사별로 한 번만 노란 '참고'로 모아 보여 줍니다.
// ───────────────────────────────────────────────────────────────────────────
const KEEP_RE = /드문 값|읽지 못|매우 큽니다|너무 작|1,000원 미만|2개월 초과|연속가동|짝|앞·뒤|수수료표|찾지 못|일부 상품에만|겹쳐 합산|단위|인용한 공지|공지 숫자|원문 기준|두 번|확인되지 않|흐려|불분명|판독|추정|글자|누락|상품 범위|표기가 다르|최소 보험료/;
function demoteAiNotes(rules, company, warnings) {
  const hoist = new Map();
  rules.forEach(r => {
    if (!r.review_note || r.itype === 'note' || r.itype === 'goods') return;
    const segs = String(r.review_note).split(/\s+·\s+/).map(x => x.trim()).filter(Boolean);
    const keep = [], drop = [];
    segs.forEach(x => (KEEP_RE.test(x) ? keep : drop).push(x));
    if (!drop.length) return;
    r.review_note = keep.join(' · ');
    drop.forEach(x => {
      const t = norm(x.replace(/^확인 필요\s*[—-]\s*/, '')).slice(0, 150);
      const key = t.replace(/\s+/g, '').slice(0, 24);
      if (!hoist.has(key)) hoist.set(key, { t, titles: [] });
      hoist.get(key).titles.push(String(r.title || '').slice(0, 20));
    });
  });
  const list = Array.from(hoist.values());
  list.slice(0, 6).forEach(h => warnings.push(`${company} 참고(자동 계산할 수 없는 조건): ${h.t}${h.titles.length > 1 ? ` (${h.titles.slice(0, 3).join(', ')}${h.titles.length > 3 ? ' 외' : ''} 등 ${h.titles.length}건)` : ` (${h.titles[0]})`}`));
  if (list.length > 6) warnings.push(`${company} 참고 사항이 ${list.length - 6}건 더 있습니다 — 공지의 공통 기준을 확인하세요.`);
}

// ── 인보험 시책의 상품군 표기 정리: 장기인보험 6개 상품군을 전부 나열했거나, 같은 상품군을 겹쳐 적었거나, 제외 상품군과 모순되는 경우 ──
const LT6 = ['상해(운전자)', '건강(의료)', '어린이', '유병자', '치아', '간병'];
function cleanInsuranceTags(rules) {
  rules.forEach(r => {
    if (r.itype === 'note' || r.itype === 'goods') return;
    // 제목이 "…— 운전자(보험) 외"이면 '운전자 말고 나머지'라는 뜻이므로 운전자 상품군은 제외 상품군에 넣습니다
    if (/[—-]\s*운전자(?:보험)?\s*외\s*$|^\s*운전자(?:보험)?\s*외\b/.test(r.title || '')) {
      const cur = Array.isArray(r.not_tags) ? r.not_tags : [];
      if (!cur.includes('상해(운전자)')) r.not_tags = cur.concat('상해(운전자)');
    }
    if (!r.tag) return;
    const not = new Set(Array.isArray(r.not_tags) ? r.not_tags : []);
    let groups = String(r.tag).split('+').map(g => Array.from(new Set(g.split(',').map(x => x.trim()).filter(Boolean))));
    groups = groups.map(g => g.filter(t => !not.has(t))).filter(g => g.length);   // 제외 상품군과 모순되는 요구는 뺌
    groups = groups.filter((g, i) => !groups.some((h, j) => j !== i && h.every(t => g.includes(t)) && (h.length < g.length || j < i)));   // 다른 묶음이 더 좁으면(포함 관계) 넓은 묶음은 불필요
    const flat = new Set(groups.flat());
    const need = LT6.filter(t => !not.has(t));
    if (groups.length === 1 && need.length >= 2 && need.every(t => flat.has(t)) && flat.size <= LT6.length && /인보험|운전자|기본시상|추가시상|가동시상|구간/.test(`${r.title || ''} ${r.src_text || ''}`)) groups = [];   // 사실상 장기인보험 전체
    const next = groups.map(g => g.join(',')).join('+');
    if (next !== r.tag) { r.memo = norm(((r.memo ? r.memo + ' · ' : '') + (next ? `상품군 조건을 ‘${next}’로 정리` : '상품군은 장기인보험 전체(제외 상품군 적용)')).slice(0, 500)); r.tag = next; }
  });
}

// ── "어린이종합보험Q·하이바이크운전자보험은 250% (300% 대신)"처럼 특정 상품에는 다른 시책이 대신 적용될 때,
//    일반 시책에서 그 상품을 빼서(prod_kw 의 "!상품명") 두 시책이 겹쳐 계산되지 않게 합니다 ──
function applySubstitutions(rules, company, warnings) {
  const tokens = x => String(x || '').split(/[+,]/).map(t => t.trim()).filter(Boolean);
  const sq = x => String(x || '').replace(/\s+/g, '').toLowerCase();
  let n = 0;
  rules.forEach(R => {
    if ((R.itype !== 'monthly' && R.itype !== 'month13') || !Array.isArray(R.prod_kw) || !R.prod_kw.some(k => String(k)[0] !== '!') || !R.value) return;
    const Rt = tokens(R.tag);
    rules.forEach(G => {
      if (G === R || G.itype !== R.itype || G.start !== R.start || G.end !== R.end || (G.pay_offset || 0) !== (R.pay_offset || 0)) return;
      if (Number(G.value) === Number(R.value) || !G.value) return;
      if (Array.isArray(G.prod_kw) && G.prod_kw.some(k => String(k)[0] !== '!')) return;   // 일반(상품 제한 없는) 시책만
      const Gt = tokens(G.tag), Gn = Array.isArray(G.not_tags) ? G.not_tags : [];
      if (Gt.length && Rt.length && !Rt.some(t => Gt.includes(t))) return;
      if (Rt.length && Rt.every(t => Gn.includes(t))) return;
      const ev = /대신|별도\s*규칙|별도규칙/.test(`${G.memo || ''} ${R.memo || ''}`) || R.prod_kw.some(k => String(k)[0] !== '!' && sq(`${G.memo || ''} ${G.src_text || ''}`).includes(sq(k)));
      if (!ev) return;
      const add = R.prod_kw.filter(k => String(k)[0] !== '!').map(k => '!' + k);
      const cur = Array.isArray(G.prod_kw) ? G.prod_kw.slice() : [];
      const fresh = add.filter(k => !cur.includes(k));
      if (!fresh.length) return;
      G.prod_kw = cur.concat(fresh); n++;
      G.memo = norm(((G.memo ? G.memo + ' · ' : '') + `${fresh.map(k => k.slice(1)).join(', ')}은(는) 별도 시책(${R.value}%)이 대신 적용되어 이 시책에서 제외`).slice(0, 500));
    });
  });
  if (n) warnings.push(`${company}: 특정 상품에 다른 시책이 대신 적용되는 경우 ${n}건 — 일반 시책에서 그 상품을 빼서 두 시책이 겹쳐 계산되지 않게 했습니다(계약 입력에 상품명을 적어야 구분됩니다).`);
}

// ── 판매건수 누계처럼 계산 대상이 아닌 시상은 안내로 두고, 빨간 "확인 필요" 표시는 달지 않습니다 ──
function calmCountNotes(rules) {
  rules.forEach(r => {
    if (r.itype !== 'note') return;
    if (r.review_note && /^확인 필요 — 여러 달 연속 조건이라 계산 제외$|여러 달 연속 조건이라 계산에서 제외|여러 달 연속 조건이라 계산 제외/.test(r.review_note) && r.review_note.length < 120) {
      r.review_note = ''; r.memo = norm(((r.memo ? r.memo + ' · ' : '') + '여러 달에 걸친 조건이라 계산하지 않고 안내로 둡니다').slice(0, 500)); return;
    }
    if (!/건수|누계/.test(`${r.title || ''} ${r.src_text || ''} ${r.memo || ''}`) || !r.review_note) return;
    if (!/건수|누계|구간표를 읽지 못해/.test(r.review_note)) return;
    r.review_note = '';
    r.memo = norm(((r.memo ? r.memo + ' · ' : '') + '판매건수 누계 조건이라 계산하지 않고 안내로 둡니다').slice(0, 500));
  });
}

// ── 설계사 등급·자격이 대상인 시상은 프로그램이 대상을 알 수 없으므로 계산에서 빼고 안내로 둡니다 ──
const GRADE_RE = /플래티넘\s*FC|그린\s*플래티넘|\d{2}\s*Q\s*(?:그린|플래티넘|골드|실버|다이아)|MDRT|등급\s*(?:대상|한정|이상)/i;
function applyGradeOnly(rules, trGrades, company, warnings) {
  const gtxt = (Array.isArray(trGrades) ? trGrades : []).join(' ');
  const done = [];
  rules.forEach(r => {
    if (r.itype === 'note' || r.itype === 'goods') return;
    const hay = `${r.title || ''} ${r.src_text || ''}`;
    const hit = GRADE_RE.test(hay) || (gtxt && GRADE_RE.test(gtxt) && simil(r.title, gtxt) >= 0.35 && /플래티넘|그린|MDRT/i.test(gtxt) && simil(r.title, gtxt) >= 0.35);
    if (!hit) return;
    let sum = '';
    if (Array.isArray(r.tiers) && r.tiers.length) sum = r.tiers.map(t => `${(t.min / 10000)}만↑ ${(t.pay / 10000)}만`).join(' · ');
    else if (r.value) sum = r.calc === 'pct' ? `${r.value}%` : `${Number(r.value).toLocaleString('ko-KR')}원`;
    r.itype = 'note'; delete r.tiers; r.value = 0; r.review_note = '';
    r.memo = norm(((r.memo ? r.memo + ' · ' : '') + `등급·자격 대상 시상이라 계산에서 제외했습니다 (${sum || '내용은 공지 참조'})`).slice(0, 500));
    done.push(r.title);
  });
  if (done.length) warnings.push(`${company}: 설계사 등급이 대상인 시상 ${done.length}건(${done.slice(0, 2).join(', ')})은 계산하지 않고 안내로 두었습니다.`);
}

// ── 공지에 적힌 상품명 목록(옮겨 적은 것)과 시책의 상품명 키워드를 맞춰 보고, 읽다가 달라진 이름을 바로잡음 ──
function reconcileProducts(rules, trProducts, company, warnings) {
  const P = [];
  (Array.isArray(trProducts) ? trProducts : []).forEach(x => String(x || '').split(/[,，、\n\/]/).forEach(y => { y = norm(y); if (y.length >= 2) P.push(y); }));
  if (P.length < 2) return;
  const sq = v => squash(v);
  const inP = k => P.some(p => sq(p).includes(sq(k)) || sq(k).includes(sq(p)));
  let fixedN = 0; const badSet = new Set(), fixSet = new Set(), diffSet = new Set();
  rules.forEach(r => {
    if (!Array.isArray(r.prod_kw) || !r.prod_kw.length) return;
    const hadSlash = r.prod_kw.some(k => /\//.test(k));
    const kws = r.prod_kw.flatMap(k => String(k).split('/').map(z => norm(z)).filter(z => z.length >= 2));
    if (hadSlash) { r.prod_kw = Array.from(new Set(kws)); if (/상품명.*(생략|불명확|슬래시)|슬래시/.test(r.review_note || '')) r.review_note = ''; }
    // 시책 설명(memo·원문 발췌)에도 같은 글자로 적혀 있으면, 옮겨 적기 쪽이 글자를 잘못 읽었을 수 있으므로 바꾸지 않고 확인만 요청합니다
    const own = sq([r.memo, r.src_text, r.title].join(' '));
    const selfOk = new Set(kws.filter(k => !inP(k) && sq(k).length >= 5 && own.includes(sq(k))));
    selfOk.forEach(k => diffSet.add(k));
    const miss = kws.filter(k => !inP(k) && !selfOk.has(k));
    if (!miss.length) return;
    // 목록 안에서 어느 상품이 이 시책 소속인지 알려면 시책 상품이 목록 전체와 같은 개수여야 가장 믿을 만함
    const usedP = new Set(P.filter(p => kws.some(k => sq(p).includes(sq(k)) || sq(k).includes(sq(p)))));
    const freeP = P.filter(p => !usedP.has(p));
    const out = kws.slice();
    if (kws.length === P.length) {
      // 같은 개수·같은 순서이면 순서대로 짝지어 읽기 오류만 교체
      kws.forEach((k, i) => { if (!inP(k) && !selfOk.has(k)) { out[i] = P[i]; fixedN++; fixSet.add(k + ' → ' + P[i]); } });
    } else {
      const pool = freeP.slice();
      kws.forEach((k, i) => {
        if (inP(k) || selfOk.has(k)) return;
        let best = -1, bs = 0.45; pool.forEach((p, j) => { const sc = simil(k, p); if (sc > bs) { bs = sc; best = j; } });
        if (best >= 0) { out[i] = pool[best]; pool.splice(best, 1); fixedN++; fixSet.add(k + ' → ' + out[i]); } else badSet.add(k);
      });
    }
    r.prod_kw = Array.from(new Set(out.flatMap(k => String(k).split('/').map(z => norm(z)).filter(z => z.length >= 2))));
    if (miss.length && out.some((k, i) => k !== kws[i])) r.memo = norm(((r.memo ? r.memo + ' · ' : '') + '상품명은 공지 각주 글자와 맞춰 바로잡음').slice(0, 500));
  });
  if (fixSet.size) warnings.push(`${company}: 읽는 도중 달라진 상품명 ${fixSet.size}개를 공지 각주의 글자에 맞춰 바로잡았습니다(${Array.from(fixSet).slice(0, 5).join(', ')}). 주력상품 목록을 원문과 한 번 더 대조하세요.`);
  if (diffSet.size) warnings.push(`${company}: 시책의 상품명 ${diffSet.size}개가 공지 각주 옮겨 적기와 글자가 다릅니다(${Array.from(diffSet).slice(0, 5).join(', ')}) — 옮겨 적기가 잘못 읽었을 수 있어 바꾸지 않았습니다. 공지 원문과 대조하세요.`);
  if (badSet.size) warnings.push(`${company}: 공지 각주와 맞지 않는 상품명 ${badSet.size}개가 남아 있습니다(${Array.from(badSet).slice(0, 8).join(', ')}) — 주력상품 목록을 원문과 직접 대조하세요.`);
}

function crossCheck(outA, outB, tr, srcText) {
  const warnings = [];
  // 확인용 근거 글: AI 가 옮겨 적은 글(transcript)에 더해, 파일에서 직접 뽑은 원문(PPT·워드·엑셀 등)도 함께 봅니다.
  // 옮겨 적기가 표의 일부를 놓쳐도 원문에 그 숫자가 있으면 틀렸다고 하지 않기 위해서입니다.
  const trE = (tr || (srcText && String(srcText).trim())) ? Object.assign({ percents: [], pairs: [] }, tr || {}, { text: String((tr && tr.text) || '') + '\n' + String(srcText || '') }) : tr;
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
    // 종류(월 시책 ↔ 구간표 등)가 다른 항목은 이름이 꽤 비슷할 때만 같은 시책으로 봅니다(엉뚱한 시책과 짝지어 거짓 경고가 나는 것을 막음)
    if (best && best.itype !== a.itype && simil(a.title, best.title) < 0.5) return null;
    // 같은 종류라도 이름·값·상품군·구간이 하나도 닮지 않았으면 같은 시책으로 보지 않습니다
    // 월 시책끼리 지급률(%)이 다른데 이름도 거의 같지 않으면 서로 다른 시책입니다(예: 인보험 150% ↔ 단체 100%)
    if (best && a.itype !== 'tier' && best.itype !== 'tier' && a.value && best.value && a.value !== best.value && simil(a.title, best.title) < 0.8) return null;
    // 상품군이 서로 전혀 다른 표준 상품군(예: 운전자 ↔ 연금)이면 지급률이 같아도 다른 시책입니다
    if (best && a.tag && best.tag && simil(a.title, best.title) < 0.8) {
      const tk = x => String(x).split(/[,+]/).map(z => z.trim()).filter(z => STD_CATS.includes(z));
      const A = tk(a.tag), B = tk(best.tag);
      if (A.length && B.length && !A.some(t => B.includes(t))) return null;
    }
    if (best) {
      const tierHit = (a.tiers || []).some(t => (best.tiers || []).some(u => u.min === t.min));
      const like = simil(a.title, best.title) >= 0.35 || (a.value && a.value === best.value) || (a.tag && a.tag === best.tag) || tierHit;
      if (!like) return null;
    }
    return best;
  };
  let bUsable = false;
  for (const ba of outA) {
    const bb = outB ? outB.find(x => x.batch.company === ba.batch.company) : null;
    const pool = bb ? bb.rules.filter(money).slice() : [];
    // ① 두 번째 읽기가 믿을 만한지 먼저 판단: 첫 번째 읽기 항목 중 절반 이상을 찾아내지 못하면 두 번째 읽기는 부실한 것으로 보고 비교에 쓰지 않습니다
    {
      const tt = tr ? [tr.rules_text, tr.text, (tr.percents || []).join(' '), (tr.pairs || []).map(p => `${p.ctx || ''}`).join(' ')].join(' ') : '';
      applyPayTiming(ba.rules, tt + ' ' + String(srcText || ''), ba.batch.company, warnings);
      applyGradeOnly(ba.rules, tr && tr.grades, ba.batch.company, warnings);
      calmCountNotes(ba.rules);
      if (ba.batch.grp === 'nonlife') fixMixedTags(ba.rules);
      if (ba.batch.grp === 'nonlife') cleanInsuranceTags(ba.rules);
      if (ba.batch.grp === 'nonlife') calmKnownNotes(ba.rules);
      if (ba.batch.grp === 'nonlife') applyInsuranceScope(ba.rules, ba.batch.company, warnings);
      if (ba.batch.grp === 'nonlife') { fixSilsonYubyeong(ba.rules, tt + ' ' + String(srcText || ''), ba.batch.company, warnings); splitDriverCap(ba.rules, tt + ' ' + String(srcText || ''), ba.batch.company, warnings); }
      if (tr && ba.batch.grp === 'nonlife') fixProductDigits(ba.rules, tr.products, ba.batch.company, warnings);
      if (tr && ba.batch.grp === 'nonlife') reconcileProducts(ba.rules, tr.products, ba.batch.company, warnings);
    }
    if (tr) {
      const rt = (tr.rules_text || '') + ' ' + (tr.text || '');
      applyScopedCaps(ba.rules, rt, ba.batch.company, warnings);
      // 공지가 "13회차 유지 후 15차월 이후 지급"처럼 지급 시기를 밝히면 13회차 유지 시책의 지급 시기를 그에 맞춥니다
      const pm = /13\s*(?:회차|차월)\s*유지[^.\n]{0,12}?(1[3-6])\s*차월\s*(?:이후|부터)?\s*지급/.exec(rt);
      if (pm) { const N = +pm[1]; let n = 0; ba.rules.forEach(r => { if (['note', 'goods'].includes(r.itype)) return; if ((r.pay_offset >= 13 && r.pay_offset !== N) && /13\s*(회차|차월)/.test(`${r.title || ''} ${r.src_text || ''}`)) { r.pay_offset = N; n++; } }); if (n) warnings.push(`${ba.batch.company}: 공지의 ‘13회차 유지 후 ${N}차월 이후 지급’에 맞춰 지급 시기를 ${N}차월로 맞춘 시책 ${n}건`); }
    }
    const aMoney = ba.rules.filter(money);
    const probe = new Set(); let hit = 0;
    aMoney.forEach(a => { const b = pickB(a, pool, probe); if (b) { probe.add(b); hit++; } });
    const bGood = !!bb && aMoney.length > 0 && hit / aMoney.length >= 0.6;
    if (bGood) bUsable = true;
    const used = new Set(); const softTitles = [];
    for (const a of ba.rules) {
      if (!money(a)) continue;
      total++;
      const msgs = [];
      let bestB = null;
      if (bGood) {
        const best = pickB(a, pool, used);
        if (!best) {
          // '운전자'와 '그 외'로 나눈 시책은 두 번째 읽기가 하나로 합쳐 적었을 수 있으므로 짝이 없어도 문제 삼지 않습니다
          const splitSibling = /운전자/.test(`${a.title || ''} ${a.tag || ''}`) && ba.rules.some(x => x !== a && x.itype === a.itype && x.start === a.start && x.end === a.end && Number(x.value) === Number(a.value) && /운전자/.test(`${x.title || ''} ${x.tag || ''}`));
          if (!tr && !splitSibling) msgs.push('두 번째 읽기에서는 이 항목이 나오지 않았습니다');
        }
        else { bestB = best; used.add(best); const d = diffText(a, best, tr ? `${tr.rules_text || ''} ${tr.text || ''}` : '');
          // 값·기간·지급시기·구간처럼 숫자로 확인되는 차이만 빨간 표시, 상품군·제외·한도·단위 표기 차이는 모아서 노란 참고로만 알립니다
          const hardD = d.filter(x => /^(값|시작|끝|유형|지급시기|구간)/.test(x)), softD = d.filter(x => !hardD.includes(x));
          if (hardD.length) msgs.push('두 번 읽은 결과가 다릅니다 — ' + hardD.slice(0, 3).join(' / '));
          if (softD.length) softTitles.push(String(a.title || '').slice(0, 20)); }
      }
      applyMinFromConds(a, tr);
      // 프로그램이 판정하지 못하는 추가 조건(보장구성비 등)이나, 최소 보험료인지 불분명한 "30만↑"가 붙은 월 시책은 사람이 확인하도록 표시
      if (a.itype !== 'tier' && !a.min_premium) {
        const q = `${a.title || ''} ${a.src_text || ''}`;
        if (/보장\s*구성비|구성비\s*\d+\s*%/.test(q)) msgs.push('공지의 추가 조건(보장구성비 등)은 프로그램이 판정하지 못합니다 — 이 시책이 모든 계약에 계산되는 점을 확인하세요');
        else if (/\d+(?:\.\d+)?\s*만\s*원?\s*↑\s*(?:&|및|\+)/.test(q)) msgs.push('공지의 "N만↑" 조건이 건당 최소 보험료인지 확인 필요 (지금은 모든 계약에 계산됨)');
      }
      // 독립적인 대조가 전혀 없어도, 항목의 숫자가 자기가 인용한 공지 문구(src_text)와 다르면 걸러냅니다
      if (a.calc === 'pct' && a.value > 0 && a.src_text && !/별도\s*규칙|대신\s*적용/.test(a.memo || '')) {
        const ps = []; String(a.src_text).replace(/(\d+(?:\.\d+)?)\s*%/g, (m, x) => { ps.push(parseFloat(x)); });
        // PDF 글자 층이 숫자를 "15 0%", "5 50%"처럼 끊어 놓은 경우(150%, 550%)도 같은 수로 인정합니다
        String(a.src_text).replace(/(?<![\d.])(\d{1,3}) (\d{1,3})\s*%/g, (m, x, y) => { ps.push(parseFloat(x + y)); });
        pctWords(a.src_text).forEach(v => ps.push(v));
        if (ps.length && !ps.includes(Number(a.value))) msgs.push(`입력된 ${a.value}%가 인용한 공지 문구(${ps.join('·')}%)와 다릅니다`);
      }
      const au = auditAgainstTranscript(a, trE);
      // 옮겨 적기에서 짝을 못 찾았을 뿐 틀렸다는 증거가 없고, 시책이 인용한 공지 문구(src_text)의 구간·금액 짝이 모두 일치하면 믿습니다
      if (au.msgs.length && a.itype === 'tier' && au.msgs.every(m => /짝을 찾지 못/.test(m)) && (a.tiers || []).length) {
        const pr = pairsFromText(a.src_text);
        const own = (a.tiers || []).filter(t => !t.prev);
        if (pr.size >= 2 && own.length && own.every(t => pr.get(t.min) === t.pay)) au.msgs.length = 0;
        else if (sequenceConfirms(a.tiers, a.src_text)) au.msgs.length = 0;
      }
      const bAudit = bestB ? auditAgainstTranscript(bestB, trE) : { msgs: ['-'], specific: false };
      if (au.specific && !au.msgs.length) {
        msgs.length = 0; // 공지의 해당 표와 한 칸씩 일치 — 두 번째 읽기와 달라도 신뢰
      } else {
        if (au.msgs.length && a.itype === 'tier' && bestB && bestB.itype === 'tier' && Array.isArray(bestB.tiers) && !bAudit.msgs.length && (bAudit.specific || !tr)) {
          a.tiers = bestB.tiers.map(t => Object.assign({}, t)); au.msgs.length = 0; msgs.length = 0;
          if (!warnings.some(w => w.includes(a.title) && /원문 기준으로 정정/.test(w))) warnings.push(`${ba.batch.company}: ‘${a.title}’의 구간 금액이 공지 숫자와 달라, 공지와 일치하는 두 번째 읽기 결과로 바로잡았습니다(공지 원문과 일치).`);
        } else if (au.msgs.length && a.itype === 'tier' && bestB && bestB.itype === 'tier' && (a.tiers || []).length && ruleSig(a).구간 === ruleSig(bestB).구간 && bAudit.msgs.length) {
          au.msgs.length = 0;   // 두 번 읽은 결과가 구간표 숫자까지 똑같고 옮겨 적기만 다르면, 옮겨 적기가 그 표의 칸을 빠뜨렸거나 다른 표와 섞인 것으로 봅니다
        } else if (tr && !au.msgs.length && bestB && bAudit.msgs.length) {
          msgs.length = 0;
        }
        au.msgs.forEach(m => msgs.push(m));
      }
      if (msgs.length) { flagged++; addNote(a, msgs.join(' · ')); } else agreed++;
    }
    hoistCommonNotes(ba.rules, ba.batch.company, warnings);
    if (softTitles.length) warnings.push(`${ba.batch.company}: 두 번째 읽기와 상품군·제외 상품군·건당 한도 표기가 다른 시책 ${softTitles.length}건(${softTitles.slice(0, 3).join(', ')}${softTitles.length > 3 ? ' 외' : ''}) — 금액·기간·지급 시기는 같습니다. 필요하면 공지 공통 기준을 확인하세요.`);
    demoteAiNotes(ba.rules, ba.batch.company, warnings);
    const only = bGood ? pool.filter(b => !used.has(b)) : [];
    if (only.length) warnings.push(`${ba.batch.company}: 두 번째 읽기에만 나온 항목 ${only.length}건 — ${only.slice(0, 3).map(b => `${b.title.slice(0, 24)}(${b.start}~${b.end})`).join(', ')}${only.length > 3 ? ' 등' : ''}. 공지에서 빠진 시책이 없는지 확인하세요.`);
  }
  const how = [bUsable ? '두 번 읽기 비교' : null, tr ? '공지 숫자 대조' : null].filter(Boolean).join(' + ');
  if (!how && total) warnings.push('자동 대조를 하지 못했습니다(두 번째 읽기가 부실하고 숫자 옮겨 적기도 실패). 항목마다 경고를 붙이지 않았으니 공지와 직접 대조한 뒤 확정하세요.');
  const summary = how ? `교차검증(${how}): 계산 대상 ${total}건 중 ${agreed}건 일치, ${flagged}건 확인 필요` : '자동 교차검증 불가 — 공지와 직접 대조 필요';
  return { warnings, summary, total, agreed, flagged, bUsable };
}

module.exports = { validate, norm, crossCheck, parseWon, applySubstitutions, cleanInsuranceTags, demoteAiNotes };
