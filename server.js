/**
 * server.js — 리더스 AI 비서 백엔드 서버
 *
 * 역할 4가지:
 *   1) 음성인식(STT) 중계 — leaders-ai-assistant.html이 iOS 등 Web Speech API
 *      미지원 환경에서 녹음한 오디오를 받아 OpenAI Whisper API로 전달
 *   1-1) 음성 합성(TTS) — 답변을 소리로 읽어줄 때, 브라우저 자체 음성합성이
 *      지원되지 않는 환경(카카오톡 인앱 브라우저 등)에서도 항상 동일하게
 *      소리가 나도록 OpenAI TTS로 mp3를 만들어 내려줌
 *   2) 로그인/회원가입 — 설계사별 별도 계정 (자체 아이디/비밀번호, JWT)
 *   3) 개인 일정 저장 — 카테고리(미팅/계약/방문/개인/기타)별로 DB에 저장,
 *      로그인한 사용자 본인 것만 조회/삭제 가능
 *   4) 첨부 사진/서류 분석 — 채팅 중 올린 사진(고객 서류, 상품 팜플렛 등)을
 *      OpenAI Vision(gpt-4o-mini)으로 분석해 질문에 답변. 파일은 저장하지 않고
 *      요청 처리 후 즉시 버립니다.
 *   5) 관리자 기능(3단계 권한: 설계사/지사장/상무) — 지사장은 자기 지사 소속
 *      설계사만 승인/관리, 상무는 전체 지사·설계사를 보고 지사·지사장 계정을
 *      만들 수 있습니다. 약관·보상사례 공용 DB도 여기서 관리하며, 수정하면
 *      모든 설계사 화면에 즉시 반영됩니다.
 *   6) 지사 목록 — 회원가입 화면에서 소속 지사를 선택하는 데 사용
 *
 * Railway 같은 Node.js 호스팅에 올려서 쓰도록 만들어졌습니다
 * (m.leadersfc.co.kr은 정적 파일만 호스팅하는 카페24라 이 서버는
 * 별도 호스팅(Railway)에 둡니다).
 *
 * 로컬 실행
 *   1) npm install
 *   2) cp .env.example .env  →  .env 안에 값 채우기
 *   3) npm start
 *   4) http://localhost:3000 으로 헬스체크 확인
 *
 * Railway 배포는 이 폴더의 README.md를 참고하세요.
 */

const express = require('express');
const multer = require('multer');
const FormData = require('form-data');
const { initDb, pool } = require('./db');
const { router: authRoutes, verifyToken, requireSuperAdmin } = require('./auth');
const knowledge = require('./knowledge');
const scheduleRoutes = require('./schedule');
const adminRoutes = require('./admin');
const contentRoutes = require('./content');
const branchRoutes = require('./branches');

const app = express();
app.use(express.json({ limit: '5mb' }));
const upload = multer({ limits: { fileSize: 15 * 1024 * 1024 } }); // 오디오/이미지는 메모리에만 잠깐 보관 후 즉시 폐기, 15MB 제한

// ── CORS 설정 ──────────────────────────────────────────────
// leaders-ai-assistant.html은 m.leadersfc.co.kr(카페24)에서 열리고,
// 이 서버는 Railway의 다른 도메인에서 돌아가므로 "다른 출처(cross-origin)"
// 요청이 됩니다. ALLOWED_ORIGINS 환경변수에 허용할 도메인을 콤마로
// 나열하세요. 비워두면 개발 편의상 전체 허용(*)으로 동작합니다.
const allowedOrigins = (process.env.ALLOWED_ORIGINS || '')
  .split(',')
  .map(s => s.trim())
  .filter(Boolean);

