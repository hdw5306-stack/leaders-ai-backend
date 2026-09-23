# 리더스 AI 비서 — 백엔드 서버 배포 가이드 (Railway)

이 서버는 `leaders-ai-assistant.html` 한 개를 위한 백엔드로, 네 가지 역할을 합니다.

1. **음성인식(STT) 중계** — 아이폰처럼 브라우저 자체 음성인식이 안 되는 환경에서, 녹음된 음성을 받아 OpenAI Whisper API로 텍스트 변환
2. **첨부 사진/서류 분석** — 채팅 중 올린 사진(고객 서류, 상품 팜플렛 등)을 OpenAI Vision(gpt-4o-mini)으로 분석해 질문에 답변. 사진은 저장하지 않고 분석 즉시 폐기합니다.
3. **로그인 / 회원가입** — 설계사별 별도 계정(자체 아이디/비밀번호)
4. **개인 일정 저장** — 로그인한 설계사 본인의 일정만, 카테고리(미팅/계약/방문/개인/기타)별로 데이터베이스에 저장·조회·삭제

리더스 헬스 나침반과 동일한 방식(Railway)으로 배포합니다.

---

## 1. OpenAI API 키 준비 (음성인식 + 사진 분석 공용)

1. https://platform.openai.com 접속 후 로그인/가입
2. 좌측 메뉴 **API keys** → **Create new secret key** → 키 복사해두기 (다시 볼 수 없으니 안전한 곳에 저장)
3. 좌측 메뉴 **Settings → Limits** (또는 Billing → Usage limits)에서 월 사용 한도를 걸어두는 것을 권장합니다 (예: 월 $20~30)

같은 키 하나로 음성인식(Whisper)과 채팅 첨부 사진 분석(Vision)을 모두 처리하므로, 별도 키를 추가로 발급받을 필요는 없습니다.

## 2. GitHub에 이 폴더 올리기

이 `backend-server` 폴더를 GitHub 저장소로 올립니다 (헬스 나침반 때와 동일한 절차입니다).

```
cd backend-server
git init
git add .
git commit -m "리더스 AI 비서 백엔드 서버"
git branch -M main
git remote add origin <새로 만든 GitHub 저장소 주소>
git push -u origin main
```

GitHub 데스크톱 앱이나 웹에서 직접 업로드하셔도 됩니다.

## 3. Railway에 배포

1. https://railway.app 접속 → 로그인
2. **New Project** → **Deploy from GitHub repo** → 방금 올린 저장소 선택
3. Railway가 `package.json`을 자동으로 인식해서 빌드/실행합니다 (별도 설정 불필요)

## 4. 데이터베이스(Postgres) 추가 — 로그인 · 일정 저장에 필요

로그인과 개인 일정 저장 기능을 쓰려면 데이터베이스가 필요합니다. (음성인식만 쓰고 싶다면 이 단계는 건너뛰어도 됩니다.)

1. 방금 만든 Railway 프로젝트 화면에서 **+ New** → **Database** → **Add PostgreSQL**
2. 몇 초 안에 Postgres가 추가되고, `DATABASE_URL` 값이 자동으로 서버 프로젝트의 환경변수에 연결됩니다 (직접 입력할 필요 없음)
3. 서버가 처음 켜질 때 필요한 테이블(계정/일정 등)을 자동으로 만듭니다 — 별도 명령 불필요

## 5. 환경변수 설정

배포된 서버 프로젝트 → **Variables** 탭에서 아래 값들을 추가하세요.

| 변수명 | 설명 |
|---|---|
| `OPENAI_API_KEY` | 1번에서 발급받은 키 (음성인식용) |
| `ALLOWED_ORIGINS` | `https://m.leadersfc.co.kr` (실제 서비스 도메인. 여러 개면 콤마로 구분) |
| `JWT_SECRET` | 로그인 토큰 서명용 임의의 긴 문자열 (예: 영문+숫자 32자 이상, 아무 값이나 만들어 넣으면 됩니다) |
| `DATABASE_URL` | 4번에서 Postgres를 추가했다면 Railway가 자동으로 채워줍니다 (직접 입력 불필요) |

## 6. 도메인 발급

