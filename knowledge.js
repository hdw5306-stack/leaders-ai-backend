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
    const text = await r.text();
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

/* ───────────────────────── 임베딩 / 검색 ───────────────────────── */

function normalize(vec) {
  let n = 0;
  for (const x of vec) n += x * x;
  n = Math.sqrt(n) || 1;
  return vec.map(x => x / n);
}

async function embedTexts(texts) {
  const out = [];
  for (let i = 0; i < texts.length; i += 50) {
    const batch = texts.slice(i, i + 50).map(t => String(t).slice(0, 6000));
    const r = await fetch('https://api.openai.com/v1/embeddings', {
      method: 'POST',
      headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: EMBED_MODEL, input: batch, dimensions: EMBED_DIMS }),
    });
    if (!r.ok) throw new Error('임베딩 실패: ' + (await r.text()).slice(0, 200));
    const data = await r.json();
    for (const d of data.data) out.push(normalize(d.embedding));
  }
  return out;
}

let cache = null; // { items: [{id, docId, topic, content, page, vec, doc...}] }
function invalidateCache() { cache = null; }

async function loadCache() {
  if (cache) return cache;
  const rows = (await pool.query(
    `SELECT c.id, c.doc_id, c.topic, c.note_type, c.content, c.page, c.embedding,
            d.title, d.url, d.source_name, d.source_type, d.notice
     FROM knowledge_chunks c JOIN knowledge_docs d ON d.id = c.doc_id`
  )).rows;
  cache = {
    items: rows.map(r => ({
      id: r.id, docId: r.doc_id, topic: r.topic, noteType: r.note_type, content: r.content, page: r.page,
      title: r.title, url: r.url, sourceName: r.source_name, sourceType: r.source_type, notice: r.notice,
      vec: Float32Array.from(typeof r.embedding === 'string' ? JSON.parse(r.embedding) : r.embedding),
    })),
  };
  return cache;
}

// 질문과 의미가 가까운 노트/페이지를 찾습니다.
async function search(query, k = 6, minScore = 0.3) {
  const { items } = await loadCache();
  if (!items.length || !query || !query.trim()) return [];
  const [q] = await embedTexts([query]);
  const qv = Float32Array.from(q);
  const scored = items.map(it => {
    let s = 0;
    for (let i = 0; i < qv.length; i++) s += qv[i] * it.vec[i];
    return { it, score: s };
  }).filter(x => x.score >= minScore).sort((a, b) => b.score - a.score);
  const perDoc = new Map();
  const picked = [];
  for (const x of scored) {
    const n = perDoc.get(x.it.docId) || 0;
    if (n >= 3) continue; // 한 자료에서 3개까지만 (다양하게)
    perDoc.set(x.it.docId, n + 1);
    const { vec, ...rest } = x.it;
    picked.push({ ...rest, score: Number(x.score.toFixed(3)) });
    if (picked.length >= k) break;
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
async function saveDoc({ sourceType, sourceName, title, url, notice, mode, entries, userId }) {
  if (!entries.length) return { docId: null, saved: 0 };
  const embedInputs = entries.map(e => `${e.topic || ''}\n${e.content}\n${(e.keywords || []).join(' ')}`);
  const vecs = await embedTexts(embedInputs);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const d = await client.query(
      `INSERT INTO knowledge_docs (source_type, source_name, title, url, notice, mode, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
      [sourceType, sourceName, String(title).slice(0, 300), url || null, notice || null, mode, userId || null]
    );
    const docId = d.rows[0].id;
    for (let i = 0; i < entries.length; i++) {
      const e = entries[i];
      await client.query(
        `INSERT INTO knowledge_chunks (doc_id, topic, note_type, content, page, embedding)
         VALUES ($1,$2,$3,$4,$5,$6)`,
        [docId, e.topic || null, e.type || null, e.content, e.page || null, JSON.stringify(vecs[i])]
      );
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
    data: new Uint8Array(buffer), useSystemFonts: true, disableFontFace: true, isEvalSupported: false,
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
    data: new Uint8Array(buffer), useSystemFonts: true, disableFontFace: true, isEvalSupported: false, canvasFactory: new Factory(),
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

function pagesToEntries(pages, title) {
  const entries = [];
  for (const p of pages) {
    if (p.text.replace(/\s/g, '').length < 40) continue;
    const parts = splitLong(p.text, 1800);
    const head = p.text.split('\n').find(l => l.trim()) || '';
    parts.forEach((t, i) => entries.push({
      topic: `${title} p.${p.page}${parts.length > 1 ? `-${i + 1}` : ''} — ${head.replace(/[#*]/g, '').trim().slice(0, 80)}`,
      type: '표자료', content: t, page: p.page,
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
const upload = multer({ limits: { fileSize: 20 * 1024 * 1024 } });

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
    const hits = await search(String(req.query.q || ''), 6, 0.2);
    res.json({ items: hits.map(h => ({ score: h.score, source: h.sourceName, title: h.title, topic: h.topic, preview: h.content.slice(0, 200) })) });
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
  const mode = req.body.mode === 'notes' ? 'notes' : 'data'; // 'vision'은 아래에서 따로 처리
  if (!sourceName) return res.status(400).json({ error: '자료 이름을 입력해주세요.' });
  try {
    const pages = await extractPdfPages(req.file.buffer);
    const total = pages.reduce((n, p) => n + p.text.length, 0);
    if (total < 200) return res.status(422).json({ error: '글자를 거의 읽지 못했습니다. 사진/스캔 PDF는 지원하지 않습니다.' });
    const title = String(req.body.title || req.file.originalname || sourceName).slice(0, 200);
    let notice = String(req.body.notice || '').trim();
    if (!notice && /사내\s*교육용/.test(pages.slice(0, 3).map(p => p.text).join(' '))) {
      notice = '사내 교육용 자료입니다. 보험 안내자료로 사용하거나 외부에 공유할 수 없습니다. 고객 안내는 가입설계서·상품설명서·약관 기준으로 하세요.';
    }
    if (req.body.mode === 'vision') {
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
    const entries = pagesToEntries(pages, title);
    const r = await saveDoc({ sourceType: 'file', sourceName, title, url: null, notice, mode: 'data', entries, userId: req.userId });
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
  const re = /<a\b([^>]*)>([\s\S]*?)<\/a>/gi;
  let m;
  while ((m = re.exec(html)) && links.length < 150) {
    const attrs = m[1];
    const href = (attrs.match(/href\s*=\s*(["'])([\s\S]*?)\1/i) || [])[2] || '';
    const onclick = (attrs.match(/onclick\s*=\s*(["'])([\s\S]*?)\1/i) || [])[2] || '';
    const text = m[2].replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 40);
    if (!href && !onclick) continue;
    let abs = href;
    if (href && !/^(javascript:|#|mailto:|tel:)/i.test(href)) { try { abs = new URL(href, baseUrl).href; } catch (e) { /* 그대로 */ } }
    links.push({ text, href: abs, onclick: onclick.slice(0, 80) });
  }
  const endpoints = [...new Set((html.match(/["'][^"'\s]{2,120}\.(?:do|ajax|jsp|asp|aspx|json)(?:\?[^"'\s]{0,60})?["']/gi) || []).map(x => x.slice(1, -1)))].slice(0, 40);
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
    const struct = req.body?.links ? extractLinks(text, u) : null;
    out.push({
      ...(struct ? { links: struct.links, endpoints: struct.endpoints } : {}),
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

module.exports = { router, search, embedTexts, extractPdfPages, extractNaverPost, parseBlogId, parseYoutubeId, htmlToText, distill, saveDoc, learnFromText, invalidateCache };