app.use((req, res, next) => {
  const origin = req.headers.origin;
  if (allowedOrigins.length === 0) {
    res.setHeader('Access-Control-Allow-Origin', '*');
  } else if (origin && allowedOrigins.includes(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
  }
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

// Railway/모니터링용 헬스체크 — 브라우저로 서버 주소만 열어도 정상 배포 확인 가능
app.get('/', (req, res) => {
  res.json({ status: 'ok', service: '리더스 AI 비서 백엔드 서버' });
});

// ── 화면 파일(리더스 AI 비서) 제공 — 같은 서버에서 /assistant/ 로 열립니다 ──
app.use('/assistant', require('express').static(require('path').join(__dirname, 'public', 'assistant'), {
  setHeaders: (res, filePath) => { if (/\.(html|json)$/i.test(filePath)) res.setHeader('Cache-Control', 'no-cache'); },
}));

// ── 1) 음성인식(STT) ──────────────────────────────────────────
app.post('/api/stt', upload.single('audio'), async (req, res) => {
  if (!process.env.OPENAI_API_KEY) {
    return res.status(500).json({ error: 'OPENAI_API_KEY 환경변수가 설정되지 않았습니다.' });
  }
  if (!req.file) {
    return res.status(400).json({ error: '오디오 파일이 전달되지 않았습니다.' });
  }

  try {
    const form = new FormData();
    form.append('file', req.file.buffer, {
      filename: 'recording.webm',
      contentType: req.file.mimetype || 'audio/webm',
    });
    form.append('model', 'whisper-1');
    form.append('language', 'ko'); // 한국어로 고정

    const openaiRes = await fetch('https://api.openai.com/v1/audio/transcriptions', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
        ...form.getHeaders(),
      },
      body: form,
    });

    if (!openaiRes.ok) {
      const errText = await openaiRes.text();
      console.error('Whisper API 오류:', errText);
      return res.status(502).json({ error: 'STT 서비스 호출에 실패했습니다.' });
    }

    const data = await openaiRes.json();
    res.json({ text: data.text || '' });
  } catch (err) {
    console.error('STT 처리 중 오류:', err);
    res.status(500).json({ error: '서버 내부 오류' });
  }
});

// ── 1-1) 음성 합성(TTS) ──────────────────────────────────────────
// 브라우저 자체 음성합성(Web Speech API)은 카카오톡 인앱 브라우저 등 일부
// 환경에서 아예 지원되지 않아 화면에 답은 뜨는데 소리만 안 나는 경우가
// 있습니다. 그래서 답변 음성은 서버에서 OpenAI TTS로 mp3 파일을 만들어
// 내려주는 방식을 기본으로 씁니다 — 어떤 브라우저(카카오톡 포함)에서
// 열어도 항상 동일하게 소리가 납니다.
app.post('/api/tts', async (req, res) => {
  if (!process.env.OPENAI_API_KEY) {
    return res.status(500).json({ error: 'OPENAI_API_KEY 환경변수가 설정되지 않았습니다.' });
  }
  const { text, voice, style, speed } = req.body || {};
  if (!text || !text.trim()) {
    return res.status(400).json({ error: '읽어줄 텍스트가 없습니다.' });
  }
  const allowedVoices = ['alloy', 'ash', 'ballad', 'coral', 'echo', 'fable', 'nova', 'onyx', 'sage', 'shimmer', 'verse', 'marin', 'cedar'];
  const useVoice = allowedVoices.includes(voice) ? voice : 'nova';
  const STYLES = {
    counsel: 'Speak in natural, fluent Korean as a warm, trustworthy insurance counselor. Calm, kind and reassuring, with gentle pauses.',
    expert: 'Speak in natural, fluent Korean as a calm, authoritative financial expert. Clear, steady and professional.',
    bright: 'Speak in natural, fluent Korean in a bright, friendly and energetic tone, like a cheerful assistant.',
    calm: 'Speak in natural, fluent Korean slowly and softly, in a relaxed, soothing tone.',
    news: 'Speak in natural, fluent Korean with crisp, precise articulation like a professional announcer.',
  };
  const instructions = STYLES[style] || STYLES.counsel;
  const sp = Math.min(1.3, Math.max(0.8, Number(speed) || 1));
  const input = text.slice(0, 1500);
  const primary = process.env.TTS_MODEL || 'gpt-4o-mini-tts';

  // 1순위: 고급 음성 모델(말투 지시·속도) → 실패하면 속도/지시 없이 → 그래도 안 되면 기본 tts-1
  const attempts = [
    { model: primary, voice: useVoice, input, instructions, speed: sp, response_format: 'mp3' },
    { model: primary, voice: useVoice, input, instructions, response_format: 'mp3' },
    { model: 'tts-1', voice: ['alloy', 'echo', 'fable', 'nova', 'onyx', 'shimmer'].includes(useVoice) ? useVoice : 'nova', input, speed: sp, response_format: 'mp3' },
  ];
  try {
    let lastErr = '';
    for (const body of attempts) {
      const openaiRes = await fetch('https://api.openai.com/v1/audio/speech', {
        method: 'POST',
        headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (openaiRes.ok) {
        const arrayBuffer = await openaiRes.arrayBuffer();
        res.set('Content-Type', 'audio/mpeg');
        return res.send(Buffer.from(arrayBuffer));
      }
      lastErr = (await openaiRes.text()).slice(0, 300);
      console.error(`TTS 실패(${body.model}):`, lastErr);
    }
    return res.status(502).json({ error: '음성 합성 서비스 호출에 실패했습니다.' });
  } catch (err) {
    console.error('TTS 처리 중 오류:', err);
    res.status(500).json({ error: '서버 내부 오류' });
  }
});

// 메시지 안에 포함된 간단한 HTML을 사람이 읽는 글자만 남도록 정리합니다
// (블로그/홈페이지 글 요약 기능에서 사용)
function extractTextFromHtml(html) {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

// 사용자가 채팅에 붙여넣은 URL(블로그/홈페이지 주소)을 서버가 직접 불러와
// 본문 텍스트만 뽑아냅니다. 로그인/결제 등이 필요한 페이지, 접속을
// 차단하는 사이트는 실패할 수 있고, 그 경우 AI가 솔직히 안내합니다.
async function fetchPageText(url) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 8000);
  try {
    const r = await fetch(url, {
      signal: controller.signal,
      redirect: 'follow',
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; LeadersAIBot/1.0; +https://leadersfp.co.kr)' },
    });
    clearTimeout(timeout);
    if (!r.ok) return null;
    const contentType = r.headers.get('content-type') || '';
    if (!contentType.includes('text/html') && !contentType.includes('text')) return null;
    const html = await r.text();
    const text = extractTextFromHtml(html);
    return text.slice(0, 8000); // 너무 긴 페이지는 앞부분만 사용
  } catch (err) {
    clearTimeout(timeout);
    return null;
  }
}

// ── 웹검색 (OpenAI Responses API web_search 도구) ─────────────────
// 네이버 검색 API 키 없이, 이미 쓰고 있는 OPENAI_API_KEY만으로 동작합니다.
// 로그인이 필요한 카페/SNS 글은 읽을 수 없고, 공개된 웹페이지만 대상입니다.
// 모델은 환경변수 SEARCH_MODEL로 바꿀 수 있고, 안 되면 다음 후보로 자동 시도합니다.
const SEARCH_TRIGGER = /검색|찾아|알아봐|알아봐줘|최신|최근|뉴스|요즘|트렌드|후기|블로그|카페|홈페이지|사이트|유튜브|sns|인스타|페이스북/i;
async function webSearch(query, history, diag) {
  diag = diag || [];
  const models = [process.env.SEARCH_MODEL, 'gpt-4.1-mini', 'gpt-4.1'].filter(Boolean);
  let weak = null; // 출처 없이 끝난 결과는 보관만 하고 다음 모델로 한 번 더 시도
  const context = (history || []).slice(-4).map(h => `${h.role === 'user' ? '사용자' : '비서'}: ${h.content}`).join('\n');
  const today = new Date().toLocaleDateString('ko-KR', { timeZone: 'Asia/Seoul', year: 'numeric', month: 'long', day: 'numeric' });
  const input = `${context ? '[직전 대화]\n' + context + '\n\n' : ''}오늘 날짜: ${today}\n[요청]\n${query}\n\n반드시 웹검색 도구로 한국어 검색어를 직접 만들어 검색한 뒤, 가장 최근의 공개 기사·게시글 3~5건을 찾아 각각 제목, 날짜, 핵심 내용을 한국어로 정리하세요. 요청이 막연하면 가장 합리적인 검색어(예: "보험 업계 뉴스", "보험 설계사 제도 변경")로 검색하세요. 검색 결과에 실제로 있는 내용만 쓰되, "확인할 수 없다"고 답하기 전에 검색어를 바꿔 한 번 더 검색하세요.`;
  console.log('[웹검색] 시작:', query.slice(0, 60), '| 후보 모델:', models.join(','));
  for (const model of models) {
    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 25000);
      const r = await fetch('https://api.openai.com/v1/responses', {
        method: 'POST',
        headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model,
          tools: [{ type: 'web_search', user_location: { type: 'approximate', country: 'KR' } }],
          tool_choice: 'required',
          input,
        }),
        signal: ctrl.signal,
      });
      clearTimeout(timer);
      if (!r.ok) {
        const errBody = (await r.text()).slice(0, 500);
        console.error(`웹검색 실패(${model}):`, errBody);
        diag.push({ model, status: r.status, error: errBody });
        continue;
      }
      const data = await r.json();
      let text = '';
      const sources = [];
      const seen = new Set();
      for (const item of data.output || []) {
        if (item.type !== 'message') continue;
        for (const c of item.content || []) {
          if (c.type === 'output_text') {
            text += c.text || '';
            for (const a of c.annotations || []) {
              if (a.type === 'url_citation' && a.url && !seen.has(a.url)) {
                seen.add(a.url);
                sources.push({ title: a.title, url: a.url.replace(/[?&]utm_source=openai$/, '') });
              }
            }
          }
        }
      }
      console.log(`[웹검색] ${model} 응답 수신 — 본문 ${text.length}자, 출처 ${sources.length}개, 항목: ${(data.output || []).map(o => o.type).join(',')}`);
      diag.push({ model, status: 200, textLength: text.length, sources: sources.length, outputTypes: (data.output || []).map(o => o.type) });
      if (text && sources.length) return { text: text.slice(0, 6000), sources };
      if (text && !weak) weak = { text: text.slice(0, 6000), sources };
    } catch (e) {
      console.error(`웹검색 오류(${model}):`, e.message);
      diag.push({ model, exception: e.message });
    }
  }
  return weak;
}

