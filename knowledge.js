/**
 * knowledge.js — 학습 지식창고
 *
 * 하는 일
 *   1) 블로그 글 / 영상 대본 / 붙여넣은 글을 읽고, AI가 "학습 노트"(핵심 원칙·절차·판례·주의점)로
 *      정리합니다. 원문은 저장하지 않고, 정리된 노트와 출처(제목·주소)만 저장합니다.
 *   2) 표·숫자 자료(PDF 가이드북 등)는 정리하면 숫자가 틀어질 수 있어, 페이지별로 구조를 살려
 *      그대로 보관합니다 (사내 교육용 같은 사용 제한 문구도 함께 저장).
 *   3) 노트/페이지마다 OpenAI 임베딩(의미 벡터)을 만들어 두고, 질문이 오면 의미가 가까운
 *      것들을 찾아 AI 상담에 참고자료로 건네줍니다. (search)
 *
 * 관리자(상무)만 등록·삭제할 수 있고, AI 상담(/api/chat)은 search()만 사용합니다.
 */

const express = require('express');
const path = require('path');
const multer = require('multer');
const { pool } = require('./db');

const EMBED_MODEL = 'text-embedding-3-small';
const EMBED_DIMS = 512;
const DISTILL_MODEL = process.env.DISTILL_MODEL || 'gpt-4.1-mini';
const UA = 'Mozilla/5.0 (compatible; LeadersAIBot/1.0; +https://leadersfp.co.kr)';

/* ───────────────────────── 공통 도구 ───────────────────────── */

async function fetchText(url, opts = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), opts.timeout || 15000);
  try {
    const r = await fetch(url, {
      signal: ctrl.signal,
      redirect: 'follow',
      headers: { 'User-Agent': UA, 'Accept-Language': 'ko-KR,ko;q=0.9', ...(opts.headers || {}) },
    });
    // 한국 보험사 사이트 중 EUC-KR(KS_C_5601) 인코딩인 곳이 있어 글자 깨짐을 막습니다.
    const buf = Buffer.from(await r.arrayBuffer());
    let cs = ((r.headers.get('content-type') || '').match(/charset=([\w-]+)/i) || [])[1];
    if (!cs) cs = (buf.subarray(0, 3000).toString('latin1').match(/charset=["']?([\w-]+)/i) || [])[1];
    cs = String(cs || 'utf-8').toLowerCase();
    if (/^(ks_c_5601|ksc5601|euc_kr|x-windows-949|ms949|cp949)/.test(cs)) cs = 'euc-kr';
    let text;
    try { text = new TextDecoder(cs).decode(buf); } catch (e) { text = buf.toString('utf8'); }
    return { ok: r.ok, status: r.status, text };
  } catch (e) {
    return { ok: false, status: 0, text: '', error: e.message };
  } finally {
    clearTimeout(timer);
  }
}

function decodeEntities(s) {
  return s
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)));
}

// 문단 구분(줄바꿈)을 살려서 태그를 제거합니다.
function htmlToText(html) {
  return decodeEntities(
    html
      .replace(/<script[\s\S]*?<\/script>/gi, ' ')
      .replace(/<style[\s\S]*?<\/style>/gi, ' ')
      .replace(/<!--[\s\S]*?-->/g, ' ')
      .replace(/<\/(p|div|li|h[1-6]|tr|table|blockquote)>/gi, '\n')
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<[^>]+>/g, ' ')
  )
    .replace(/[ \t ​]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

// 한글 PDF는 글꼴 정보(CMap)가 필요한 경우가 있어 pdfjs에 경로를 알려줍니다. (없으면 글자가 비어서 읽힘)
let PDF_ASSETS = {};
try {
  const pdfBase = path.dirname(require.resolve('pdfjs-dist/package.json'));
  PDF_ASSETS = {
    cMapUrl: path.join(pdfBase, 'cmaps') + path.sep, cMapPacked: true,
    standardFontDataUrl: path.join(pdfBase, 'standard_fonts') + path.sep,
  };
} catch (e) { console.warn('[지식] pdfjs 글꼴 경로를 찾지 못했습니다:', e.message); }


/* ───────────────────────── 임베딩 / 검색 ───────────────────────── */

function normalize(vec) {
  let n = 0;
  for (const x of vec) n += x * x;
  n = Math.sqrt(n) || 1;
  return vec.map(x => x / n);
}

// OpenAI 임베딩은 분당 사용량 한도가 있어서(조직 기준), 큰 약관을 연속으로 올리면 한도에 걸립니다.
// 요청 전에 사용량을 대략 예약하고, 응답에 오는 실제 사용량으로 바로잡아서 한도 직전까지만 빠르게 보냅니다.
// 그래도 한도 오류(429)가 나면 안내된 시간만큼 기다렸다가 다시 시도합니다.
const embedWindow = [];
async function throttleEmbed(tokens) {
  const LIMIT = 850000; // 조직 한도(분당 100만) 아래로
  for (;;) {
    const now = Date.now();
    while (embedWindow.length && now - embedWindow[0].t > 60000) embedWindow.shift();
    const used = embedWindow.reduce((n, x) => n + x.tokens, 0);
    if (used + tokens <= LIMIT || !embedWindow.length) break;
    await sleep(Math.max(500, 60000 - (now - embedWindow[0].t) + 300));
  }
  const entry = { t: Date.now(), tokens };
  embedWindow.push(entry);
  return entry;
}

async function embedTexts(texts, onProgress) {
  const BATCH = 100, CONCURRENCY = 3;
  const batches = [];
  for (let i = 0; i < texts.length; i += BATCH) batches.push({ start: i, items: texts.slice(i, i + BATCH).map(t => String(t).slice(0, 6000)) });
  const out = new Array(texts.length);
  let next = 0, done = 0;
  async function worker() {
    for (;;) {
      const bi = next++;
      if (bi >= batches.length) return;
      const b = batches[bi];
      const entry = await throttleEmbed(Math.ceil(b.items.reduce((n, t) => n + t.length, 0) * 0.5)); // 한글은 글자당 약 0.4~0.5 토큰
      let data = null;
      for (let attempt = 1; attempt <= 8; attempt++) {
        const r = await fetch('https://api.openai.com/v1/embeddings', {
          method: 'POST',
          headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ model: EMBED_MODEL, input: b.items, dimensions: EMBED_DIMS }),
        });
        if (r.ok) { data = await r.json(); break; }
        const body = await r.text();
        if ((r.status === 429 || r.status >= 500) && attempt < 8) {
          // "Please try again in 1m3.5s" / "in 820ms" 형태의 안내를 읽어 그만큼 기다립니다.
          const m = body.match(/try again in\s+(?:(\d+)m)?\s*([\d.]+)(ms|s)/i);
          let wait = 5000 * attempt;
          if (m) wait = ((Number(m[1] || 0) * 60) + (m[3] === 'ms' ? Number(m[2]) / 1000 : Number(m[2]))) * 1000 + 1500;
          console.log(`[지식] 임베딩 대기 ${Math.round(wait / 1000)}초 (시도 ${attempt}, 상태 ${r.status})`);
          await sleep(Math.min(wait, 70000));
          continue;
        }
        throw new Error('임베딩 실패: ' + body.slice(0, 200));
      }
      if (data.usage && data.usage.total_tokens) entry.tokens = data.usage.total_tokens; // 실제 사용량으로 바로잡기
      data.data.forEach((d, j) => { out[b.start + (d.index != null ? d.index : j)] = normalize(d.embedding); });
      done += b.items.length;
      if (onProgress) onProgress(Math.min(done, texts.length), texts.length);
    }
  }
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, batches.length) }, worker));
  return out;
}

let cache = null; // { items: [{id, docId, topic, content, page, vec, doc...}] }
function invalidateCache() { cache = null; }

async function loadCache() {
  if (cache) return cache;
  // 약관은 양이 방대해서 본문은 메모리에 올리지 않고(검색용 숫자만), 찾은 뒤에 필요한 것만 DB에서 읽습니다.
  const rows = (await pool.query(
    `SELECT c.id, c.doc_id, c.topic, c.note_type, CASE WHEN d.source_type = 'terms' THEN NULL ELSE c.content END AS content, c.page, c.embedding,
            d.title, d.url, d.source_name, d.source_type, d.notice, d.company
     FROM knowledge_chunks c JOIN knowledge_docs d ON d.id = c.doc_id`
  )).rows;
  cache = {
    items: rows.map(r => ({
      id: r.id, docId: r.doc_id, topic: r.topic, noteType: r.note_type, content: r.content, page: r.page,
      title: r.title, url: r.url, sourceName: r.source_name, sourceType: r.source_type, notice: r.notice, company: r.company,
      vec: Float32Array.from(typeof r.embedding === 'string' ? JSON.parse(r.embedding) : r.embedding),
    })),
  };
  return cache;
}

