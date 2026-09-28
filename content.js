/**
 * content.js — 로그인한 설계사가 약관(terms)·보상사례(claims) 공용 데이터를
 * 읽기 전용으로 받아가는 라우트. 관리자가 admin.js로 수정하면, 설계사가
 * 다음에 이 API를 호출할 때(=화면을 새로고침하거나 AI 상담 탭을 열 때)
 * 바로 최신 내용을 받아갑니다.
 */

const express = require('express');
const { pool } = require('./db');
const { verifyToken } = require('./auth');

const router = express.Router();
router.use(verifyToken);

router.get('/terms', async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM terms ORDER BY id DESC');
    res.json({ items: result.rows });
  } catch (err) {
    console.error('약관 조회 오류:', err);
    res.status(500).json({ error: '약관 정보를 불러오지 못했습니다.' });
  }
});

router.get('/claims', async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM claims ORDER BY id DESC');
    res.json({ items: result.rows });
  } catch (err) {
    console.error('보상사례 조회 오류:', err);
    res.status(500).json({ error: '보상사례 정보를 불러오지 못했습니다.' });
  }
});

module.exports = router;