// ── 월별 상품자료 불러오기 ─────────────────────────────────────
// 상품·경쟁력·비교 같은 질문이면, 관리자가 올려둔 자료를 AI에게 읽혀서 분석하게 합니다.
const PRODUCT_TRIGGER = /상품|경쟁력|비교|추천|보험사|생명|손해|특약|보험료|가입|보장|신상품|판매|시책|인기|유리|장단점/;
const PRODUCT_CHAR_BUDGET = 70000;
async function loadProductDocs(message) {
  try {
    const months = (await pool.query('SELECT DISTINCT month FROM product_docs ORDER BY month DESC')).rows.map(r => r.month);
    if (!months.length) return [];
    let target = months[0];
    const mm = message.match(/(\d{1,2})\s*월/);
    if (mm) {
      const want = String(mm[1]).padStart(2, '0');
      const found = months.find(m => m.endsWith('-' + want));
      if (found) target = found;
    }
    const rows = (await pool.query(
      'SELECT company, title, content, month FROM product_docs WHERE month = $1 ORDER BY company, id', [target]
    )).rows;
    const total = rows.reduce((n, r) => n + r.content.length, 0);
    const ratio = total > PRODUCT_CHAR_BUDGET ? PRODUCT_CHAR_BUDGET / total : 1;
    return rows.map(r => ({
      ...r,
      content: r.content.slice(0, Math.max(3000, Math.floor(r.content.length * ratio))),
      truncated: ratio < 1,
    }));
  } catch (e) {
    console.error('상품자료 조회 오류:', e.message);
    return [];
  }
}