// 질문 속 보험사 이름 찾기 ("삼성생명 암 면책" → 삼성생명). 길고 구체적인 이름부터 확인합니다.
const COMPANY_ALIASES = [
  ['삼성생명', ['삼성생명', '삼성 생명']], ['한화생명', ['한화생명']], ['교보생명', ['교보생명', '교보']], ['DB생명', ['db생명', '디비생명']],
  ['KB라이프생명', ['kb라이프', '케이비라이프', 'kb 라이프']], ['KDB생명', ['kdb생명', '케이디비생명']], ['흥국생명', ['흥국생명']],
  ['동양생명', ['동양생명']], ['ABL생명', ['abl생명', '에이비엘생명', 'abl']], ['라이나생명', ['라이나생명', '라이나']], ['하나생명', ['하나생명']],
  ['카디프생명', ['카디프']], ['IBK생명', ['ibk생명', '아이비케이생명']], ['iM라이프생명', ['im라이프', '아이엠라이프', 'im생명']],
  ['메트라이프생명', ['메트라이프']], ['미래에셋생명', ['미래에셋생명', '미래에셋']], ['농협생명', ['농협생명', 'nh농협생명']],
  ['신한라이프', ['신한라이프', '신한생명']], ['처브라이프', ['처브라이프', '처브']], ['푸본현대생명', ['푸본현대', '푸본']], ['AIA생명', ['aia생명', 'aia', '에이아이에이']],
  ['메리츠화재', ['메리츠화재', '메리츠']], ['KB손해보험', ['kb손해보험', 'kb손보', '케이비손해보험', 'kb손해']], ['현대해상', ['현대해상']],
  ['DB손해보험', ['db손해보험', 'db손보', '디비손해보험', '디비손보']], ['흥국화재', ['흥국화재']], ['하나손해보험', ['하나손해보험', '하나손보']],
  ['농협손해보험', ['농협손해보험', '농협손보', 'nh농협손해보험']], ['삼성화재', ['삼성화재']], ['롯데손해보험', ['롯데손해보험', '롯데손보']],
  ['AIG손해보험', ['aig손해보험', 'aig손보', 'aig']], ['한화손해보험', ['한화손해보험', '한화손보']],
];
function detectCompany(text) {
  const t = String(text || '').toLowerCase().replace(/\s+/g, ' ');
  const nospace = t.replace(/\s/g, '');
  let best = null;
  for (const [name, aliases] of COMPANY_ALIASES) {
    for (const a of aliases) {
      const al = a.toLowerCase();
      if (t.includes(al) || nospace.includes(al.replace(/\s/g, ''))) {
        if (!best || al.length > best.len) best = { name, len: al.length };
      }
    }
  }
  return best ? best.name : null;
}

// 질문과 의미가 가까운 노트/페이지를 찾습니다.
async function search(query, k = 6, minScore = 0.3, opts = {}) {
  const { items } = await loadCache();
  if (!items.length || !query || !query.trim()) return [];
  const company = opts.company || null;
  const [q] = await embedTexts([query]);
  const qv = Float32Array.from(q);
  const scored = [];
  for (const it of items) {
    // 보험사가 지정된 질문이면, 약관은 그 보험사 것만 봅니다(다른 보험사 약관은 제외).
    if (company && it.sourceType === 'terms' && it.company !== company) continue;
    let s = 0;
    for (let i = 0; i < qv.length; i++) s += qv[i] * it.vec[i];
    if (s >= minScore) scored.push({ it, score: s });
  }
  scored.sort((a, b) => b.score - a.score);
  const perDoc = new Map();
  const picked = [];
  const pickedIds = new Set();
  const take = (x) => {
    perDoc.set(x.it.docId, (perDoc.get(x.it.docId) || 0) + 1);
    pickedIds.add(x.it.id);
    const { vec, ...rest } = x.it;
    picked.push({ ...rest, score: Number(x.score.toFixed(3)) });
  };
  // 1차: 한 자료에서 골고루(보험사 지정 약관은 상품당 2개, 그 외 약관 6개/기타 3개)
  for (const x of scored) {
    const cap = x.it.sourceType === 'terms' ? (company ? 2 : 6) : 3;
    if ((perDoc.get(x.it.docId) || 0) >= cap) continue;
    take(x);
    if (picked.length >= k) break;
  }
  // 2차: 보험사 지정인데 자리가 남으면(상품이 적은 경우) 점수 순으로 더 채웁니다(약관은 한 자료에서 최대 6개).
  if (company && picked.length < k) {
    for (const x of scored) {
      if (pickedIds.has(x.it.id) || (perDoc.get(x.it.docId) || 0) >= 6) continue;
      take(x);
      if (picked.length >= k) break;
    }
    picked.sort((a, b) => b.score - a.score);
  }
  // 약관 본문은 여기서 읽어 옵니다.
  const need = picked.filter(p => p.content == null).map(p => p.id);
  if (need.length) {
    const r = await pool.query(`SELECT id, content FROM knowledge_chunks WHERE id IN (${need.map((_, i) => '$' + (i + 1)).join(',')})`, need);
    const m = new Map(r.rows.map(x => [x.id, x.content]));
    picked.forEach(p => { if (p.content == null) p.content = m.get(p.id) || ''; });
  }
  return picked;
}

/* ───────────────────────── 학습(정리) ───────────────────────── */

const DISTILL_SYSTEM = `당신은 보험 실무 지식을 정리하는 학습 담당자입니다. 아래 글(블로그 글 또는 영상 대본)을 읽고, 보험설계사가 고객 상담·보험금 청구·보험 설계에 바로 쓸 수 있는 "학습 노트"로 정리하세요.

규칙:
- 원문의 문장을 그대로 옮기지 말고, 반드시 당신의 말로 압축해서 다시 쓰세요. 표현이 아니라 사실·원칙·절차·기준·수치를 정리하는 것입니다.
- 핵심만 담으세요: 원칙/기준, 처리 절차, 보험금 청구·분쟁 시 주의점, 판례(법원, 선고일, 사건번호, 쟁점, 결론), 상품·특약 조합의 요령과 이유, 용어 설명.
- 홍보 문구, 인사말, 일상 이야기, 방송 일정 안내 같은 것은 제외하세요.
- 글에 없는 내용을 추가하거나 추측하지 마세요. 판례 번호나 수치는 글에 나온 그대로만 쓰세요.
- 보험·금융·법률·의학 실무와 무관한 글이면 notes를 빈 배열로 하세요.
- 노트는 글 하나당 최대 8개, 각 노트의 content는 3~8문장.

반드시 아래 JSON으로만 답하세요:
{"notes":[{"topic":"한 줄 주제","type":"원칙|절차|판례|상품조합|주의|용어","content":"정리 내용","keywords":["검색에 쓰일 핵심어", "..."]}]}`;

async function distillOnce(title, text) {
  const r = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: DISTILL_MODEL,
      response_format: { type: 'json_object' },
      temperature: 0.2,
      max_tokens: 2500,
      messages: [
        { role: 'system', content: DISTILL_SYSTEM },
        { role: 'user', content: `[제목] ${title}\n\n[본문]\n${text}` },
      ],
    }),
  });
  if (!r.ok) throw new Error('정리 실패: ' + (await r.text()).slice(0, 200));
  const data = await r.json();
  let parsed = {};
  try { parsed = JSON.parse(data.choices?.[0]?.message?.content || '{}'); } catch (e) { /* 빈 결과 */ }
  const notes = Array.isArray(parsed.notes) ? parsed.notes : [];
  return notes
    .filter(n => n && typeof n.content === 'string' && n.content.trim().length > 20)
    .map(n => ({
      topic: String(n.topic || title).slice(0, 200),
      type: String(n.type || '').slice(0, 20),
      content: n.content.trim().slice(0, 2500),
      keywords: Array.isArray(n.keywords) ? n.keywords.map(String).slice(0, 12) : [],
    }));
}

// 긴 글(영상 대본 등)은 12,000자씩 나눠 정리합니다.
async function distill(title, text) {
  const WINDOW = 12000;
  const notes = [];
  for (let i = 0; i < text.length && i < WINDOW * 6; i += WINDOW) {
    notes.push(...(await distillOnce(title, text.slice(i, i + WINDOW))));
  }
  return notes;
}

/* ───────────────────────── 저장 ───────────────────────── */

async function docExists(url) {
  if (!url) return false;
  return (await pool.query('SELECT 1 FROM knowledge_docs WHERE url = $1 LIMIT 1', [url])).rows.length > 0;
}

// entries: [{topic, type, content, keywords, page}]
// PDF에서 뽑은 글자에는 널(NUL)·제어 문자가 섞이는 경우가 있고, Postgres는 이를 저장하지 못합니다.
const cleanText = (v) => String(v == null ? '' : v).replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\uFFFE\uFFFF]/g, '');

