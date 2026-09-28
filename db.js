/**
 * db.js — Postgres 연결 + 테이블(카테고리별 DB) 초기화
 *
 * 하나의 Postgres 서버 안에서도, 데이터 종류별로 테이블을 완전히 분리해서
 * "여러 개의 DB에 나눠 담는다"는 원래 요구사항을 구현합니다.
 *   - branches  : 지사 목록 (지사장이 자기 지사 소속 설계사만 관리하도록 구분)
 *   - users     : 설계사 계정 (로그인/비밀번호, 관리자 승인 여부, 권한, 소속 지사)
 *   - schedules : 설계사 개인 일정 (카테고리별: 미팅/계약/방문/개인/기타)
 *   - clients   : (확장용) 고객 정보 — 지금은 비어 있고 나중에 채워 넣을 수 있습니다
 *   - notes     : (확장용) 자유 메모 — 카테고리 태그로 구분
 *   - terms     : 약관/특약 DB — 관리자가 등록·수정하면 모든 설계사 화면에 즉시 반영
 *   - claims    : 보상사례 DB — 위와 동일하게 관리자 전용 공용 데이터
 *
 * 약관·보상사례는 원래 프런트엔드 코드 안에 "가상 데이터"로 박혀 있었지만,
 * 관리자 화면에서 바꾸면 전체 설계사에게 즉시 반영되어야 한다는 요구사항 때문에
 * 이제 이 서버(DB)가 담당하고, 프런트엔드는 로그인한 뒤 API로 받아옵니다.
 */

const { Pool } = require('pg');

if (!process.env.DATABASE_URL) {
  console.warn('⚠️  DATABASE_URL 환경변수가 없습니다. Railway에서 Postgres를 추가하면 자동으로 채워집니다.');
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL ? { rejectUnauthorized: false } : false,
});

async function initDb() {
  if (!process.env.DATABASE_URL) return; // 로컬에서 DB 없이 STT만 테스트할 때는 건너뜀

  // ── 지사 목록 ────────────────────────────────────────────────
  // 지사장(branch_admin)은 자기 지사에 속한 설계사만 승인/관리할 수 있고,
  // 상무(super_admin)만 전체 지사·전체 설계사를 볼 수 있습니다.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS branches (
      id SERIAL PRIMARY KEY,
      name TEXT UNIQUE NOT NULL,
      created_at TIMESTAMPTZ DEFAULT now()
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL,
      login_id TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT 'agent',
      approved BOOLEAN NOT NULL DEFAULT false,
      approved_at TIMESTAMPTZ,
      branch_id INTEGER REFERENCES branches(id),
      created_at TIMESTAMPTZ DEFAULT now()
    );
  `);
  // 기존에 이미 만들어진 테이블에도 새 컬럼이 없으면 추가 (업데이트 호환)
  await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS role TEXT NOT NULL DEFAULT 'agent';`);
  await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS approved BOOLEAN NOT NULL DEFAULT false;`);
  await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS approved_at TIMESTAMPTZ;`);
  await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS branch_id INTEGER REFERENCES branches(id);`);
  // 이전 버전에서 만들어진 'admin' 역할은 '상무(전체관리자)'에 해당하는 super_admin으로 이전
  await pool.query(`UPDATE users SET role = 'super_admin' WHERE role = 'admin';`);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS schedules (
      id SERIAL PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      category TEXT NOT NULL DEFAULT '기타',
      title TEXT NOT NULL,
      time_label TEXT,
      memo TEXT,
      remind_before_min INTEGER DEFAULT 60,
      created_at TIMESTAMPTZ DEFAULT now()
    );
  `);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_schedules_user ON schedules(user_id);`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_schedules_category ON schedules(category);`);

  // 확장용 테이블 — 지금은 API가 없지만, 나중에 고객관리/메모 기능을 붙일 때
  // 같은 패턴(사용자별 격리 + 카테고리 컬럼)으로 바로 확장할 수 있습니다.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS clients (
      id SERIAL PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      category TEXT NOT NULL DEFAULT '기타',
      name TEXT NOT NULL,
      phone TEXT,
      memo TEXT,
      created_at TIMESTAMPTZ DEFAULT now()
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS notes (
      id SERIAL PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      category TEXT NOT NULL DEFAULT '기타',
      content TEXT NOT NULL,
      created_at TIMESTAMPTZ DEFAULT now()
    );
  `);

  // ── 관리자가 관리하는 공용 데이터 (전 설계사 공통) ──────────────
  await pool.query(`
    CREATE TABLE IF NOT EXISTS terms (
      id SERIAL PRIMARY KEY,
      company TEXT NOT NULL,
      product TEXT NOT NULL,
      rider TEXT NOT NULL,
      coverage TEXT NOT NULL,
      exclusions JSONB NOT NULL DEFAULT '[]',
      updated_by INTEGER REFERENCES users(id),
      created_at TIMESTAMPTZ DEFAULT now(),
      updated_at TIMESTAMPTZ DEFAULT now()
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS claims (
      id SERIAL PRIMARY KEY,
      case_title TEXT NOT NULL,
      summary TEXT NOT NULL,
      range_desc TEXT NOT NULL,
      note TEXT,
      updated_by INTEGER REFERENCES users(id),
      created_at TIMESTAMPTZ DEFAULT now(),
      updated_at TIMESTAMPTZ DEFAULT now()
    );
  `);

  // 처음 배포 시, 데모용 기본 데이터가 하나도 없으면 예시 몇 개를 심어둡니다
  // (관리자 화면에서 바로 수정·삭제할 수 있습니다).
  const termsCount = await pool.query('SELECT COUNT(*) FROM terms');
  if (Number(termsCount.rows[0].count) === 0) {
    await pool.query(
      `INSERT INTO terms (company, product, rider, coverage, exclusions) VALUES
       ($1, $2, $3, $4, $5)`,
      [
        '한빛생명', '무배당 건강보험', '암진단특약',
        '최초 1회 암 진단 확정 시 가입금액 지급 (유사암은 20% 지급)',
        JSON.stringify([
          '계약일로부터 90일 이내 진단 확정된 암',
          '제자리암, 경계성종양 등 유사암은 별도 한도 적용',
          '피보험자의 고의 또는 자해로 인한 사고는 보장하지 않음'
        ])
      ]
    );
  }

  const claimsCount = await pool.query('SELECT COUNT(*) FROM claims');
  if (Number(claimsCount.rows[0].count) === 0) {
    await pool.query(
      `INSERT INTO claims (case_title, summary, range_desc, note) VALUES ($1, $2, $3, $4)`,
      [
        '암 진단비 청구 사례',
        "조직검사로 위암 확진 시 가입 특약의 진단비 전액이 통상 지급되며, 병기(stage)와 무관하게 '암 진단 확정' 자체가 지급 사유입니다.",
        '가입금액 100% (유사암·경계성 종양이 아닌 경우)',
        '90일 면책기간, 재진단 여부 등 약관상 조건 충족 여부를 먼저 확인해야 합니다.'
      ]
    );
  }

  console.log('✅ DB 테이블 준비 완료 (branches / users / schedules / clients / notes / terms / claims)');
}

module.exports = { pool, initDb };