// ── 1-2) AI 상담(대화형) ────────────────────────────────────────
// 기존에는 질문 속 특정 단어("암" 등)만 보고 미리 정해둔 답 중 하나를
// 고르는 방식이라 "암 수술 영상 보여줘" 같은 질문에 "암 진단비 청구
// 사례"처럼 엉뚱한 답이 나가는 문제가 있었습니다. 이제는 질문 전체를
// OpenAI에 보내 실제 의도를 이해하고 자연스럽게 답하게 합니다.
// 약관/보상사례/미디어 DB는 참고자료로만 함께 보내고, 답을 그 안에서
// 찾을지, 일반 지식으로 답할지는 AI가 스스로 판단합니다.
// 메시지에 URL(블로그/홈페이지 주소)이 포함되어 있으면, 그 페이지 내용을
// 직접 불러와 참고자료로 함께 제공해서 요약·질의응답이 가능하게 합니다.
// ── 개인정보 가리기 (상담 코칭·롤플레이는 고객 이야기가 외부 AI로 가므로 먼저 마스킹) ──
function maskPII(t) {
  return String(t || '')
    .replace(/\b\d{6}\s?[-–]\s?[1-4]\d{6}\b/g, '[주민번호]')
    .replace(/\b0\d{1,2}[-.\s]?\d{3,4}[-.\s]?\d{4}\b/g, '[전화번호]')
    .replace(/[\w.+-]+@[\w-]+\.[\w.-]+/g, '[이메일]')
    .replace(/\b\d{3,6}[-\s]\d{2,6}[-\s]\d{2,8}(?:[-\s]\d{1,4})?\b/g, '[번호]');
}

// ── 질문 분류: 일반 / 보험 / 상담코칭 + 최신정보(웹검색) 필요 여부 ───────────
// 가벼운 모델로 한 번 판단합니다. 실패하면 키워드로 대신 판단합니다.
const COACH_HINT = /고객(이|은|님이|이랑|한테|에게)|상담.*(스킬|방법|멘트|화법)|거절|반론|설득|클로징|"[^"]{4,}"라고|라고 (했|하|말)|생각해.?볼게|비싸|부담|남편|아내|배우자.*(상의|의논)|심리/;
const INS_HINT = /보험|약관|특약|면책|보장|청구|지급|진단비|수술비|실손|종신|연금|암|보험료|설계|손해사정|담보|갱신|환급|해지|계약자|피보험/;
const WEB_HINT = /검색|인터넷|뉴스|최신|최근|오늘|지금|현재|날씨|시세|환율|주가|순위|결과|일정|언제까지|몇\s*위|요즘|트렌드/;
async function classifyIntent(message, history) {
  const fallback = () => ({
    mode: COACH_HINT.test(message) && !/약관|면책|진단비/.test(message) ? 'coaching' : INS_HINT.test(message) ? 'insurance' : 'general',
    needWeb: WEB_HINT.test(message),
  });
  try {
    const ctx = (history || []).slice(-4).map(h => `${h.role === 'user' ? '사용자' : '비서'}: ${String(h.content).slice(0, 200)}`).join('\n');
    const r = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: process.env.CLASSIFY_MODEL || 'gpt-4o-mini',
        response_format: { type: 'json_object' },
        max_tokens: 60,
        temperature: 0,
        messages: [
          { role: 'system', content:
            '사용자 질문을 분류해 JSON으로만 답하세요: {"mode":"general|insurance|coaching","needWeb":true|false}\n' +
            '- insurance: 보험 상품·약관·보장·청구·보험사·보험 제도/영업 실무 지식 질문\n' +
            '- coaching: 설계사가 고객 상담 상황·고객 발언을 알려주며 대응법·화법·심리 파악·상담 스킬 조언을 구하는 경우\n' +
            '- general: 그 밖의 모든 것(잡담, 게임, 상식, 글쓰기, 번역, 계산, 코딩, 날씨, 시사 등)\n' +
            '- needWeb: 오늘/현재/최신 정보(날씨, 뉴스, 시세, 환율, 주가, 스포츠 결과, 최신 제도·상품 소식, 특정 사이트 검색 요청)가 있어야 정확히 답할 수 있으면 true. 상식·글쓰기·계산·약관 해석 등은 false.' },
          { role: 'user', content: (ctx ? '[직전 대화]\n' + ctx + '\n\n' : '') + '[질문]\n' + message },
        ],
      }),
    });
    if (!r.ok) return fallback();
    const d = await r.json();
    const j = JSON.parse(d.choices?.[0]?.message?.content || '{}');
    if (!['general', 'insurance', 'coaching'].includes(j.mode)) return fallback();
    return { mode: j.mode, needWeb: !!j.needWeb };
  } catch (e) {
    return fallback();
  }
}

const OUTPUT_RULES = `반드시 아래 JSON 형식으로만, 다른 설명 없이 답하세요. reply 안에서는 마크다운 기호(**, #, 백틱)를 쓰지 말고, 필요하면 번호(1. 2.)·줄바꿈·"- " 목록으로 읽기 좋게 정리하세요. 코드는 들여쓰기만 유지해 그대로 적으세요:
{
  "reply": "화면에 보여줄 답변 (존댓말, 필요하면 길고 자세하게)",
  "speech": "음성으로 읽어줄 짧은 한두 문장 요약",
  "action": null 또는 { "type": "media_list", "titles": ["미디어 DB의 title 값과 정확히 동일한 문자열"] },
  "used": [활용한 학습 지식창고 자료 번호들 (예: [1, 3]), 없으면 빈 배열]
}`;

