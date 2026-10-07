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
const { initDb } = require('./db');
const { router: authRoutes } = require('./auth');
const scheduleRoutes = require('./schedule');
const adminRoutes = require('./admin');
const contentRoutes = require('./content');
const branchRoutes = require('./branches');

const app = express();
app.use(express.json());
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
  const { text, voice } = req.body || {};
  if (!text || !text.trim()) {
    return res.status(400).json({ error: '읽어줄 텍스트가 없습니다.' });
  }
  const allowedVoices = ['alloy', 'echo', 'fable', 'onyx', 'nova', 'shimmer'];
  const useVoice = allowedVoices.includes(voice) ? voice : 'nova';

  try {
    const openaiRes = await fetch('https://api.openai.com/v1/audio/speech', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: 'tts-1',
        voice: useVoice,
        input: text.slice(0, 1000), // 답변이 너무 길면 앞부분만 음성으로 읽어줍니다
        response_format: 'mp3',
      }),
    });

    if (!openaiRes.ok) {
      const errText = await openaiRes.text();
      console.error('TTS API 오류:', errText);
      return res.status(502).json({ error: '음성 합성 서비스 호출에 실패했습니다.' });
    }

    const arrayBuffer = await openaiRes.arrayBuffer();
    res.set('Content-Type', 'audio/mpeg');
    res.send(Buffer.from(arrayBuffer));
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
  const models = [process.env.SEARCH_MODEL, 'gpt-4.1-mini', 'gpt-4o-mini', 'gpt-5-mini'].filter(Boolean);
  const context = (history || []).slice(-4).map(h => `${h.role === 'user' ? '사용자' : '비서'}: ${h.content}`).join('\n');
  const input = `${context ? '[직전 대화]\n' + context + '\n\n' : ''}[검색 요청]\n${query}\n\n웹에서 찾아 핵심만 한국어로 정리하세요. 확인되지 않은 내용은 쓰지 마세요.`;
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
      if (text) return { text: text.slice(0, 6000), sources };
    } catch (e) {
      console.error(`웹검색 오류(${model}):`, e.message);
      diag.push({ model, exception: e.message });
    }
  }
  return null;
}

// [임시 진단용] 브라우저 주소창에서 웹검색이 되는지 바로 확인합니다. 확인 후 삭제하세요.
// 사용: /api/debug/search?code=<관리자코드>&q=검색어
app.get('/api/debug/search', async (req, res) => {
  if (!process.env.ADMIN_SIGNUP_CODE || req.query.code !== process.env.ADMIN_SIGNUP_CODE) {
    return res.status(403).json({ error: '코드가 올바르지 않습니다.' });
  }
  const diag = [];
  const q = String(req.query.q || '오늘 보험 관련 최신 뉴스');
  const found = await webSearch(q, [], diag);
  res.json({
    openaiKeySet: !!process.env.OPENAI_API_KEY,
    searchModelEnv: process.env.SEARCH_MODEL || null,
    triggerMatches: SEARCH_TRIGGER.test(q),
    result: found ? { textPreview: found.text.slice(0, 400), sources: found.sources } : null,
    diag,
  });
});