1. 서버 프로젝트 → **Settings** 탭 → **Networking → Generate Domain** 클릭 → `xxxx.up.railway.app` 형태의 주소 발급
2. 브라우저에서 그 주소를 열어 `{"status":"ok", ...}` 가 뜨면 배포 성공

## 7. 프런트엔드(leaders-ai-assistant.html)에 서버 주소 연결

`leaders-ai-assistant.html` 안에서 아래 줄을 찾아:

```js
const API_BASE = ''; // 예: 'https://xxxx.up.railway.app'
```

발급받은 Railway 주소로 채워 넣습니다:

```js
const API_BASE = 'https://xxxx.up.railway.app';
```

이후 이 HTML 파일을 다시 m.leadersfc.co.kr에 업로드하면,
- 아이폰에서도 녹음된 음성이 서버를 거쳐 텍스트로 변환되고,
- 설계사별 로그인/회원가입 화면이 뜨고,
- 로그인한 설계사의 일정이 서버에 저장되어 기기를 바꿔도 유지됩니다.

`API_BASE`를 비워두면 로그인·일정 저장 기능은 "둘러보기(브라우저에만 임시 저장)" 모드로 자동 전환되어, 서버 연결 전에도 데모는 계속 확인할 수 있습니다.

### (선택) 나중에 Railway 도메인 대신 회사 서브도메인 쓰기

Railway의 **Settings → Networking → Custom Domain**에서 원하는 서브도메인
(예: `api.leadersfc.co.kr`)을 추가하고, 카페24 도메인 관리에서 그 서브도메인에
대한 CNAME 레코드를 Railway가 안내하는 값으로 연결하면 됩니다. 헬스 나침반의
서브도메인 연결과 같은 절차입니다.

## 8. 데이터베이스 구조 (카테고리/항목별 분리)

하나의 Postgres 서버 안에서도, 데이터 종류별로 테이블을 완전히 나눠서 저장합니다.

- `users` — 설계사 계정 (이름, 아이디, 비밀번호 해시)
- `schedules` — 개인 일정. `category` 컬럼으로 미팅/계약/방문/개인/기타 구분, `user_id`로 설계사별 격리
- `clients` — (확장용) 고객 정보. 지금은 API가 연결되어 있지 않지만, 나중에 고객관리 기능을 붙일 때 같은 구조로 바로 확장할 수 있도록 미리 만들어 두었습니다
- `notes` — (확장용) 자유 메모, 카테고리 태그로 구분

약관(TERMS_DB)·보상사례(CLAIMS_DB) 같은 전 설계사 공통 데이터는 이 서버가 아니라 프런트엔드 프로토타입 안에 그대로 두었습니다 — 개인별로 격리할 필요가 없는 공용 데이터이기 때문입니다. 실제 서비스로 확장할 때는 이 데이터도 별도의 벡터DB/문서DB로 옮기면 됩니다 (앞서 설명 드린 구조 그대로입니다).

## 9. 비용 안내

- Railway: 무료 크레딧 소진 후에는 사용한 만큼 과금되는 종량제입니다. Postgres 추가 시 약간의 리소스 비용이 더 붙습니다.
- OpenAI Whisper API(음성인식): 처리한 오디오 분량만큼 과금됩니다.
- OpenAI Vision(gpt-4o-mini, 사진 분석): 이미지 1장+질문 기준 매우 저렴한 편이지만(대략 건당 1원~수원 단위), 사용량이 많아지면 누적됩니다. 최신 요금은 OpenAI 공식 요금 페이지에서 확인하세요.
- 세 서비스 모두 결제수단은 나중에 법인카드로 교체 가능합니다 (Billing 설정에서 카드 정보만 바꾸면 됩니다).

## 10. 다른 STT 서비스로 교체하고 싶다면

`server.js` 안의 `app.post('/api/stt', ...)` 함수 안, OpenAI Whisper를
호출하는 부분만 원하는 서비스(예: 네이버 클로바 스피치)의 API 스펙에 맞게
바꾸면 됩니다. 로그인/일정 기능(`auth.js`, `schedule.js`)은 이 변경과 무관하게
그대로 동작합니다.