function buildSystemPrompt(mode, { termsDb, claimsDb, mediaDb, extra, wantMedia }) {
  const today = new Date().toLocaleDateString('ko-KR', { timeZone: 'Asia/Seoul', year: 'numeric', month: 'long', day: 'numeric', weekday: 'long' });
  const base = `당신은 리더스사업부 설계사를 위한 만능 AI 비서입니다. ChatGPT처럼 세상 모든 주제(잡담, 상식, 글쓰기, 번역, 계산, 코딩, 기획, 고민상담, 말놀이, 시사 등)를 자연스럽고 깊이 있게 도와주고, 보험 분야에서는 일반 AI보다 훨씬 전문적으로 답합니다. 오늘 날짜는 ${today}입니다.
공통 원칙:
- 주제가 보험이 아니라는 이유로 거절하거나 보험 얘기로 돌리지 마세요. 끝말잇기·스무고개 같은 놀이는 바로 시작하고 앞선 대화를 기억해 이어가세요.
- 질문이 단순하면 짧게, 복잡하면 충분히 길고 구조적으로 답하세요. 얼버무리지 말고 구체적인 내용·예시·수치로 답하세요.
- 모르는 것은 지어내지 말고 모른다고 하되, 아는 범위에서 최대한 도우세요.
- 사용자가 웹페이지 주소를 붙여넣으면 아래 [웹페이지 내용]을 바탕으로 요약·답변하세요.`;

  if (mode === 'roleplay') {
    return `${base}

[롤플레이 연습 모드]
설계사의 상담 연습 상대입니다. 규칙:
- 사용자가 상황(고객 유형·상품·성향)을 말하면 당신은 그 "고객" 역할만 합니다. 상황이 불명확하면 현실적인 고객(예: 40대 직장인, 보험료 부담·불신이 있는 성향)으로 직접 정해 짧게 소개하고 첫 마디를 시작하세요.
- 고객 대사는 실제 사람처럼 짧고 자연스럽게(1~3문장). 설계사의 말이 좋으면 마음이 조금씩 열리고, 나쁘면(압박·과장·전문용어) 더 방어적으로 반응하세요. 쉽게 계약해 주지 마세요.
- 사용자가 "종료", "평가", "피드백"이라고 하면 역할을 멈추고 평가합니다: 잘한 점 / 아쉬운 점 / 고객 심리 변화 / 더 나은 멘트 예시 2개 / 100점 만점 점수.
- 실제 고객 개인정보는 요구하지 마세요. 평가 외에는 설명·훈수를 하지 말고 고객 대사만 하세요.
${OUTPUT_RULES}`;
  }

  if (mode === 'coaching') {
    return `${base}

[상담 코칭 모드] — 설계사가 고객 상황이나 고객의 말을 알려주면, 고객 심리를 읽고 바로 쓸 수 있는 상담 스킬을 코칭하는 전문 상담 코치입니다. 반드시 다음 구조로 답하세요(각 항목 제목은 일반 글자로):
1. 고객 심리 분석: 현재 심리 상태(불안·불신·가격 부담·미루기·확신 부족·결정권자 부재 등), 말 속에 숨은 진짜 이유, 구매/거절 신호. 고객이 한 말 중 어느 부분에서 그렇게 판단했는지 인용으로 근거를 대세요. 단정하지 말고 "~로 보입니다"로 쓰고, 확인 질문으로 검증하라고 안내하세요.
2. 지금 해야 할 한 가지: 공감 / 질문 / 설명 / 제안 / 클로징 중 무엇인지와 이유.
3. 바로 쓸 멘트 3가지: 부드럽게 / 근거를 들어 / 직설적으로 — 실제로 입으로 말할 수 있는 자연스러운 문장으로.
4. 물어볼 질문 2~3개: 고객의 진짜 니즈를 끌어내는 열린 질문.
5. 피해야 할 말·행동.
6. 다음 단계: 다음 연락 시점·방법.
- 정보가 부족하면 가장 가능성 높은 해석으로 먼저 답한 뒤, 더 정확히 코칭하려면 필요한 정보 1~2가지를 마지막에 물어보세요.
- 상담 스킬은 아래 [학습 지식창고]에 관련 자료가 있으면 그 내용을 우선 근거로 삼으세요. 과장·압박·불완전판매로 이어질 수 있는 화법(보험료 속이기, 불안 과도하게 조장, 비교 시 허위 설명)은 권하지 마세요. 마지막에 "고객 반응을 바탕으로 한 추정이니 실제 상담에서 확인하며 활용하세요"를 한 줄로 덧붙이세요.
${extra}
${OUTPUT_RULES}`;
  }

  if (mode === 'insurance') {
    return `${base}

[보험 전문 모드] — 보험 실무 질문입니다. 일반 AI와 차별화되도록 다음을 지키세요:
- 아래 사내 자료(약관·보상사례·상품자료·학습 지식창고)가 질문과 관련 있으면 이를 최우선 근거로 쓰고, 근거와 일반 지식을 구분해 "자료 기준 / 일반적으로는"처럼 표시하세요. 관련 없으면 무시하고 아는 지식으로 답하세요.
- 설계사 실무 관점으로 답하세요: 핵심 결론 → 근거(약관·자료) → 고객에게 설명할 때 쉬운 말 → 주의할 점(면책·감액·갱신·고지의무). 불완전판매 소지가 있는 설명은 피하세요.
- 약관·수치·보험료는 자료에 있는 값만 쓰고, 없으면 "자료에 없음"이라고 하세요. 최종 판단은 실제 계약의 약관·상품설명서 확인이 필요하다고 한 줄 덧붙이세요.

[약관 DB]
${JSON.stringify(termsDb || [])}

[보상사례 DB]
${JSON.stringify(claimsDb || [])}
${wantMedia ? `\n[미디어(영상) DB] — 제목/태그만 있는 목록입니다. 영상을 보여달라고 하면 관련 title을 action.titles 배열에 정확히 그대로 담으세요(하나를 골라 바로 재생하지 말고 후보를 보여주세요). 관련 영상이 없으면 action은 null로 하고 다른 도움 방법을 제안하세요.\n${JSON.stringify(mediaDb || [])}\n` : ''}${extra}
${OUTPUT_RULES}`;
  }

  // general
  return `${base}

[일반 모드] 보험 자료는 사용하지 않습니다. 평범한 ChatGPT처럼 자유롭게, 정확하고 풍부하게 답하세요.${wantMedia ? `\n영상 요청이면 아래 미디어 DB에서 관련 title을 action.titles에 담으세요.\n${JSON.stringify(mediaDb || [])}` : ''}
${extra}
${OUTPUT_RULES}`;
}