async function saveDoc({ sourceType, sourceName, title, url, notice, mode, entries, userId, onProgress, company }) {
  entries = (entries || []).map(e => ({ ...e, topic: e.topic == null ? e.topic : cleanText(e.topic), content: cleanText(e.content) }));
  title = cleanText(title); notice = notice ? cleanText(notice) : notice;
  if (!entries.length) return { docId: null, saved: 0 };
  const embedInputs = entries.map(e => `${e.topic || ''}\n${e.content}\n${(e.keywords || []).join(' ')}`);
  const vecs = await embedTexts(embedInputs, onProgress);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const d = await client.query(
      `INSERT INTO knowledge_docs (source_type, source_name, title, url, notice, mode, created_by, company)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`,
      [sourceType, sourceName, String(title).slice(0, 300), url || null, notice || null, mode, userId || null, company || null]
    );
    const docId = d.rows[0].id;
    for (let st = 0; st < entries.length; st += 100) {
      const part = entries.slice(st, st + 100);
      const vals = [], params = [];
      part.forEach((e, j) => {
        const o = j * 6;
        vals.push(`($${o + 1},$${o + 2},$${o + 3},$${o + 4},$${o + 5},$${o + 6})`);
        params.push(docId, e.topic || null, e.type || null, e.content, e.page || null, JSON.stringify(vecs[st + j]));
      });
      await client.query(`INSERT INTO knowledge_chunks (doc_id, topic, note_type, content, page, embedding) VALUES ${vals.join(',')}`, params);
    }
    await client.query('COMMIT');
    invalidateCache();
    return { docId, saved: entries.length };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

// 글/대본을 읽고 정리해서 저장
async function learnFromText({ sourceType, sourceName, title, url, text, notice, userId }) {
  if (await docExists(url)) return { skipped: true, reason: '이미 학습한 글입니다.' };
  const notes = await distill(title, text);
  if (!notes.length) return { skipped: true, reason: '보험 실무와 관련된 내용을 찾지 못했습니다.' };
  const r = await saveDoc({ sourceType, sourceName, title, url, notice, mode: 'notes', entries: notes, userId });
  return { saved: r.saved, notes };
}

/* ───────────────────────── PDF (표·숫자 자료) ───────────────────────── */

// 페이지마다 글자 위치(좌표)로 줄과 칸을 복원합니다. 칸 사이는 " | "로 구분합니다.
async function extractPdfPages(buffer) {
  const pdfjs = require('pdfjs-dist/legacy/build/pdf.js');
  const doc = await pdfjs.getDocument({
    data: new Uint8Array(buffer), useSystemFonts: true, disableFontFace: true, isEvalSupported: false, ...PDF_ASSETS,
  }).promise;
  const pages = [];
  for (let p = 1; p <= doc.numPages; p++) {
    const page = await doc.getPage(p);
    const tc = await page.getTextContent();
    const items = tc.items
      .filter(it => typeof it.str === 'string' && it.str.length)
      .map(it => ({ x: it.transform[4], y: it.transform[5], w: it.width || 0, s: it.str }));
    // 위에서 아래로, y가 비슷한 글자들(±3)을 같은 줄로 묶습니다.
    items.sort((a, b) => b.y - a.y || a.x - b.x);
    const rowsArr = [];
    for (const it of items) {
      const row = rowsArr.find(r => Math.abs(r.y - it.y) <= 3);
      if (row) row.items.push(it); else rowsArr.push({ y: it.y, items: [it] });
    }
    rowsArr.sort((a, b) => b.y - a.y);
    const lines = rowsArr.map(r => {
      r.items.sort((a, b) => a.x - b.x);
      let line = '';
      let prevEnd = null;
      for (const it of r.items) {
        if (prevEnd !== null) {
          const gap = it.x - prevEnd;
          if (gap > 8) line += ' | ';
          else if (gap > 0.8 && !/\s$/.test(line) && !/^\s/.test(it.s)) line += ' ';
        }
        line += it.s;
        prevEnd = it.x + it.w;
      }
      return line.replace(/[ \t]+/g, ' ').replace(/ \| (?:\| )+/g, ' | ').trim();
    }).filter(l => l && l !== '|');
    pages.push({ page: p, text: lines.join('\n') });
  }
  return pages;
}

function splitLong(text, max) {
  if (text.length <= max) return [text];
  const lines = text.split('\n');
  const parts = [];
  let cur = '';
  for (const ln of lines) {
    if (cur.length + ln.length + 1 > max && cur) { parts.push(cur); cur = ''; }
    cur += (cur ? '\n' : '') + ln;
  }
  if (cur) parts.push(cur);
  return parts;
}


/* ── PDF를 이미지로 읽기 (표가 복잡할 때 가장 정확한 방식) ── */

// 쪽을 PNG로 그려서 돌려줍니다. @napi-rs/canvas가 없으면 null을 돌려주고 글자 방식으로 대신합니다.
async function openPdfForRender(buffer) {
  let cv;
  try { cv = require('@napi-rs/canvas'); } catch (e) { return null; }
  globalThis.DOMMatrix = globalThis.DOMMatrix || cv.DOMMatrix;
  globalThis.Path2D = globalThis.Path2D || cv.Path2D;
  globalThis.ImageData = globalThis.ImageData || cv.ImageData;
  const pdfjs = require('pdfjs-dist/legacy/build/pdf.js');
  class Factory {
    create(w, h) { const canvas = cv.createCanvas(w, h); return { canvas, context: canvas.getContext('2d') }; }
    reset(c, w, h) { c.canvas.width = w; c.canvas.height = h; }
    destroy(c) { c.canvas.width = 0; c.canvas.height = 0; }
  }
  const doc = await pdfjs.getDocument({
    data: new Uint8Array(buffer), useSystemFonts: true, disableFontFace: true, isEvalSupported: false, canvasFactory: new Factory(), ...PDF_ASSETS,
  }).promise;
  return {
    numPages: doc.numPages,
    async renderPng(n) {
      const page = await doc.getPage(n);
      const vp = page.getViewport({ scale: 2 });
      const f = new Factory().create(Math.ceil(vp.width), Math.ceil(vp.height));
      await page.render({ canvasContext: f.context, viewport: vp, canvasFactory: new Factory() }).promise;
      return f.canvas.encode('png');
    },
  };
}

const VISION_PROMPT = `이 이미지는 보험사 상품 비교 자료의 한 페이지입니다. 페이지의 모든 글과 숫자를 빠짐없이, 정확하게 옮겨 적으세요.
규칙:
- 표는 열(보험사/상품) 기준으로 풀어서 "보험사 / 상품명 / 항목명: 값 / 항목명: 값" 형태의 목록으로 쓰세요. 병합된 칸이나 여러 줄로 된 칸은 해당하는 모든 열에 값을 연결하고, 남/여, 연령(30세·40세·50세), 일반심사/간편심사, 보증형/미보증형 같은 구분을 값 앞에 반드시 표시하세요.
- 숫자는 보이는 그대로(쉼표 포함) 옮기세요. 읽기 어려운 값은 추측하지 말고 (불명확)이라고 쓰세요.
- 제목, 기준 설명(예: 40세, 1억원, 20년납, 보험료 단위), 각주, 기준일도 모두 포함하세요.
- 색으로 강조된 값(예: 파란색 보험료)이 보이면 값 뒤에 (강조)를 붙이세요.
- 요약·평가·해석은 하지 말고 옮겨 적기만 하세요. 마크다운 글자만 출력하세요.`;

async function visionTranscribe(png, pageNo) {
  const r = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: process.env.VISION_MODEL || 'gpt-4.1-mini',
      temperature: 0,
      max_tokens: 4000,
      messages: [{
        role: 'user',
        content: [
          { type: 'text', text: `${VISION_PROMPT}\n(이 페이지 번호: ${pageNo})` },
          { type: 'image_url', image_url: { url: 'data:image/png;base64,' + Buffer.from(png).toString('base64'), detail: 'high' } },
        ],
      }],
    }),
  });
  if (!r.ok) throw new Error('이미지 읽기 실패: ' + (await r.text()).slice(0, 200));
  const data = await r.json();
  return String(data.choices?.[0]?.message?.content || '').trim();
}

function pagesToEntries(pages, title, type = '표자료') {
  const entries = [];
  for (const p of pages) {
    if (p.text.replace(/\s/g, '').length < 40) continue;
    const parts = splitLong(p.text, 1800);
    const head = p.text.split('\n').find(l => l.trim()) || '';
    parts.forEach((t, i) => entries.push({
      topic: `${title} p.${p.page}${parts.length > 1 ? `-${i + 1}` : ''} — ${head.replace(/[#*]/g, '').trim().slice(0, 80)}`,
      type, content: t, page: p.page,
    }));
  }
  return entries;
}

