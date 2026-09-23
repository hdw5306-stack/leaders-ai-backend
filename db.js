/**
 * db.js — Postgres 연결 + 테이블(카테고리별 DB) 초기화
 *
 * 하나의 Postgres 서버 안에서도, 데이터 종류별로 테이블을 완전히 분리해서
 * "여러 개의 DB에 나눠 담는다"는 원래 요구사항을 구현합니다.
 *   - users     : 설계사 계정 (로그인/비밀번호)
 *   - schedules : 설계사 개인 일정 (카테고리별: 미팅/계약/방문/개인/기타)
 *   - clients   : (확장용) 고객 정보 — 지금은 비어 있고 나중에 채워 넣을 수 있습니다
 *   - notes     : (확장용) 자유 메모 — 카테고리 태그로 구분
 *
 * 실제 약관/보상사례 DB(TERMS_DB, CLAIMS_DB)는 전 설계사 공통 데이터라
 * 프런트엔드 프로토타입에 그대로 두었고, 이 서버는 "개인별로 격리되어야
 * 하는" 데이터(계정, 일정 등)만 담당합니다.
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

  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL,
      login_id TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      created_at TIMESTAMPTZ DEFAULT now()
    );
  `);

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

  console.log('✅ DB 테이블 준비 완료 (users / schedules / clients / notes)');
}

module.exports = { pool, initDb };