app.post('/api/chat', async (req, res) => {
  if (!process.env.OPENAI_API_KEY) {
    return res.status(500).json({ error: 'OPENAI_API_KEY 환경변수가 설정되지 않았습니다.' });
  }
  const { message: rawMessage, termsDb, claimsDb, mediaDb, history, mode: uiMode } = req.body || {};
  if (!rawMessage || !rawMessage.trim()) {
    return res.status(400).json({ error: '질문 내용이 없습니다.' });
  }
  let message = rawMessage;
  // 최근 대화 12개까지 문맥으로 사용
  let safeHistory = Array.isArray(history)
    ? history
        .filter(h => h && (h.role === 'user' || h.role === 'assistant') && typeof h.content === 'string')
        .slice(-12)
    : [];

  // 1) 모드 결정: 화면에서 코칭/롤플레이를 직접 켰으면 그대로, 아니면 AI가 분류
  const urlMatch = message.match(/https?:\/\/[^\s)\]]+/i);
  let mode, needWeb = false;
  if (uiMode === 'roleplay' || uiMode === 'coaching') {
    mode = uiMode;
    needWeb = false;
  } else if (urlMatch) {
    mode = INS_HINT.test(message) ? 'insurance' : 'general';
  } else {
    const c = await classifyIntent(message, safeHistory);
    mode = c.mode;
    needWeb = c.needWeb;
  }
  // 고객 이야기가 오가는 모드는 개인정보를 가려서 외부 AI로 보냅니다.
  if (mode === 'coaching' || mode === 'roleplay') {
    message = maskPII(message);
    safeHistory = safeHistory.map(h => ({ role: h.role, content: maskPII(h.content) }));
  }

  // 2) URL 페이지 내용
  let pageContext = '';
  if (urlMatch) {
    const targetUrl = urlMatch[0];
    const pageText = await fetchPageText(targetUrl);
    pageContext = pageText
      ? `\n\n[웹페이지 내용 — 출처: ${targetUrl}]\n${pageText}`
      : `\n\n[참고: 사용자가 알려준 주소(${targetUrl})를 불러오지 못했습니다 — 로그인이 필요하거나 접속을 차단하는 사이트일 수 있습니다. 이 사실을 솔직히 안내하세요.]`;
  }
  console.log('[채팅] 모드:', mode, '| 웹필요:', needWeb, '| 질문:', message.slice(0, 50));

  // 3) 보험 모드: 월별 상품자료 + 학습 지식창고 / 코칭 모드: 학습 지식창고(상담 스킬 자료)
  let productDocs = [];
  if (mode === 'insurance' && !urlMatch && PRODUCT_TRIGGER.test(message)) {
    productDocs = await loadProductDocs(message);
  }
  let knowledgeHits = [];
  if ((mode === 'insurance' || mode === 'coaching') && !urlMatch) {
    try {
      const lastUser = [...safeHistory].reverse().find(h => h.role === 'user');
      const q = message.length < 25 && lastUser ? `${lastUser.content}\n${message}` : message;
      const company = mode === 'insurance'
        ? (knowledge.detectCompany(message) || (message.length < 25 ? knowledge.detectCompany(lastUser && lastUser.content) : null))
        : null;
      knowledgeHits = await knowledge.search(q, company ? 8 : 6, mode === 'coaching' ? 0.35 : 0.3, { company });
      if (company) console.log('[지식] 보험사 지정 검색:', company);
    } catch (e) {
      console.error('지식 검색 오류:', e.message);
    }
    console.log('[지식] 찾은 자료:', knowledgeHits.length, knowledgeHits.map(h => `${h.sourceName}:${h.score}`).join(','));
  }

  // 4) 웹검색: AI가 최신 정보가 필요하다고 판단했거나, 명시적으로 검색을 요청한 경우
  const explicitWeb = /검색|인터넷|웹|뉴스|블로그|카페/.test(message);
  let searchSources = [];
  const wantWeb = mode !== 'roleplay' && !urlMatch && (explicitWeb || (needWeb && !(mode === 'insurance' && (productDocs.length || knowledgeHits.length))) ||
    (SEARCH_TRIGGER.test(message) && productDocs.length === 0 && knowledgeHits.length === 0 && mode !== 'coaching'));
  if (wantWeb) {
    const found = await webSearch(message, safeHistory);
    if (found && found.text) {
      searchSources = found.sources;
      pageContext += `\n\n[웹검색 결과 — 아래 내용을 근거로 답하고, 출처는 따로 붙이므로 본문에 URL을 적지 마세요. 검색 결과에 없는 내용은 지어내지 마세요.]\n${found.text}`;
    } else {
      pageContext += `\n\n[참고: 웹검색을 시도했지만 결과를 가져오지 못했습니다. 최신 정보는 확인하지 못했다고 솔직히 안내하고, 아는 범위에서만 답하세요.]`;
    }
  }

  const productContext = productDocs.length
    ? `\n\n[월별 보험사 상품자료 — ${productDocs[0].month}, 관리자가 등록한 자료]\n` +
      `이 질문에는 아래 자료를 근거로 분석해서 답하세요. 규칙:\n` +
      `- 자료에 있는 내용만 사용하고, 없는 보험료·수치·보장은 지어내지 말고 "자료에 없음"이라고 하세요.\n` +
      `- 경쟁력 판단은 보장 범위, 보험료/환급률, 가입 조건, 갱신·면책 등 불리한 조건, 차별점, 설계사 판매 포인트 같은 기준을 먼저 한 줄로 밝히고, 기준별로 비교해 상위 몇 개를 근거와 함께 추천하세요.\n` +
      `- 각 항목에 보험사명과 자료 제목을 함께 적으세요. 마지막에 "참고용 분석이며 최종 판단은 상품설명서·약관 확인 필요"를 한 줄로 덧붙이세요.\n` +
      `- 자료가 부족하면 부족한 부분만 짚고 있는 자료로 최대한 분석하세요.\n\n` +
      productDocs.map(d => `■ ${d.company} — ${d.title}${d.truncated ? ' (일부만 반영)' : ''}\n${d.content}`).join('\n\n')
    : '';

  const notices = [...new Set(knowledgeHits.map(h => h.notice).filter(Boolean))];
  const knowledgeContext = knowledgeHits.length
    ? `\n\n[학습 지식창고 — 관리자가 등록한 전문 자료에서 질문과 관련된 부분]\n` +
      `규칙:\n` +
      `- 질문과 실제로 관련 있는 자료만 활용하고, 관련 없으면 무시하세요.\n` +
      `- "원칙/절차/판례/주의/상품조합/용어" 노트는 블로그·영상 내용을 정리한 학습 내용입니다. 문장을 그대로 옮기지 말고, 설계사가 고객에게 설명하기 쉽게 자신의 말로 풀어 쓰세요.\n` +
      `- 판례·수치·보험료는 자료에 있는 값만 쓰고, 없으면 "자료에 없음"이라고 하세요. 지어내지 마세요.\n` +
      `- "표자료"는 보험사별 보험료·조건 비교표입니다. 줄은 표의 행, " | "는 칸 구분입니다. 남/여, 연령, 납입기간, 가입금액 기준을 확인해 정확히 읽고, 기준이 다른 숫자를 섞어 비교하지 마세요.\n` +
      `- "약관원문"은 보험사 약관 PDF의 해당 쪽을 글자 그대로 보관한 것입니다. 보장 범위·면책·지급 조건은 자료의 문구에 근거해 설명하고, 어느 상품·쪽인지 밝히세요(상품명이 다른 약관이 함께 나오면 상품별로 구분해 설명하고, 상품마다 내용이 다르면 차이를 짚어 주세요). 자료의 [보험사]는 질문에 나온 보험사 약관입니다. 자료에 없는 조항은 추측하지 말고 "올려진 약관에서 찾지 못했다"고 하세요. 약관은 가입 시점·개정 버전에 따라 다를 수 있으니 실제 계약의 약관 확인이 필요하다고 한 줄 덧붙이세요.\n` +
      `- 활용한 자료의 번호를 JSON의 used 배열에 담으세요.\n` +
      (notices.length ? `- 아래 자료에는 사용 제한이 있습니다. 답변 끝에 그 제한을 한 줄로 반드시 알려주세요: ${notices.join(' / ')}\n` : '') +
      `\n` +
      knowledgeHits.map((h, i) => `[자료${i + 1}] (${h.company ? '[' + h.company + '] ' : ''}${h.sourceName} — ${h.title}${h.page ? ' p.' + h.page : ''}${h.noteType ? ', ' + h.noteType : ''})\n${h.topic && !h.page ? '주제: ' + h.topic + '\n' : ''}${h.content}`).join('\n\n')
    : '';
  const heavyContext = productDocs.length > 0 || knowledgeHits.length > 0;

  const wantMedia = (mode === 'general' || mode === 'insurance') && /영상|동영상|비디오|보여/.test(message);
  const systemPrompt = buildSystemPrompt(mode, {
    termsDb, claimsDb, mediaDb, wantMedia,
    extra: `${pageContext}${productContext}${knowledgeContext}`,
  });

  const model = mode === 'general'
    ? (process.env.GENERAL_MODEL || 'gpt-4.1')
    : mode === 'roleplay'
      ? (process.env.GENERAL_MODEL || 'gpt-4.1')
      : (process.env.ANALYSIS_MODEL || 'gpt-4.1');
  const maxTokens = mode === 'roleplay' ? 900 : (heavyContext || mode === 'coaching') ? 2500 : 3000;
  const temperature = mode === 'insurance' ? 0.3 : mode === 'coaching' ? 0.6 : 0.7;

  try {
    const openaiRes = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model,
        response_format: { type: 'json_object' },
        messages: [
          { role: 'system', content: systemPrompt },
          ...safeHistory.map(h => ({ role: h.role, content: h.content })),
          { role: 'user', content: message },
        ],
        max_tokens: maxTokens,
        temperature,
      }),
    });

    if (!openaiRes.ok) {
      const errText = await openaiRes.text();
      console.error('AI 상담 API 오류:', errText);
      return res.status(502).json({ error: 'AI 상담 서비스 호출에 실패했습니다.' });
    }

    const data = await openaiRes.json();
    const raw = data.choices?.[0]?.message?.content || '{}';
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch (e) {
      parsed = { reply: raw, speech: raw, action: null };
    }
    let replyText = parsed.reply || '죄송합니다, 답변을 만들지 못했습니다. 다시 한 번 말씀해주세요.';
    const usedIdx = Array.isArray(parsed.used)
      ? [...new Set(parsed.used.map(Number).filter(n => Number.isInteger(n) && n >= 1 && n <= knowledgeHits.length))]
      : [];
    if (usedIdx.length) {
      const seenSrc = new Set();
      const lines = [];
      for (const n of usedIdx) {
        const h = knowledgeHits[n - 1];
        const label = h.page ? `${h.sourceName} p.${h.page}` : `「${h.title}」 — ${h.sourceName}`;
        const key = label + (h.url || '');
        if (seenSrc.has(key)) continue;
        seenSrc.add(key);
        lines.push(`${lines.length + 1}. ${label}${h.url ? '\n' + h.url : ''}`);
      }
      replyText += '\n\n📚 학습 자료 (정리된 내용 기준, 원문·약관 확인 권장)\n' + lines.join('\n');
    }
    if (searchSources.length) {
      replyText += '\n\n📎 출처 (웹검색, 원문 확인 권장)\n' +
        searchSources.slice(0, 5).map((s, i) => `${i + 1}. ${s.title || s.url}\n${s.url}`).join('\n');
    }
    res.json({
      reply: replyText,
      speech: parsed.speech || parsed.reply || '',
      action: parsed.action || null,
      mode,
    });
  } catch (err) {
    console.error('AI 상담 처리 중 오류:', err);
    res.status(500).json({ error: '서버 내부 오류' });
  }
});