async function runPdfVisionJob(job, { buffer, sourceName, title, notice, userId }) {
  try {
    job.status = 'learning';
    const textPages = await extractPdfPages(buffer);
    const renderer = await openPdfForRender(buffer);
    job.total = textPages.length;
    if (!renderer) job.log.push('이미지 변환 도구를 쓸 수 없어 글자 방식으로 대신 읽습니다.');
    const pages = [];
    for (const tp of textPages) {
      if (job.cancel) break;
      if (tp.text.replace(/\s/g, '').length < 40) { job.skipped++; job.done++; continue; } // 표지·마지막 쪽
      let text = tp.text;
      if (renderer) {
        try {
          const png = await renderer.renderPng(tp.page);
          const t = await visionTranscribe(png, tp.page);
          if (t.length > 60) text = t; else job.log.push(`p.${tp.page}: 이미지 결과가 짧아 글자 방식으로 대신했습니다.`);
        } catch (e) {
          job.failed++; job.log.push(`p.${tp.page}: ${e.message} (글자 방식으로 대신)`);
        }
      }
      pages.push({ page: tp.page, text });
      job.done++;
    }
    if (job.cancel) { job.status = 'cancelled'; return; }
    const entries = pagesToEntries(pages, title);
    if (!entries.length) { job.status = 'error'; job.message = '저장할 내용이 없습니다.'; return; }
    const r = await saveDoc({ sourceType: 'file', sourceName, title, url: null, notice, mode: 'data', entries, userId });
    job.learned = 1; job.notes = r.saved; job.status = 'done';
  } catch (e) {
    console.error('PDF 이미지 학습 오류:', e);
    job.status = 'error'; job.message = e.message;
  } finally {
    job.log = job.log.slice(0, 4).concat(job.log.slice(4).slice(-30));
  }
}

/* ───────────────────────── 네이버 블로그 ───────────────────────── */

function parseBlogId(input) {
  const s = String(input || '').trim();
  const m = s.match(/blog\.naver\.com\/(?:PostList\.naver\?blogId=)?([A-Za-z0-9_\-]+)/i) || s.match(/^([A-Za-z0-9_\-]+)$/);
  return m ? m[1] : null;
}


// 응답이 JSON이든 깨진 JSON이든 상관없이 "logNo"가 들어 있는 객체마다 번호와 제목을 뽑습니다.
function parseLogNos(text) {
  const out = [];
  const re = /"logNo"\s*:\s*"?(\d{6,})"?/g;
  let m;
  while ((m = re.exec(text))) {
    const start = text.lastIndexOf('{', m.index);
    let end = text.indexOf('}', m.index);
    if (end < 0) end = Math.min(text.length, m.index + 2000);
    const seg = text.slice(Math.max(0, start), end + 1);
    const t = (seg.match(/"(?:titleWithInspectMessage|title)"\s*:\s*"((?:[^"\\]|\\.)*)"/) || [])[1] || '';
    out.push({ no: m[1], title: t });
  }
  return out;
}
const snip = (t) => String(t || '').replace(/\s+/g, ' ').slice(0, 160);

