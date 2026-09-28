/**
 * server.js — 리더스 AI 비서 백엔드 서버
 *
 * 역할 4가지:
 *   1) 음성인식(STT) 중계 — leaders-ai-assistant.html이 iOS 등 Web Speech API
 *      미지원 환경에서 녹음한 오디오를 받아 OpenAI Whisper API로 전달
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
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
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

const PORT = process.env.PORT || 3000;

initDb()
  .catch(err => console.error('DB 초기화 중 오류:', err))
  .finally(() => {
    app.listen(PORT, () => {
      console.log(`리더스 AI 비서 백엔드 서버 실행 중 (port ${PORT})`);
    });
  });