// ── 2) 첨부 사진/서류 분석 (OpenAI Vision) ──────────────────────
app.post('/api/vision', upload.single('file'), async (req, res) => {
  if (!process.env.OPENAI_API_KEY) {
    return res.status(500).json({ error: 'OPENAI_API_KEY 환경변수가 설정되지 않았습니다.' });
  }
  if (!req.file) {
    return res.status(400).json({ error: '분석할 이미지가 전달되지 않았습니다.' });
  }
  const question = (req.body.question || '').trim() ||
    '이 사진/서류에 어떤 내용이 담겨 있는지 설계사 업무 관점에서 요약해줘. 보험 관련 서류라면 상품명, 특약, 보장내용, 유의사항 등을 정리해줘.';

  try {
    const base64 = req.file.buffer.toString('base64');
    const mime = req.file.mimetype || 'image/jpeg';
    const openaiRes = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: 'gpt-4o-mini',
        messages: [
          { role: 'system', content: '당신은 보험설계사(리더스사업부)를 돕는 AI 비서입니다. 첨부된 이미지를 꼼꼼히 읽고, 한국어로 실무에 바로 도움이 되도록 답변하세요.' },
          {
            role: 'user',
            content: [
              { type: 'text', text: question },
              { type: 'image_url', image_url: { url: `data:${mime};base64,${base64}` } },
            ],
          },
        ],
        max_tokens: 700,
      }),
    });

    if (!openaiRes.ok) {
      const errText = await openaiRes.text();
      console.error('Vision API 오류:', errText);
      return res.status(502).json({ error: '이미지 분석 서비스 호출에 실패했습니다.' });
    }

    const data = await openaiRes.json();
    const answer = data.choices?.[0]?.message?.content || '내용을 분석하지 못했습니다.';
    res.json({ answer });
  } catch (err) {
    console.error('이미지 분석 중 오류:', err);
    res.status(500).json({ error: '서버 내부 오류' });
  }
});

// ── 3) 로그인 / 회원가입 ──────────────────────────────────────
app.use('/api/auth', authRoutes);

// ── 4) 개인 일정 (카테고리별, 로그인 필요) ─────────────────────
app.use('/api/schedule', scheduleRoutes);

// ── 5) 관리자 전용 기능 (승인 관리, 약관/보상사례 관리) ──────────
app.use('/api/admin/knowledge', verifyToken, requireSuperAdmin, knowledge.router);
app.use('/api/admin', adminRoutes);

// ── 6) 약관/보상사례 읽기 (로그인한 설계사 전체) ─────────────────
app.use('/api/content', contentRoutes);

// ── 7) 지사 목록 (회원가입 화면은 로그인 전이라 인증 없이 조회 가능) ─
app.use('/api/branches', branchRoutes);

const PORT = process.env.PORT || 3000;

initDb()
  .catch(err => console.error('DB 초기화 중 오류:', err))
  .finally(() => {
    app.listen(PORT, () => {
      console.log(`리더스 AI 비서 백엔드 서버 실행 중 (port ${PORT})`);
    });
  });