// 글 목록 읽기: 여러 방식을 차례로 시도하고, 각 방식의 결과를 diag에 남깁니다.
// (네이버가 한 방식을 막거나 형식을 바꿔도 다른 방식으로 이어가도록)
async function listBlogPosts(blogId, maxPosts, diag = []) {
  const posts = [];
  const seen = new Set();
  const add = (no, title) => {
    if (!no || seen.has(no) || posts.length >= maxPosts) return false;
    seen.add(no);
    posts.push({ logNo: String(no), title: decodeEntities(String(title || '').trim()) });
    return true;
  };
  const dec = (t) => { try { return decodeURIComponent(String(t).replace(/\+/g, ' ')); } catch (e) { return String(t); } };

  // 방식 1: PostTitleListAsync (PC 글 목록)
  {
    let n = 0, status = '';
    for (let page = 1; posts.length < maxPosts && page <= 80; page++) {
      const r = await fetchText(`https://blog.naver.com/PostTitleListAsync.naver?blogId=${blogId}&viewdate=&currentPage=${page}&categoryNo=0&parentCategoryNo=&countPerPage=30`,
        { headers: { Referer: `https://blog.naver.com/${blogId}` } });
      status = r.ok ? 'OK' : `HTTP ${r.status} ${r.error || ''}`;
      if (!r.ok) break;
      let added = 0;
      for (const it of parseLogNos(r.text)) {
        if (add(it.no, dec(it.title.replace(/\\"/g, '"')))) { added++; n++; }
      }
      if (page === 1 && !added) status = '형식 불명: ' + snip(r.text);
      if (!added) break;
      await sleep(400);
    }
    diag.push(`목록 방식1(PC): ${status}, ${n}건`);
  }

  // 방식 2: 모바일 블로그 API
  if (posts.length < maxPosts) {
    let n = 0, status = '';
    for (let page = 1; posts.length < maxPosts && page <= 80; page++) {
      const r = await fetchText(`https://m.blog.naver.com/api/blogs/${blogId}/post-list?categoryNo=0&itemCount=30&page=${page}`,
        { headers: { Referer: `https://m.blog.naver.com/${blogId}`, Accept: 'application/json' } });
      status = r.ok ? 'OK' : `HTTP ${r.status} ${r.error || ''}`;
      if (!r.ok) break;
      let added = 0;
      for (const it of parseLogNos(r.text)) {
        if (add(it.no, dec(it.title.replace(/\\"/g, '"')))) { added++; n++; }
      }
      if (page === 1 && !added) status = '형식 불명: ' + snip(r.text);
      if (!added) break;
      await sleep(400);
    }
    diag.push(`목록 방식2(모바일): ${status}, ${n}건`);
  }

  // 방식 3: RSS (최근 글 50건 안팎)
  if (posts.length < maxPosts) {
    let n = 0;
    const r = await fetchText(`https://rss.blog.naver.com/${blogId}.xml`);
    if (r.ok) {
      for (const it of r.text.split('<item>').slice(1)) {
        const link = (it.match(/<link>\s*(?:<!\[CDATA\[)?\s*([^<\]\s]+)/) || [])[1] || '';
        const no = (link.match(/\/(\d{6,})/) || [])[1];
        const title = (it.match(/<title>\s*(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?\s*<\/title>/) || [])[1] || '';
        if (add(no, title)) n++;
      }
    }
    diag.push(`목록 방식3(RSS): ${r.ok ? 'OK' : 'HTTP ' + r.status}, ${n}건`);
  }
  return posts;
}

function extractNaverPost(html) {
  let body = html;
  const i = html.indexOf('se-main-container');
  if (i >= 0) {
    body = html.slice(i);
    body = body.slice(body.indexOf('>') + 1); // 'se-main-container"' 태그의 나머지 부분 제거
    const j = body.search(/id="printPost1"|class="wrap_rabbit|class="comment_area|class="post_footer|se-viewer-footer|class="area_sympathy/);
    if (j > 0) body = body.slice(0, Math.max(0, body.lastIndexOf('<', j)));
  } else {
    const k = html.indexOf('id="postViewArea"');
    if (k >= 0) body = html.slice(k);
  }
  return htmlToText(body);
}

async function fetchBlogPost(blogId, logNo) {
  const url = `https://blog.naver.com/PostView.naver?blogId=${blogId}&logNo=${logNo}&redirect=Dlog&widgetTypeCall=true&noTrackingCode=true&directAccess=false`;
  const r = await fetchText(url);
  if (!r.ok) return { ok: false, error: `HTTP ${r.status} ${r.error || ''}` };
  const text = extractNaverPost(r.text);
  return { ok: text.length >= 120, text, error: text.length < 120 ? '본문을 읽지 못했습니다(내용이 너무 짧음).' : null };
}

const jobs = new Map();
let jobSeq = 0;

// 약관 PDF: 올리기만 먼저 받고, 검색용 숫자 변환·저장은 서버 안에서 따로 진행합니다 (긴 요청이 끊기지 않도록).
const termsInFlight = new Set();
async function runTermsJob(job, { pages, sourceName, title, notice, userId, key, company }) {
  try {
    const entries = pagesToEntries(pages, company ? `${company} ${title}` : title, '약관원문');
    if (!entries.length) { job.status = 'error'; job.message = '저장할 내용이 없습니다.'; return; }
    job.total = entries.length;
    console.log(`[지식] 약관 처리 시작: ${title} (${pages.length}쪽, ${entries.length}조각)`);
    const r = await saveDoc({
      sourceType: 'terms', sourceName, title, url: null, notice, mode: 'data', entries, userId, company,
      onProgress: (d) => { job.done = d; },
    });
    job.learned = 1; job.notes = r.saved; job.done = job.total; job.status = 'done';
    console.log(`[지식] 약관 저장 완료: ${title} (${r.saved}조각)`);
  } catch (e) {
    job.status = 'error'; job.message = e.message;
    console.error('[지식] 약관 저장 오류:', title, e.message);
  } finally {
    termsInFlight.delete(key);
  }
}

async function runBlogJob(job, { blogId, maxPosts, sourceName, userId }) {
  try {
    job.status = 'listing';
    const diag = [];
    const posts = await listBlogPosts(blogId, maxPosts, diag);
    job.log.push(...diag);
    job.total = posts.length;
    if (!posts.length) { job.status = 'error'; job.message = '글 목록을 가져오지 못했습니다. 블로그 주소/아이디를 확인하세요.'; return; }
    job.status = 'learning';
    for (const p of posts) {
      if (job.cancel) break;
      const url = `https://blog.naver.com/${blogId}/${p.logNo}`;
      try {
        if (await docExists(url)) { job.skipped++; job.done++; continue; }
        const post = await fetchBlogPost(blogId, p.logNo);
        if (!post.ok) { job.failed++; job.log.push(`읽기 실패: ${p.title} (${post.error})`); job.done++; await sleep(500); continue; }
        const res = await learnFromText({ sourceType: 'blog', sourceName, title: p.title || `글 ${p.logNo}`, url, text: post.text, userId });
        if (res.skipped) { job.skipped++; if (res.reason && !/이미/.test(res.reason)) job.log.push(`제외: ${p.title} (${res.reason})`); }
        else { job.learned++; job.notes += res.saved; }
      } catch (e) {
        job.failed++; job.log.push(`오류: ${p.title} (${e.message})`);
      }
      job.done++;
      await sleep(700);
    }
    job.status = job.cancel ? 'cancelled' : 'done';
  } catch (e) {
    job.status = 'error'; job.message = e.message;
  } finally {
    job.log = job.log.slice(0, 4).concat(job.log.slice(4).slice(-30));
  }
}

/* ───────────────────────── 유튜브 (가능한 경우만 자동) ───────────────────────── */

function parseYoutubeId(input) {
  const m = String(input || '').match(/(?:v=|youtu\.be\/|shorts\/|embed\/)([A-Za-z0-9_\-]{11})/);
  return m ? m[1] : null;
}

async function fetchYoutubeInfo(videoId) {
  const r = await fetchText(`https://www.youtube.com/watch?v=${videoId}&hl=ko`, { timeout: 20000 });
  if (!r.ok) return { ok: false, error: `HTTP ${r.status}` };
  const m = r.text.match(/ytInitialPlayerResponse\s*=\s*(\{[\s\S]*?\});\s*(?:var|<\/script>)/);
  if (!m) return { ok: false, error: '영상 정보를 읽지 못했습니다.' };
  let pr;
  try { pr = JSON.parse(m[1]); } catch (e) { return { ok: false, error: '영상 정보 해석 실패' }; }
  const title = pr.videoDetails?.title || '';
  const description = pr.videoDetails?.shortDescription || '';
  const tracks = pr.captions?.playerCaptionsTracklistRenderer?.captionTracks || [];
  const track = tracks.find(t => t.languageCode === 'ko') || tracks[0];
  let transcript = '';
  if (track?.baseUrl) {
    const t = await fetchText(track.baseUrl + '&fmt=json3', { timeout: 20000 });
    if (t.ok && t.text) {
      try {
        const j = JSON.parse(t.text);
        transcript = (j.events || []).map(ev => (ev.segs || []).map(s => s.utf8).join('')).join(' ').replace(/\s+/g, ' ').trim();
      } catch (e) { /* 자막 없음 */ }
    }
  }
  return { ok: true, title, description, transcript };
}

/* ───────────────────────── 관리자 라우터 ───────────────────────── */

const router = express.Router();
const upload = multer({ limits: { fileSize: 40 * 1024 * 1024 } });

router.get('/sources', async (req, res) => {
  const r = await pool.query(
    `SELECT d.source_name, d.source_type, d.mode, COUNT(DISTINCT d.id)::int AS docs,
            COUNT(c.id)::int AS entries, MAX(d.created_at) AS latest
     FROM knowledge_docs d LEFT JOIN knowledge_chunks c ON c.doc_id = d.id
     GROUP BY d.source_name, d.source_type, d.mode ORDER BY MAX(d.created_at) DESC`
  );
  res.json({ items: r.rows });
});

router.delete('/source', async (req, res) => {
  const name = String(req.query.name || '');
  if (!name) return res.status(400).json({ error: '자료 이름이 필요합니다.' });
  await pool.query('DELETE FROM knowledge_docs WHERE source_name = $1', [name]);
  invalidateCache();
  res.json({ ok: true });
});

// 학습된 노트 훑어보기 (확인용)
router.get('/notes', async (req, res) => {
  const name = String(req.query.name || '');
  const r = await pool.query(
    `SELECT c.topic, c.note_type, c.content, c.page, d.title, d.url
     FROM knowledge_chunks c JOIN knowledge_docs d ON d.id = c.doc_id
     WHERE d.source_name = $1 ORDER BY d.id DESC, c.id LIMIT 40`, [name]
  );
  res.json({ items: r.rows });
});

// 검색 시험 (질문을 넣으면 어떤 노트가 찾아지는지 확인)
router.get('/search', async (req, res) => {
  try {
    const qs = String(req.query.q || '');
    const company = detectCompany(qs);
    const hits = await search(qs, company ? 8 : 6, 0.2, { company });
    res.json({ company, items: hits.map(h => ({ score: h.score, source: h.sourceName, title: h.title, topic: h.topic, preview: h.content.slice(0, 200) })) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// 글/대본 붙여넣기 → 읽고 정리해서 학습
router.post('/text', async (req, res) => {
  const { sourceName, title, url, content } = req.body || {};
  if (!sourceName || !title || !content || String(content).trim().length < 100) {
    return res.status(400).json({ error: '자료 이름, 제목, 내용(100자 이상)을 입력해주세요.' });
  }
  try {
    const r = await learnFromText({
      sourceType: /youtu/i.test(url || '') ? 'youtube' : 'text',
      sourceName: String(sourceName).trim(), title: String(title).trim(), url: url ? String(url).trim() : null,
      text: String(content), userId: req.userId,
    });
    res.json({ ok: true, ...r });
  } catch (e) { console.error('학습 오류:', e); res.status(500).json({ error: e.message }); }
});

// PDF → (표·숫자 자료) 페이지별로 그대로 보관, 또는 (글 위주) 읽고 정리
router.post('/pdf', upload.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: '파일을 선택해주세요.' });
  const sourceName = String(req.body.sourceName || '').trim();
  const isTerms = req.body.docType === 'terms'; // 약관 원문: 글자만 읽어 쪽별로 그대로 보관 (요약·변형 없음)
  const company = String(req.body.company || '').trim().slice(0, 40) || null;
  const mode = req.body.mode === 'notes' && !isTerms ? 'notes' : 'data'; // 'vision'은 아래에서 따로 처리
  if (!sourceName) return res.status(400).json({ error: '자료 이름을 입력해주세요.' });
  try {
    if (req.body.skipExisting === '1' && req.body.title) {
      const ex = await pool.query('SELECT 1 FROM knowledge_docs WHERE source_name = $1 AND title = $2 LIMIT 1', [sourceName, String(req.body.title).slice(0, 300)]);
      if (ex.rows.length) return res.json({ ok: true, skipped: true, reason: '이미 올린 파일입니다.' });
    }
    const pages = await extractPdfPages(req.file.buffer);
    const total = pages.reduce((n, p) => n + p.text.length, 0);
    if (total < 200) return res.status(422).json({ error: '글자를 거의 읽지 못했습니다. 사진/스캔 PDF는 지원하지 않습니다.' });
    const title = String(req.body.title || req.file.originalname || sourceName).slice(0, 200);
    let notice = String(req.body.notice || '').trim();
    if (!notice && /사내\s*교육용/.test(pages.slice(0, 3).map(p => p.text).join(' '))) {
      notice = '사내 교육용 자료입니다. 보험 안내자료로 사용하거나 외부에 공유할 수 없습니다. 고객 안내는 가입설계서·상품설명서·약관 기준으로 하세요.';
    }
    if (isTerms) {
      const key = `${sourceName}|${title}`;
      if (termsInFlight.has(key)) return res.json({ ok: true, skipped: true, reason: '이미 처리 중인 파일입니다.' });
      termsInFlight.add(key);
      const id = String(++jobSeq);
      const job = { id, status: 'learning', total: 0, done: 0, learned: 0, notes: 0, skipped: 0, failed: 0, log: [], message: '', pages: pages.length };
      jobs.set(id, job);
      runTermsJob(job, { pages, sourceName, title, notice, userId: req.userId, key, company });
      return res.json({ ok: true, jobId: id, pages: pages.length });
    }
    if (req.body.mode === 'vision' && !isTerms) {
      const id = String(++jobSeq);
      const job = { id, status: 'starting', total: pages.length, done: 0, learned: 0, notes: 0, skipped: 0, failed: 0, log: [], message: '' };
      jobs.set(id, job);
      runPdfVisionJob(job, { buffer: req.file.buffer, sourceName, title, notice, userId: req.userId });
      return res.json({ ok: true, jobId: id, mode: 'vision', pages: pages.length, notice: notice || null });
    }
    if (mode === 'notes') {
      const r = await learnFromText({ sourceType: 'file', sourceName, title, url: null, text: pages.map(p => p.text).join('\n\n'), notice, userId: req.userId });
      return res.json({ ok: true, mode, ...r });
    }
    const entries = pagesToEntries(pages, title, isTerms ? '약관원문' : '표자료');
    const r = await saveDoc({ sourceType: isTerms ? 'terms' : 'file', sourceName, title, url: null, notice, mode: 'data', entries, userId: req.userId });
    res.json({ ok: true, mode, pages: pages.length, saved: r.saved, notice: notice || null });
  } catch (e) { console.error('PDF 학습 오류:', e); res.status(500).json({ error: e.message }); }
});

// 블로그: 시험(1건 읽고 정리 결과만 보여줌, 저장 안 함)
router.post('/blog/test', async (req, res) => {
  const blogId = parseBlogId(req.body?.blog);
  if (!blogId) return res.status(400).json({ error: '블로그 주소나 아이디를 확인해주세요.' });
  try {
    const diag = [];
    const posts = await listBlogPosts(blogId, 5, diag);
    if (!posts.length) return res.json({ ok: false, message: '글 목록을 가져오지 못했습니다. (서버에서 네이버 접속이 막혔거나 주소가 틀렸을 수 있습니다) ' + diag.join(' / ') });
    let first = null;
    for (const p of posts) {
      const post = await fetchBlogPost(blogId, p.logNo);
      if (post.ok) { first = { title: p.title, chars: post.text.length, preview: post.text.slice(0, 300), post }; break; }
    }
    if (!first) return res.json({ ok: false, listed: posts.length, titles: posts.map(p => p.title), message: '글 목록은 읽었지만 본문을 읽지 못했습니다.' });
    const notes = await distill(first.title, first.post.text);
    res.json({ ok: true, listed: posts.length, titles: posts.map(p => p.title), sample: { title: first.title, chars: first.chars, preview: first.preview }, notes });
  } catch (e) { console.error('블로그 시험 오류:', e); res.status(500).json({ error: e.message }); }
});

// 페이지 안의 링크(주소·onclick)와 .do/.ajax 같은 요청 주소를 뽑아 사이트 구조를 파악합니다.
function extractLinks(html, baseUrl) {
  const links = [];
  const seenKey = new Set();
  const re = /<a\b([^>]*)>([\s\S]*?)<\/a>/gi;
  let m;
  while ((m = re.exec(html)) && links.length < 400) {
    const attrs = m[1];
    const href = (attrs.match(/href\s*=\s*(["'])([\s\S]*?)\1/i) || [])[2] || '';
    const onclick = (attrs.match(/onclick\s*=\s*(["'])([\s\S]*?)\1/i) || [])[2] || '';
    const text = m[2].replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 40);
    if (!href && !onclick) continue;
    let abs = href;
    if (href && !/^(javascript:|#|mailto:|tel:)/i.test(href)) { try { abs = new URL(href, baseUrl).href; } catch (e) { /* 그대로 */ } }
    const key = `${text}|${abs}|${onclick.slice(0, 120)}`;
    if (seenKey.has(key)) continue;
    seenKey.add(key);
    links.push({ key, text, href: abs, onclick: onclick.slice(0, 120) });
  }
  const endpoints = [...new Set((html.match(/["'][^"'\s]{2,120}\.(?:do|ajax|jsp|asp|aspx|json)(?:\?[^"'\s]{0,60})?["']/gi) || []).map(x => x.slice(1, -1)))].slice(0, 60);
  return { links, endpoints };
}

// 약관 공시실 접속 시험: 서버가 외부 사이트를 열 수 있는지(차단 여부·형식)만 확인합니다. 저장하지 않습니다.
router.post('/probe', async (req, res) => {
  const urls = (Array.isArray(req.body?.urls) ? req.body.urls : []).map(u => String(u).trim()).filter(Boolean).slice(0, 10);
  if (!urls.length) return res.status(400).json({ error: '주소를 한 줄에 하나씩 입력해주세요.' });
  const out = [];
  for (const u of urls) {
    let host = '';
    try { const x = new URL(u); host = x.hostname; if (!/^https?:$/.test(x.protocol)) throw new Error('x'); } catch (e) { out.push({ url: u, ok: false, note: '주소 형식이 올바르지 않습니다.' }); continue; }
    if (/^(localhost|127\.|10\.|192\.168\.|169\.254\.|172\.(1[6-9]|2\d|3[01])\.)/i.test(host) || !host.includes('.')) { out.push({ url: u, ok: false, note: '내부 주소는 시험할 수 없습니다.' }); continue; }
    const t0 = Date.now();
    const r = await fetchText(u, { timeout: 15000 });
    const text = r.text || '';
    let struct = null;
    if (req.body?.links) {
      struct = extractLinks(text, u);
      // 사이트 첫 화면의 공통 메뉴 링크는 빼고, 이 화면에만 있는 링크를 보여줍니다.
      try {
        const o = new URL(u);
        if (o.pathname.length > 1 || o.search) {
          const home = await fetchText(o.origin + '/', { timeout: 15000 });
          if (home.ok) {
            const common = new Set(extractLinks(home.text, o.origin + '/').links.map(l => l.key));
            struct.links = struct.links.filter(l => !common.has(l.key));
            struct.commonRemoved = true;
          }
        }
      } catch (e) { /* 그대로 */ }
      struct.fileLike = struct.links.filter(l => /down|file|pdf|attach|fileSeq|약관|요약서|사업방법서/i.test(`${l.href} ${l.onclick} ${l.text}`));
    }
    out.push({
      ...(struct ? { links: struct.links, endpoints: struct.endpoints, fileLike: struct.fileLike, commonRemoved: !!struct.commonRemoved } : {}),
      url: u, ok: r.ok, status: r.status, error: r.error || null, ms: Date.now() - t0, chars: text.length,
      pdf: text.startsWith('%PDF'),
      pdfLinks: (text.match(/\.pdf/gi) || []).length,
      hints: ['captcha', '보안문자', '자동입력방지', 'Access Denied', 'Forbidden', '로그인'].filter(k => text.toLowerCase().includes(k.toLowerCase())),
      preview: text.replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/gi, ' ').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 150),
    });
    await sleep(300);
  }
  res.json({ items: out });
});

// 보험사 공시실 일괄 진단: 회사별로 열리는지, 약관 파일 링크가 보이는지, 동적 화면인지 한 번에 점검합니다(저장 안 함).
async function runDiagnoseJob(job, companies) {
  job.status = 'running'; job.total = companies.length; job.results = [];
  for (const c of companies) {
    if (job.cancel) break;
    const row = { name: c.name, url: c.url };
    try {
      const t0 = Date.now();
      const r = await fetchText(c.url, { timeout: 20000 });
      const html = r.text || '';
      row.ok = !!r.ok; row.status = r.status || 0; row.error = r.error || null; row.ms = Date.now() - t0; row.chars = html.length;
      const s = extractLinks(html, c.url);
      row.links = s.links.length;
      row.pdfLinks = (html.match(/\.pdf/gi) || []).length;
      row.fileLike = s.links.filter(l => /down|file|pdf|attach|fileSeq|약관|요약서|사업방법서/i.test(`${l.href} ${l.onclick} ${l.text}`)).length;
      row.endpoints = s.endpoints.length;
      row.sample = s.links.filter(l => /약관|pdf|down/i.test(`${l.href} ${l.onclick} ${l.text}`)).slice(0, 3).map(l => `${l.text || '-'} → ${l.href || l.onclick}`.slice(0, 160));
      row.textLen = html.replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/gi, ' ').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().length;
      row.hints = ['captcha', '보안문자', '자동입력방지', 'access denied', 'forbidden'].filter(k => html.toLowerCase().includes(k));
      // 판정: 열림 + 파일 링크가 보임 → 자동 수집 가능성 높음 / 열리지만 링크 없음 → 동적(화면이 JS로 그려짐) / 실패 → 막힘
      if (job.detail) {
        const fl = s.links.filter(l => /down|file|pdf|attach|fileSeq|약관|요약서|사업방법서/i.test(`${l.href} ${l.onclick} ${l.text}`) && !/이용약관|개인정보|전자금융|홈페이지/.test(l.text));
        row.files = fl.slice(0, 10).map(l => `${l.text || '-'} → ${l.href || ''}${l.onclick ? ' | ' + l.onclick : ''}`.slice(0, 260));
        row.endpointList = s.endpoints.slice(0, 15);
        row.pdfUrls = [...new Set(html.match(/[^"'\s<>()]{4,200}\.pdf/gi) || [])].slice(0, 6);
        row.scripts = [...new Set((html.match(/<script[^>]+src=["'][^"']+["']/gi) || []).map(x => (x.match(/src=["']([^"']+)/) || [])[1]))].filter(x => x && !/jquery|google|gtag|analytics|kakao|naver|facebook|polyfill|bootstrap/i.test(x)).slice(0, 10);
        row.apiHints = [...new Set((html.match(/["'](\/[\w\-\/.]*(?:api|ajax|list|search|json|prod|Prod|gongsi|disclosure)[\w\-\/.?=&]*)["']/g) || []).map(x => x.slice(1, -1)))].slice(0, 15);
      }
      row.verdict = !row.ok ? '막힘' : (row.pdfLinks > 0 || row.fileLike > 0) ? '자동수집 가능성 높음' : (row.links > 5 ? '링크는 있으나 파일 없음(2단계 필요)' : '동적 화면(추가 분석 필요)');
    } catch (e) { row.ok = false; row.error = e.message; row.verdict = '막힘'; }
    job.results.push(row); job.done = job.results.length;
    await sleep(300);
  }
  job.status = job.cancel ? 'cancelled' : 'done';
}

router.post('/diagnose', (req, res) => {
  const list = (Array.isArray(req.body?.companies) ? req.body.companies : []).slice(0, 60)
    .map(c => ({ name: String(c?.name || '').trim().slice(0, 40), url: String(c?.url || '').trim() }))
    .filter(c => {
      if (!c.name) return false;
      try { const x = new URL(c.url); return /^https?:$/.test(x.protocol) && x.hostname.includes('.') && !/^(localhost|127\.|10\.|192\.168\.|169\.254\.|172\.(1[6-9]|2\d|3[01])\.)/i.test(x.hostname); } catch (e) { return false; }
    });
  if (!list.length) return res.status(400).json({ error: '진단할 주소가 없습니다.' });
  const id = String(++jobSeq);
  const job = { id, status: 'starting', total: list.length, done: 0, results: [], log: [], message: '', detail: !!req.body?.detail };
  jobs.set(id, job);
  runDiagnoseJob(job, list);
  res.json({ ok: true, jobId: id });
});


/* ───────────────────────── 보험사 약관 자동 수집 ───────────────────────── */

async function fetchBuffer(url, opts = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), opts.timeout || 90000);
  try {
    const r = await fetch(url, { signal: ctrl.signal, redirect: 'follow', headers: { 'User-Agent': UA, 'Accept-Language': 'ko-KR,ko;q=0.9', ...(opts.headers || {}) } });
    const buf = Buffer.from(await r.arrayBuffer());
    return { ok: r.ok, status: r.status, buf, type: r.headers.get('content-type') || '' };
  } catch (e) { return { ok: false, status: 0, buf: Buffer.alloc(0), error: e.message }; }
  finally { clearTimeout(timer); }
}
const isPdfBuf = (b) => b && b.length > 1000 && b.subarray(0, 1024).toString('latin1').includes('%PDF');

// 약관 이름으로 분류 추정
function guessCategory(title) {
  const t = String(title || '');
  const rules = [['변액연금', /변액.*연금|연금.*변액/], ['변액보험', /변액/], ['일반연금', /연금/], ['종신보험', /종신/], ['정기보험', /정기/],
    ['암보험', /암/], ['어린이보험', /어린이|자녀|태아|키즈/], ['간병·치매보험', /간병|치매/], ['실손의료보험', /실손|실비/],
    ['저축보험', /저축|적립|교육/], ['건강·질병보험', /건강|질병|CI|상해|의료|입원|수술|치아|운전자|여행/]];
  for (const [name, re] of rules) if (re.test(t)) return name;
  return '기타';
}

const absUrl = (href, base) => { try { return new URL(decodeEntities(href), base).href; } catch (e) { return null; } };
const cleanName = (s) => decodeEntities(String(s || '')).replace(/<[^>]+>/g, ' ').replace(/\.pdf$/i, '').replace(/\s+/g, ' ').trim();

// 보험사별 수집기: list()는 [{title, url, headers?}]를 돌려줍니다 (약관 PDF만).
const COLLECTORS = {
  '메트라이프생명': {
    async list() {
      const base = 'https://brand.metlife.co.kr/pn/mcvrgProd/retrieveMcvrgProdMain.do';
      const r = await fetchText(base, { timeout: 40000 });
      if (!r.ok) throw new Error(`목록 화면을 열지 못했습니다 (HTTP ${r.status} ${r.error || ''})`);
      // 파일 구분: fnum=03 이 약관. 같은 상품(insProdSeq)은 가장 최신 판(seq가 큰 것)만 사용.
      const re = /<a\b[^>]*href\s*=\s*["']([^"']*mcvrgProdDownloadFile\.do\?[^"']*)["'][^>]*>([\s\S]*?)<\/a>/gi;
      const best = new Map();
      let m;
      while ((m = re.exec(r.text))) {
        const href = decodeEntities(m[1]);
        const q = new URLSearchParams(href.split('?')[1] || '');
        if (q.get('fnum') !== '03') continue;
        const prod = q.get('insProdSeq'), seq = Number(q.get('seq')) || 0;
        const title = cleanName(m[2]) || `메트라이프 약관 ${prod}-${seq}`;
        const cur = best.get(prod);
        if (!cur || seq > cur.seq) best.set(prod, { seq, title, url: absUrl(href, base), headers: { Referer: base } });
      }
      return [...best.values()].filter(x => x.url);
    },
  },
  'AIA생명': {
    async list() {
      const base = 'https://mypage.aia.co.kr/AIAHomepage/disclosure/our-products/selling/individual.do';
      const r = await fetchText(base, { timeout: 40000 });
      if (!r.ok) throw new Error(`목록 화면을 열지 못했습니다 (HTTP ${r.status} ${r.error || ''})`);
      const out = [], seen = new Set();
      const re = /downLoad\(\s*['"]([^'"]+)['"]\s*,\s*['"]([^'"]*)['"]\s*\)/g;
      let m;
      while ((m = re.exec(r.text))) {
        const server = m[1], name = cleanName(m[2]);
        if (!/약관/.test(name) || /운용설명서|사업방법서|상품요약서/.test(name) || seen.has(server)) continue;
        seen.add(server);
        out.push({ title: name, url: `https://mypage.aia.co.kr/AIAHomepage/disclosure/download.do?serverFileNm=${encodeURIComponent(server)}`, alt: `https://mypage.aia.co.kr/AIAHomepage/disclosure/download.do?serverFileNm=${encodeURIComponent(server)}&fileNm=${encodeURIComponent(m[2])}`, headers: { Referer: base } });
      }
      return out;
    },
  },
  '흥국화재': {
    async list() {
      const base = 'https://www.heungkukfire.co.kr/FRW/announce/insGoodsGongsiSale.do';
      const r = await fetchText(base, { timeout: 40000 });
      if (!r.ok) throw new Error(`목록 화면을 열지 못했습니다 (HTTP ${r.status} ${r.error || ''})`);
      const out = [], seen = new Set();
      const re = /fn_filedownX\(\s*['"]([^'"]*)['"]\s*,\s*['"]([^'"]*)['"]\s*,\s*['"]([^'"]*)['"]/g;
      let m;
      while ((m = re.exec(decodeEntities(r.text)))) {
        const dir = m[1], name = cleanName(m[2]), stored = m[3];
        if (!/약관/.test(name) || /여신|사업방법서|상품요약서/.test(name) || seen.has(stored)) continue;
        seen.add(stored);
        out.push({ title: name, url: `https://www.heungkukfire.co.kr${dir.startsWith('/') ? '' : '/'}${dir}${stored}`, headers: { Referer: base } });
      }
      return out;
    },
  },
};

async function downloadTerms(item) {
  let r = await fetchBuffer(item.url, { headers: item.headers });
  if (!isPdfBuf(r.buf) && item.alt) r = await fetchBuffer(item.alt, { headers: item.headers });
  return r;
}

// 수집 시험: 목록을 읽고 1건만 내려받아 PDF가 맞는지 확인합니다(저장 안 함).
router.post('/collect/test', async (req, res) => {
  const company = String(req.body?.company || '');
  const col = COLLECTORS[company];
  if (!col) return res.status(400).json({ error: '아직 이 보험사의 수집기가 없습니다.' });
  try {
    const items = await col.list();
    const out = { company, found: items.length, samples: items.slice(0, 5).map(x => `${x.title} → ${x.url}`) };
    if (items.length) {
      const r = await downloadTerms(items[0]);
      out.first = { title: items[0].title, status: r.status, bytes: r.buf.length, isPdf: isPdfBuf(r.buf), error: r.error || null, head: isPdfBuf(r.buf) ? '' : r.buf.subarray(0, 120).toString('utf8').replace(/\s+/g, ' ') };
      if (out.first.isPdf) {
        try { const pages = await extractPdfPages(r.buf); out.first.pages = pages.length; out.first.chars = pages.reduce((n, p) => n + p.text.length, 0); } catch (e) { out.first.extractError = e.message; }
      }
    }
    res.json(out);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

async function runCollectJob(job, { company, limit, userId }) {
  const col = COLLECTORS[company];
  try {
    job.status = 'listing';
    const items = await col.list();
    job.total = items.length;
    job.log.push(`목록 ${items.length}건을 찾았습니다.`);
    let handled = 0;
    for (const it of items) {
      if (job.cancel) break;
      const title = it.title.slice(0, 200);
      const ex = await pool.query('SELECT 1 FROM knowledge_docs WHERE company = $1 AND title = $2 LIMIT 1', [company, title]);
      if (ex.rows.length) { job.skipped++; job.done++; continue; }
      if (handled >= limit) break; // 이번 회차 한도. 다시 누르면 이어서 진행합니다.
      handled++;
      job.status = 'learning'; job.message = `${job.learned + 1}번째: ${title}`;
      try {
        const r = await downloadTerms(it);
        if (!isPdfBuf(r.buf)) throw new Error(`PDF가 아닙니다 (HTTP ${r.status}${r.error ? ' ' + r.error : ''}, 받은 내용: ${r.buf.subarray(0, 100).toString('utf8').replace(/\s+/g, ' ')}) 주소: ${it.url}`.slice(0, 400));
        if (r.buf.length > 60 * 1024 * 1024) throw new Error('파일이 너무 큽니다');
        const pages = await extractPdfPages(r.buf);
        const chars = pages.reduce((n, p) => n + p.text.length, 0);
        if (chars < 200) throw new Error('글자를 읽지 못했습니다(스캔본일 수 있음)');
        const entries = pagesToEntries(pages, `${company} ${title}`, '약관원문');
        const sv = await saveDoc({ sourceType: 'terms', sourceName: `약관 · ${company} · ${guessCategory(title)}`, title, url: null, notice: null, mode: 'data', entries, userId, company });
        job.learned++; job.notes += sv.saved; job.done++;
        job.log.push(`완료: ${title} (${pages.length}쪽, ${sv.saved}조각)`);
      } catch (e) {
        job.failed++; job.done++;
        job.log.push(`실패: ${title} (${e.message})`);
      }
      if (job.log.length > 80) job.log = job.log.slice(-60);
    }
    job.status = job.cancel ? 'cancelled' : 'done';
    job.message = job.status === 'done' && handled >= limit ? `이번 회차 ${limit}건까지 처리했습니다. 남은 약관은 다시 눌러 이어서 수집하세요.` : '';
  } catch (e) { job.status = 'error'; job.message = e.message; console.error('[수집] 오류:', company, e.message); }
}

router.post('/collect/start', (req, res) => {
  const company = String(req.body?.company || '');
  if (!COLLECTORS[company]) return res.status(400).json({ error: '아직 이 보험사의 수집기가 없습니다.' });
  const limit = Math.max(1, Math.min(Number(req.body?.limit) || 10, 50));
  const id = String(++jobSeq);
  const job = { id, status: 'starting', total: 0, done: 0, learned: 0, notes: 0, skipped: 0, failed: 0, log: [], message: '' };
  jobs.set(id, job);
  runCollectJob(job, { company, limit, userId: req.userId });
  res.json({ ok: true, jobId: id });
});

router.get('/collectors', (req, res) => res.json({ items: Object.keys(COLLECTORS) }));

// 이미 올려둔 약관에 보험사 지정 (자료 이름 기준)
router.post('/terms/company', async (req, res) => {
  const name = String(req.body?.sourceName || '');
  const company = String(req.body?.company || '').trim().slice(0, 40);
  if (!name || !company) return res.status(400).json({ error: '자료 이름과 보험사가 필요합니다.' });
  const newName = name.replace(/^약관\s*·\s*/, `약관 · ${company} · `).replace(new RegExp(`(${company.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} · )+`), `${company} · `);
  const r = await pool.query(`UPDATE knowledge_docs SET company = $1, source_name = $3 WHERE source_name = $2 AND source_type = 'terms'`, [company, name, newName]);
  invalidateCache();
  res.json({ ok: true, updated: r.rowCount, sourceName: newName });
});


// 사이트 화면·스크립트 안에서 다운로드 함수 등 글자를 찾아 앞뒤 내용을 보여줍니다(수집기를 만들기 위한 구조 파악용, 저장 안 함).
async function runFuncJob(job, targets) {
  job.status = 'running'; job.total = targets.length; job.results = [];
  for (const t of targets) {
    if (job.cancel) break;
    const row = { name: t.name, url: t.url, found: [], scripts: 0 };
    try {
      const page = await fetchText(t.url, { timeout: 25000 });
      if (!page.ok) { row.error = `페이지를 열지 못했습니다 (HTTP ${page.status} ${page.error || ''})`; job.results.push(row); job.done++; continue; }
      const docs = [{ src: '(화면 자체)', text: page.text }];
      const srcs = [...new Set((page.text.match(/<script[^>]+src=["'][^"']+["']/gi) || []).map(x => (x.match(/src=["']([^"']+)/) || [])[1]))]
        .map(x => absUrl(x, t.url)).filter(x => x && !/jquery|google|gtag|analytics|kakao|naver|facebook|polyfill|adobedtm|daumcdn|ruxit|nethru|bootstrap|html5|respond|css3/i.test(x)).slice(0, 25);
      for (const u of srcs) {
        const r = await fetchText(u, { timeout: 20000 });
        if (r.ok && r.text) docs.push({ src: u, text: r.text });
      }
      row.scripts = docs.length - 1;
      for (const term of t.terms) {
        const defRe = new RegExp(`(function\\s+${term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*\\(|${term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*[:=]\\s*function)`);
        let shown = 0;
        for (const d of docs) {
          const m = defRe.exec(d.text);
          if (m) { row.found.push({ term, src: d.src, snippet: d.text.slice(Math.max(0, m.index - 100), m.index + 900).replace(/\s+/g, ' ') }); shown++; break; }
        }
        if (!shown) {
          for (const d of docs) {
            const i = d.text.indexOf(term);
            if (i >= 0) { row.found.push({ term, src: d.src, snippet: d.text.slice(Math.max(0, i - 200), i + 600).replace(/\s+/g, ' ') }); shown++; break; }
          }
        }
        if (!shown) row.found.push({ term, src: '-', snippet: '(찾지 못함)' });
      }
    } catch (e) { row.error = e.message; }
    job.results.push(row); job.done++;
  }
  job.status = job.cancel ? 'cancelled' : 'done';
}

router.post('/probe/func', (req, res) => {
  const targets = (Array.isArray(req.body?.targets) ? req.body.targets : []).slice(0, 8).map(t => ({
    name: String(t?.name || '').slice(0, 40), url: String(t?.url || '').trim(),
    terms: (Array.isArray(t?.terms) ? t.terms : []).map(x => String(x).slice(0, 80)).filter(Boolean).slice(0, 6),
  })).filter(t => t.terms.length && /^https?:\/\//i.test(t.url));
  if (!targets.length) return res.status(400).json({ error: '조사할 주소와 찾을 글자가 필요합니다.' });
  const id = String(++jobSeq);
  const job = { id, status: 'starting', total: targets.length, done: 0, results: [], log: [], message: '' };
  jobs.set(id, job);
  runFuncJob(job, targets);
  res.json({ ok: true, jobId: id });
});

router.post('/blog/start', async (req, res) => {
  const blogId = parseBlogId(req.body?.blog);
  if (!blogId) return res.status(400).json({ error: '블로그 주소나 아이디를 확인해주세요.' });
  const maxPosts = Math.max(1, Math.min(Number(req.body?.maxPosts) || 100, 2000));
  const sourceName = String(req.body?.sourceName || `네이버 블로그 ${blogId}`).trim();
  const id = String(++jobSeq);
  const job = { id, status: 'starting', total: 0, done: 0, learned: 0, notes: 0, skipped: 0, failed: 0, log: [], message: '' };
  jobs.set(id, job);
  runBlogJob(job, { blogId, maxPosts, sourceName, userId: req.userId });
  res.json({ ok: true, jobId: id });
});

router.get('/jobs/:id', (req, res) => {
  const job = jobs.get(req.params.id);
  if (!job) return res.status(404).json({ error: '작업을 찾을 수 없습니다(서버가 다시 시작되었을 수 있습니다).' });
  res.json(job);
});

router.post('/jobs/:id/cancel', (req, res) => {
  const job = jobs.get(req.params.id);
  if (job) job.cancel = true;
  res.json({ ok: true });
});

// 유튜브: 주소만 주면 자막을 자동으로 시도, 안 되면 대본 붙여넣기를 안내
router.post('/youtube', async (req, res) => {
  const { url, sourceName, transcript } = req.body || {};
  const id = parseYoutubeId(url);
  if (!id) return res.status(400).json({ error: '유튜브 영상 주소를 확인해주세요.' });
  const name = String(sourceName || '유튜브').trim();
  try {
    const canonical = `https://www.youtube.com/watch?v=${id}`;
    if (await docExists(canonical)) return res.json({ ok: true, skipped: true, reason: '이미 학습한 영상입니다.' });
    let title = String(req.body.title || '').trim();
    let text = String(transcript || '').trim();
    if (!text) {
      const info = await fetchYoutubeInfo(id);
      if (!info.ok) return res.json({ ok: false, needTranscript: true, message: `영상 정보를 읽지 못했습니다(${info.error}). 영상의 "스크립트"를 복사해 붙여넣어 주세요.` });
      title = title || info.title;
      text = info.transcript;
      if (!text) return res.json({ ok: false, needTranscript: true, title, message: '자막을 자동으로 가져오지 못했습니다. 영상 아래 "더보기 → 스크립트 표시"에서 글을 복사해 붙여넣어 주세요.' });
    }
    const r = await learnFromText({ sourceType: 'youtube', sourceName: name, title: title || '유튜브 영상', url: canonical, text, userId: req.userId });
    res.json({ ok: true, title, ...r });
  } catch (e) { console.error('유튜브 학습 오류:', e); res.status(500).json({ error: e.message }); }
});

module.exports = { router, detectCompany, search, embedTexts, extractPdfPages, extractNaverPost, parseBlogId, parseYoutubeId, htmlToText, distill, saveDoc, learnFromText, invalidateCache };