// ── 1-2) AI 상담(대화형) ────────────────────────────────────────
// 기존에는 질문 속 특정 단어("암" 등)만 보고 미리 정해둔 답 중 하나를
// 고르는 방식이라 "암 수술 영상 보여줘" 같은 질문에 "암 진단비 청구
// 사례"처럼 엉뚱한 답이 나가는 문제가 있었습니다. 이제는 질문 전체를
// OpenAI에 보내 실제 의도를 이해하고 자연스럽게 답하게 합니다.
// 약관/보상사례/미디어 DB는 참고자료로만 함께 보내고, 답을 그 안에서
// 찾을지, 일반 지식으로 답할지는 AI가 스스로 판단합니다.
// 메시지에 URL(블로그/홈페이지 주소)이 포함되어 있으면, 그 페이지 내용을
// 직접 불러와 참고자료로 함께 제공해서 요약·질의응답이 가능하게 합니다.
app.post('/api/chat', async (req, res) => {
  if (!process.env.OPENAI_API_KEY) {
    return res.status(500).json({ error: 'OPENAI_API_KEY 환경변수가 설정되지 않았습니다.' });
  }
  const { message, termsDb, claimsDb, mediaDb, history } = req.body || {};
  if (!message || !message.trim()) {
    return res.status(400).json({ error: '질문 내용이 없습니다.' });
  }
  // 최근 대화 몇 턴을 함께 보내서, 끝말잇기처럼 앞뒤 대화가 이어져야 하는
  // 경우에도 문맥을 기억하게 합니다. (너무 길어지지 않게 최근 12개만 사용)
  const safeHistory = Array.isArray(history)
    ? history
        .filter(h => h && (h.role === 'user' || h.role === 'assistant') && typeof h.content === 'string')
        .slice(-12)
    : [];

  // 메시지에 URL이 있으면 그 페이지 내용을 직접 불러와 참고자료로 추가합니다.
  let pageContext = '';
  const urlMatch = message.match(/https?:\/\/[^\s)\]]+/i);
  if (urlMatch) {
    const targetUrl = urlMatch[0];
    const pageText = await fetchPageText(targetUrl);
    pageContext = pageText
      ? `\n\n[사용자가 알려준 웹페이지 내용 — 출처: ${targetUrl}]\n${pageText}`
      : `\n\n[참고: 사용자가 알려준 주소(${targetUrl})를 불러오지 못했습니다 — 로그인이 필요하거나 접속을 차단하는 사이트일 수 있습니다. 이 사실을 사용자에게 솔직히 안내하세요.]`;
  }

  // URL이 없고 "검색/찾아줘/최신/뉴스" 같은 표현이 있으면 웹검색을 먼저 합니다.
  let searchSources = [];
  console.log('[채팅] 질문:', message.slice(0, 60), '| URL있음:', !!urlMatch, '| 검색조건:', SEARCH_TRIGGER.test(message));
  if (!urlMatch && SEARCH_TRIGGER.test(message)) {
    const found = await webSearch(message, safeHistory);
    if (found && found.text) {
      searchSources = found.sources;
      pageContext += `\n\n[웹검색 결과 — 아래 내용을 근거로 답하고, 출처는 따로 붙이므로 본문에 URL을 적지 마세요. 검색 결과에 없는 내용은 지어내지 마세요.]\n${found.text}`;
    } else {
      pageContext += `\n\n[참고: 웹검색을 시도했지만 결과를 가져오지 못했습니다. 최신 정보는 확인하지 못했다고 솔직히 안내하고, 아는 범위에서만 답하세요.]`;
    }
  }

  const systemPrompt = `당신은 설계사가 업무 중에 편하게 쓰는 만능 AI 비서입니다. 보험 업무 도우미이기 이전에, ChatGPT와 똑같이 세상 모든 주제에 대해 자연스럽게 대화하고 도와줄 수 있는 범용 AI입니다. 실제 대화 중 보험 얘기가 나오는 비중은 일부일 뿐이고, 대부분은 평범한 대화·잡담·게임·일반 지식 질문이라고 생각하고 응답하세요.

가장 중요한 원칙 (절대 어기지 마세요):
- 질문의 주제가 보험이 아니라는 이유로 "보험 관련 질문만 해주세요", "그런 건 도와드릴 수 없어요", "다른 질문을 해주세요" 같은 식으로 절대 거절하지 마세요. 이런 거절은 명백한 오류입니다.
- 끝말잇기, 스무고개, 수수께끼 같은 말놀이를 하자고 하면 지금 바로 게임을 시작하세요. 예를 들어 끝말잇기면 당신이 먼저 단어를 하나 제시하고, 이전 대화에서 나온 단어를 기억해서 이어가세요.
- 날씨, 시사, 계산, 상식, 번역, 글쓰기, 고민상담, 잡담 등 보험과 무관한 어떤 주제든 일반 ChatGPT처럼 적극적으로 도와주세요.
- 아래 참고자료(약관/보상사례/영상 목록)는 질문이 "실제로" 보험 업무와 관련 있을 때만 사용하고, 그 외에는 완전히 무시하세요. 참고자료에 없는 내용이라고 모른다고 하지 말고, 당신이 알고 있는 일반 지식으로 답하세요.
- 사용자가 메시지에 웹페이지 주소(URL)를 붙여넣으면, 아래 [사용자가 알려준 웹페이지 내용]에 그 페이지의 실제 글 내용이 들어있습니다. 이걸 바탕으로 요약하거나 질문에 답하세요. 페이지를 불러오지 못했다는 안내가 있으면 솔직히 그렇게 전달하세요.

예시 (반드시 이런 식으로 응답하세요):
- 사용자: "끝말잇기 하자" → reply: "좋아요! 제가 먼저 할게요. '사과'! 이제 '과'로 시작하는 단어를 말씀해주세요." (보험 얘기를 꺼내지 않음)
- 사용자: "오늘 날씨 어때?" → 실시간 날씨는 알 수 없으니 그렇게 솔직히 답하고, 일반적인 조언(외출 전 날씨 앱 확인 등)을 자연스럽게 제공 (보험 얘기를 꺼내지 않음)
- 사용자: "피보나치 수열이 뭐야?" → 일반 지식으로 설명 (보험 얘기를 꺼내지 않음)
- 사용자: "암보험 면책기간이 어떻게 돼?" → 이때만 아래 약관 DB를 참고해서 답변

아래는 보험 업무 질문일 때만 참고할 사내 데이터입니다.

[약관 DB]
${JSON.stringify(termsDb || [])}

[보상사례 DB]
${JSON.stringify(claimsDb || [])}

[미디어(영상) DB] — 실제 영상 파일은 없는 데모이며 제목/태그만 있습니다. 사용자가 영상을 보여달라고 하면, 그중 관련 있는 제목을 1개~여러 개 골라 action.titles 배열에 정확히 그대로 담으세요 (하나를 임의로 골라 바로 재생하지 말고, 후보를 보여줘서 사용자가 직접 고르게 합니다). 관련 있는 영상이 하나도 없으면 action은 null로 하되, 딱딱하게 "준비되어 있지 않다"고만 하지 말고 지금 어떤 영상들이 있는지 안내하거나 다른 방식으로 도와줄 방법을 제안하세요.
${JSON.stringify(mediaDb || [])}
${pageContext}

반드시 아래 JSON 형식으로만, 다른 설명 없이 답하세요 (마크다운 기호 없이 일반 문장으로):
{
  "reply": "화면에 보여줄 답변 (존댓말, 필요시 줄바꿈 포함)",
  "speech": "음성으로 읽어줄 짧은 한두 문장 요약",
  "action": null 또는 { "type": "media_list", "titles": ["미디어 DB의 title 값과 정확히 동일한 문자열", "..."] }
}`;

  try {
    const openaiRes = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: 'gpt-4o-mini',
        response_format: { type: 'json_object' },
        messages: [
          { role: 'system', content: systemPrompt },
          ...safeHistory.map(h => ({ role: h.role, content: h.content })),
          { role: 'user', content: message },
        ],
        max_tokens: 700,
        temperature: 0.7,
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
    if (searchSources.length) {
      replyText += '\n\n📎 출처 (웹검색, 원문 확인 권장)\n' +
        searchSources.slice(0, 5).map((s, i) => `${i + 1}. ${s.title || s.url}\n${s.url}`).join('\n');
    }
    res.json({
      reply: replyText,
      speech: parsed.speech || parsed.reply || '',
      action: parsed.action || null,
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
app.use('/api/admin', adminRoutes);

// ── 6) 약관/보상사례 읽기 (로그인한 설계사 전체) ─────────────────
app.use('/api/content', contentRoutes);

// ── 7) 지사 목록 (회원가입 화면은 로그인 전이라 인증 없이 조회 가능) ─
app.use('/api/branches', branchRoutes);

// ── 임시: 상무(super_admin) 계정 아이디 확인용 ───────────────────
// 비밀번호를 잊어버렸을 때 "아이디가 뭐였는지"만 확인하는 1회성 기능입니다.
// 비밀번호는 암호화(해시)되어 있어 여기서도 알 수 없고, 아이디만 보여줍니다.
// 아무나 들어올 수 없도록 Railway의 ADMIN_SIGNUP_CODE 값을 아는 사람만
// 조회할 수 있게 해두었습니다. 확인이 끝나면 이 라우트는 삭제하는 것이
// 안전합니다 (요청하시면 바로 제거해 드립니다).
app.get('/api/debug/admins', async (req, res) => {
  if (!process.env.DATABASE_URL) {
    return res.status(503).json({ error: 'DB가 아직 연결되지 않았습니다.' });
  }
  if (!process.env.ADMIN_SIGNUP_CODE || req.query.code !== process.env.ADMIN_SIGNUP_CODE) {
    return res.status(403).json({ error: '접근 권한이 없습니다.' });
  }
  try {
    const { pool } = require('./db');
    const result = await pool.query(
      `SELECT name, login_id AS "loginId", role, approved FROM users WHERE role = 'super_admin' ORDER BY id`
    );
    res.json({ admins: result.rows });
  } catch (err) {
    console.error('관리자 조회 오류:', err);
    res.status(500).json({ error: '서버 내부 오류' });
  }
});

const PORT = process.env.PORT || 3000;

initDb()
  .catch(err => console.error('DB 초기화 중 오류:', err))
  .finally(() => {
    app.listen(PORT, () => {
      console.log(`리더스 AI 비서 백엔드 서버 실행 중 (port ${PORT})`);
    });
  });
