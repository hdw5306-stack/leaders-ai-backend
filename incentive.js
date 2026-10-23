/**
 * incentive.js — 시책 공지 자동 읽기 (설계사 수수료 예측 프로그램용)
 *
 *   POST /api/incentive/jobs         공지 파일을 올려 읽기 작업 시작 → { jobId }
 *        - multipart: file (필수) 또는 fileId(앞 단계에서 받은 값),
 *          phase = identify | extract,
 *          companies(JSON, 수수료표에 있는 보험사 이름 목록 — identify),
 *          products(JSON {보험사:[상품 라벨]}), nonlife(JSON) — extract
 *   GET  /api/incentive/jobs/:id     진행 상태 조회 → { status: running|done|error, result|error }
 *   GET  /api/incentive/ping         연결 확인
 *
 * 인증: 수수료 예측 프로그램(카페24)이 본사관리자 로그인 후 발급한 짧은 시간용 토큰(HMAC)만 받습니다.
 *       카페24와 이 서버가 같은 비밀값(INCENTIVE_SHARED_SECRET)을 공유합니다.
 * AI: 이미 쓰고 있는 OPENAI_API_KEY 를 사용합니다. 모델은 INCENTIVE_MODEL 로 바꿀 수 있습니다.
 * 읽은 파일은 디스크에 저장하지 않고 메모리에서 잠깐(20분) 보관 후 폐기합니다.
 */
const express = require('express');
const crypto = require('crypto');
const multer = require('multer');
const { toInput } = require('./incentive_files');
const { SYSTEM_PROMPT, userPrompt, IDENTIFY_PROMPT } = require('./incentive_prompt');
const { validate } = require('./incentive_validate');

const router = express.Router();
const upload = multer({ limits: { fileSize: 15 * 1024 * 1024 } });
const OPENAI_BASE = (process.env.OPENAI_BASE_URL || 'https://api.openai.com').replace(/\/$/, '');

// ── 토큰 확인 ────────────────────────────────────────────────
function verifyToken(req, res, next) {
  const secret = process.env.INCENTIVE_SHARED_SECRET;
  if (!secret) return res.status(503).json({ error: '서버에 INCENTIVE_SHARED_SECRET 이 설정되지 않았습니다.' });
  const m = /^Bearer (.+)$/.exec(req.headers.authorization || '');
  if (!m) return res.status(401).json({ error: '인증이 필요합니다.' });
  const [body, sig] = m[1].split('.');
  if (!body || !sig) return res.status(401).json({ error: '인증 정보가 올바르지 않습니다.' });
  const expect = crypto.createHmac('sha256', secret).update(body).digest('hex');
  const a = Buffer.from(sig), b = Buffer.from(expect);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return res.status(401).json({ error: '인증 정보가 올바르지 않습니다.' });
  let payload;
  try { payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')); } catch (e) { return res.status(401).json({ error: '인증 정보가 올바르지 않습니다.' }); }
  if (!payload.exp || payload.exp < Math.floor(Date.now() / 1000)) return res.status(401).json({ error: '인증이 만료되었습니다. 화면을 새로 고쳐 다시 시도해 주세요.' });
  if (payload.scope !== 'incentive') return res.status(403).json({ error: '권한이 없습니다.' });
  next();
}

// ── 작업/파일 임시 보관 ──────────────────────────────────────
const jobs = new Map();
const files = new Map();
const TTL = 20 * 60 * 1000;
setInterval(() => {
  const now = Date.now();
  for (const [k, v] of jobs) if (now - v.at > TTL) jobs.delete(k);
  for (const [k, v] of files) if (now - v.at > TTL) files.delete(k);
}, 60 * 1000).unref();
const newId = () => crypto.randomBytes(12).toString('hex');

// ── AI 호출 ──────────────────────────────────────────────────
function models() { return [process.env.INCENTIVE_MODEL, 'gpt-4.1', 'gpt-4o'].filter((m, i, a) => m && a.indexOf(m) === i); }

function extractText(data) {
  let t = '';
  for (const item of data.output || []) {
    if (item.type !== 'message') continue;
    for (const c of item.content || []) if (c.type === 'output_text') t += c.text || '';
  }
  return t;
}
function parseJson(text) {
  let s = String(text || '').trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  try { return JSON.parse(s); } catch (e) {
    const a = s.indexOf('{'), b = s.lastIndexOf('}');
    if (a >= 0 && b > a) return JSON.parse(s.slice(a, b + 1));
    throw e;
  }
}

async function callAI({ system, content, maxOutput }) {
  if (!process.env.OPENAI_API_KEY) throw new Error('서버에 OPENAI_API_KEY 가 설정되지 않았습니다.');
  // OpenAI(json_object 모드)는 요청 본문(input)에도 'json' 이라는 단어가 있어야 합니다.
  content = content.map((c, i) => (i === 0 && c.type === 'input_text') ? { ...c, text: c.text + '\n\n(응답은 반드시 json 형식으로만 출력하세요.)' } : c);
  let lastErr = '';
  for (const model of models()) {
    let noTemp = false;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const r = await fetch(`${OPENAI_BASE}/v1/responses`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            model,
            instructions: system,
            input: [{ role: 'user', content }],
            text: { format: { type: 'json_object' } },
            max_output_tokens: maxOutput || 16000,
            ...(noTemp ? {} : { temperature: 0 }),
          }),
        });
        if (r.ok) {
          const data = await r.json();
          if (data.status === 'incomplete') throw Object.assign(new Error('공지가 너무 길어 AI가 한 번에 다 읽지 못했습니다. 공지를 나누어(보험사별/쪽별) 올려 주세요.'), { fatal: true });
          const text = extractText(data);
          if (!text) throw new Error('AI가 빈 응답을 보냈습니다.');
          return { json: parseJson(text), usage: data.usage || {}, model };
        }
        const body = (await r.text()).slice(0, 400);
        lastErr = `${model} ${r.status}: ${body}`;
        console.error('[시책읽기] AI 오류', lastErr);
        if (r.status === 429 || r.status >= 500) { await new Promise(s => setTimeout(s, 2500 * (attempt + 1))); continue; }
        if (r.status === 400 && !noTemp && /temperature/i.test(body)) { noTemp = true; continue; } // 이 모델은 temperature 를 받지 않음 → 빼고 다시
        if (r.status === 400 || r.status === 404) break; // 이 모델로는 안 됨 → 다음 모델
        if (r.status === 401) throw Object.assign(new Error('OpenAI 키가 올바르지 않습니다.'), { fatal: true });
        break;
      } catch (e) {
        if (e.fatal) throw e;
        lastErr = `${model}: ${e.message}`;
        console.error('[시책읽기] 호출 실패', lastErr);
        await new Promise(s => setTimeout(s, 1500));
      }
    }
  }
  throw new Error('AI 서비스 호출에 실패했습니다. ' + lastErr.slice(0, 200));
}

