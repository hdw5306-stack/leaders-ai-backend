/**
 * branches.js — 지사 목록
 *   - GET  /            : 누구나(로그인 전에도) 조회 가능 — 회원가입 화면에서
 *                          "소속 지사" 선택 목록을 보여주기 위함
 *   - POST /            : 상무(super_admin)만 새 지사를 추가
 */
const express = require('express');
const { pool } = require('./db');
const { verifyToken, requireSuperAdmin } = require('./auth');

const router = express.Router();

router.get('/', async (req, res) => {
  try {
    const result = await pool.query('SELECT id, name FROM branches ORDER BY name ASC');
    res.json({ items: result.rows });
  } catch (err) {
    console.error('지사 목록 조회 오류:', err);
    res.status(500).json({ error: '지사 목록을 불러오지 못했습니다.' });
  }
});

router.post('/', verifyToken, requireSuperAdmin, async (req, res) => {
  const { name } = req.body || {};
  if (!name || !name.trim()) {
    return res.status(400).json({ error: '지사명을 입력해주세요.' });
  }
  try {
    const result = await pool.query(
      'INSERT INTO branches (name) VALUES ($1) RETURNING *',
      [name.trim()]
    );
    res.json({ item: result.rows[0] });
  } catch (err) {
    if (err.code === '23505') {
      return res.status(409).json({ error: '이미 존재하는 지사명입니다.' });
    }
    console.error('지사 추가 오류:', err);
    res.status(500).json({ error: '지사 추가에 실패했습니다.' });
  }
});

router.delete('/:id', verifyToken, requireSuperAdmin, async (req, res) => {
  try {
    const inUse = await pool.query('SELECT COUNT(*) FROM users WHERE branch_id = $1', [req.params.id]);
    if (Number(inUse.rows[0].count) > 0) {
      return res.status(409).json({ error: '이 지사에 소속된 계정이 있어 삭제할 수 없습니다. 먼저 소속을 변경해주세요.' });
    }
    await pool.query('DELETE FROM branches WHERE id = $1', [req.params.id]);
    res.json({ ok: true });
  } catch (err) {
    console.error('지사 삭제 오류:', err);
    res.status(500).json({ error: '지사 삭제에 실패했습니다.' });
  }
});

module.exports = router;
