/**
 * schedule.js — 로그인한 설계사 개인의 일정 CRUD (카테고리별 저장/조회)
 */

const express = require('express');
const { pool } = require('./db');
const { verifyToken } = require('./auth');

const router = express.Router();
const VALID_CATEGORIES = ['미팅', '계약', '방문', '개인', '기타'];

router.use(verifyToken);

// 목록 조회 (전체, 또는 ?category=미팅 으로 카테고리 필터)
router.get('/', async (req, res) => {
  try {
    const { category } = req.query;
    let result;
    if (category && VALID_CATEGORIES.includes(category)) {
      result = await pool.query(
        'SELECT * FROM schedules WHERE user_id = $1 AND category = $2 ORDER BY id DESC',
        [req.userId, category]
      );
    } else {
      result = await pool.query('SELECT * FROM schedules WHERE user_id = $1 ORDER BY id DESC', [req.userId]);
    }
    res.json({ items: result.rows });
  } catch (err) {
    console.error('일정 조회 오류:', err);
    res.status(500).json({ error: '일정을 불러오지 못했습니다.' });
  }
});

// 등록
router.post('/', async (req, res) => {
  const { title, timeLabel, category, memo, remindBeforeMin } = req.body || {};
  if (!title) return res.status(400).json({ error: '일정 제목이 필요합니다.' });
  const cat = VALID_CATEGORIES.includes(category) ? category : '기타';
  try {
    const result = await pool.query(
      `INSERT INTO schedules (user_id, category, title, time_label, memo, remind_before_min)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
      [req.userId, cat, title, timeLabel || '', memo || '', remindBeforeMin || 60]
    );
    res.json({ item: result.rows[0] });
  } catch (err) {
    console.error('일정 등록 오류:', err);
    res.status(500).json({ error: '일정을 저장하지 못했습니다.' });
  }
});

// 삭제 (본인 소유 일정만)
router.delete('/:id', async (req, res) => {
  try {
    await pool.query('DELETE FROM schedules WHERE id = $1 AND user_id = $2', [req.params.id, req.userId]);
    res.json({ ok: true });
  } catch (err) {
    console.error('일정 삭제 오류:', err);
    res.status(500).json({ error: '일정을 삭제하지 못했습니다.' });
  }
});

module.exports = router;