// ── 단계별 처리 ──────────────────────────────────────────────
async function runIdentify(file, companies) {
  const input = await toInput(file.buffer, file.filename, file.mimetype);
  const content = [{ type: 'input_text', text: IDENTIFY_PROMPT + '\n\n[보험사 목록]\n' + (companies || []).join(', ') + (input.text ? '\n\n[공지 내용]\n' + input.text.slice(0, 20000) : '') }];
  if (input.filePart) content.push(input.filePart);
  if (input.imagePart) content.push(input.imagePart);
  const ai = await callAI({ system: '당신은 보험 시책 공지를 분류하는 도우미입니다. JSON만 출력합니다.', content, maxOutput: 600 });
  const found = Array.isArray(ai.json.companies) ? ai.json.companies.map(String) : [];
  const known = new Set(companies || []);
  return { companies: found.filter(c => !companies || known.has(c)), unknown: found.filter(c => companies && !known.has(c)), period: String(ai.json.period || ''), warnings: input.warnings, usage: ai.usage, model: ai.model };
}

async function runExtract(file, products, nonlife) {
  const input = await toInput(file.buffer, file.filename, file.mimetype);
  const today = new Date().toLocaleDateString('sv-SE', { timeZone: 'Asia/Seoul' });
  const content = [{ type: 'input_text', text: userPrompt({ filename: file.filename, today, products, nonlife, fileText: input.text }) }];
  if (input.filePart) content.push(input.filePart);
  if (input.imagePart) content.push(input.imagePart);
  const ai = await callAI({ system: SYSTEM_PROMPT, content, maxOutput: 16000 });
  const v = validate(ai.json, { products, today, filename: file.filename });
  const ruleCount = v.batches.reduce((a, b) => a + b.rules.length, 0);
  const review = v.batches.reduce((a, b) => a + b.rules.filter(r => r.review_note).length, 0);
  console.log(`[시책읽기] ${file.filename} → ${v.batches.length}묶음 ${ruleCount}건 (확인필요 ${review}건) 모델 ${ai.model} 토큰 입력 ${ai.usage.input_tokens || '?'} / 출력 ${ai.usage.output_tokens || '?'}`);
  return { batches: v.batches, warnings: input.warnings.concat(v.warnings), usage: ai.usage, model: ai.model };
}

function parseJsonField(v) { if (!v) return null; try { return JSON.parse(v); } catch (e) { return null; } }

router.get('/ping', verifyToken, (req, res) => res.json({ ok: true, ai: !!process.env.OPENAI_API_KEY, models: models() }));

router.post('/jobs', verifyToken, upload.single('file'), (req, res) => {
  const phase = req.body.phase === 'extract' ? 'extract' : 'identify';
  let file = null;
  if (req.file) {
    const fid = newId();
    file = { buffer: req.file.buffer, filename: Buffer.from(req.file.originalname || 'notice', 'latin1').toString('utf8'), mimetype: req.file.mimetype, at: Date.now() };
    // multer 가 이미 UTF-8 이름을 주는 경우를 위해 깨짐 여부 확인
    if (/Ã|ì|ë|í/.test(file.filename) && !/[가-힣]/.test(file.filename)) file.filename = req.file.originalname;
    files.set(fid, file);
    file.id = fid;
  } else if (req.body.fileId && files.has(req.body.fileId)) {
    file = files.get(req.body.fileId); file.at = Date.now();
  }
  if (!file) return res.status(400).json({ error: '파일이 없거나 보관 시간이 지났습니다. 파일을 다시 올려 주세요.' });
  const id = newId();
  const job = { status: 'running', at: Date.now() };
  jobs.set(id, job);
  (async () => {
    try {
      if (phase === 'identify') job.result = Object.assign({ fileId: file.id }, await runIdentify(file, parseJsonField(req.body.companies)));
      else job.result = await runExtract(file, parseJsonField(req.body.products) || {}, parseJsonField(req.body.nonlife) || {});
      job.status = 'done';
    } catch (e) {
      console.error('[시책읽기] 실패:', e.message);
      job.status = 'error'; job.error = e.message || '읽기에 실패했습니다.';
    }
    job.at = Date.now();
  })();
  res.json({ jobId: id, fileId: file.id });
});

router.get('/jobs/:id', verifyToken, (req, res) => {
  const j = jobs.get(req.params.id);
  if (!j) return res.status(404).json({ error: '작업을 찾을 수 없습니다(시간이 지났거나 서버가 다시 시작됨).' });
  res.json({ status: j.status, result: j.status === 'done' ? j.result : undefined, error: j.error });
});

module.exports = { router, verifyToken };
