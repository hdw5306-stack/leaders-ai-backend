/**
 * auth.js — 별도 계정 로그인 (자체 아이디/비밀번호, JWT 발급)
 */

const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { pool } = require('./db');

const router = express.Router();
const JWT_SECRET = process.env.JWT_SECRET || 'change-this-secret-before-going-live';

function requireDb(req, res, next) {
  if (!process.env.DATABASE_URL) {
    return res.status(503).json({ error: 'DB가 아직 연결되지 않았습니다. Railway에서 Postgres를 추가해주세요.' });
  }
  next();
}

// 회원가입
router.post('/register', requireDb, async (req, res) => {
  const { name, loginId, password } = req.body || {};
  if (!name || !loginId || !password) {
    return res.status(400).json({ error: '이름, 아이디, 비밀번호를 모두 입력해주세요.' });
  }
  if (password.length < 6) {
    return res.status(400).json({ error: '비밀번호는 6자 이상이어야 합니다.' });
  }
  try {
    const existing = await pool.query('SELECT id FROM users WHERE login_id = $1', [loginId]);
    if (existing.rows.length > 0) {
      return res.status(409).json({ error: '이미 사용 중인 아이디입니다.' });
    }
    const hash = await bcrypt.hash(password, 10);
    const result = await pool.query(
      'INSERT INTO users (name, login_id, password_hash) VALUES ($1, $2, $3) RETURNING id, name',
      [name, loginId, hash]
    );
    const user = result.rows[0];
    const token = jwt.sign({ userId: user.id, name: user.name }, JWT_SECRET, { expiresIn: '90d' });
    res.json({ token, name: user.name });
  } catch (err) {
    console.error('회원가입 오류:', err);
    res.status(500).json({ error: '회원가입 처리 중 오류가 발생했습니다.' });
  }
});

// 로그인
router.post('/login', requireDb, async (req, res) => {
  const { loginId, password } = req.body || {};
  if (!loginId || !password) {
    return res.status(400).json({ error: '아이디와 비밀번호를 입력해주세요.' });
  }
  try {
    const result = await pool.query('SELECT id, name, password_hash FROM users WHERE login_id = $1', [loginId]);
    if (result.rows.length === 0) {
      return res.status(401).json({ error: '아이디 또는 비밀번호가 일치하지 않습니다.' });
    }
    const user = result.rows[0];
    const ok = await bcrypt.compare(password, user.password_hash);
    if (!ok) {
      return res.status(401).json({ error: '아이디 또는 비밀번호가 일치하지 않습니다.' });
    }
    const token = jwt.sign({ userId: user.id, name: user.name }, JWT_SECRET, { expiresIn: '90d' });
    res.json({ token, name: user.name });
  } catch (err) {
    console.error('로그인 오류:', err);
    res.status(500).json({ error: '로그인 처리 중 오류가 발생했습니다.' });
  }
});

// 다른 라우터(schedule.js)에서 재사용하는 인증 미들웨어
function verifyToken(req, res, next) {
  const auth = req.headers.authorization || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : null;
  if (!token) return res.status(401).json({ error: '로그인이 필요합니다.' });
  try {
    const payload = jwt.verify(token, JWT_SECRET);
    req.userId = payload.userId;
    req.userName = payload.name;
    next();
  } catch (err) {
    res.status(401).json({ error: '로그인이 만료되었습니다. 다시 로그인해주세요.' });
  }
}

module.exports = { router, verifyToken };
