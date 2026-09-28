/**
 * admin.js — 관리자(지사장/상무) 전용 기능
 *   1) 설계사 가입 승인/거절 — 지사장(branch_admin)은 자기 지사 소속 설계사만,
 *      상무(super_admin)는 전체를 볼 수 있고 관리할 수 있습니다.
 *   2) 약관(terms) · 보상사례(claims) 공용 DB 관리
 *      → 여기서 등록·수정·삭제하면, 로그인한 모든 설계사의 AI 상담 화면에
 *        즉시 반영됩니다 (프런트엔드가 매번 서버에서 최신 데이터를 받아가기 때문).
 *   3) 지사장 계정 생성 — 상무(super_admin)만 가능
 */

const express = require('express');
const bcrypt = require('bcryptjs');
const { pool } = require('./db');
const { verifyToken, requireAdmin } = require('./auth');

const router = express.Router();
router.use(verifyToken, requireAdmin);

// 지사장이 관리 대상 사용자(userId)를 건드릴 권한이 있는지 확인.
// 상무는 항상 가능, 지사장은 "같은 지사 소속의 일반 설계사"만 가능합니다.
async function assertCanManageUser(req, res, targetId) {
  if (req.userRole === 'super_admin') return true;
  const check = await pool.query('SELECT branch_id, role FROM users WHERE id = $1', [targetId]);
  if (check.rows.length === 0) {
    res.status(404).json({ error: '해당 계정을 찾을 수 없습니다.' });
    return false;
  }
  const target = check.rows[0];
  if (target.role !== 'agent' || target.branch_id !== req.userBranchId) {
    res.status(403).json({ error: '다른 지사 소속이거나 관리자 계정은 지사장이 관리할 수 없습니다.' });
    return false;
  }
  return true;
}

// ── 설계사 승인 관리 ─────────────────────────────────────────
router.get('/users', async (req, res) => {
  try {
    const isSuper = req.userRole === 'super_admin';
    const result = await pool.query(
      `SELECT u.id, u.name, u.login_id, u.role, u.approved, u.approved_at, u.created_at,
              u.branch_id, b.name AS branch_name
       FROM users u LEFT JOIN branches b ON b.id = u.branch_id
       ${isSuper ? '' : 'WHERE u.branch_id = $1 AND u.role = \'agent\''}
       ORDER BY u.approved ASC, u.created_at DESC`,
      isSuper ? [] : [req.userBranchId]
    );
    res.json({ items: result.rows, scope: isSuper ? 'all' : 'branch' });
  } catch (err) {
    console.error('사용자 목록 조회 오류:', err);
    res.status(500).json({ error: '목록을 불러오지 못했습니다.' });
  }
});

router.post('/users/:id/approve', async (req, res) => {
  try {
    if (!(await assertCanManageUser(req, res, req.params.id))) return;
    const result = await pool.query(
      `UPDATE users SET approved = true, approved_at = now() WHERE id = $1 RETURNING id, name`,
      [req.params.id]
    );
    if (result.rows.length === 0) return res.status(404).json({ error: '해당 계정을 찾을 수 없습니다.' });
    res.json({ ok: true, user: result.rows[0] });
  } catch (err) {
    console.error('승인 처리 오류:', err);
    res.status(500).json({ error: '승인 처리에 실패했습니다.' });
  }
});

router.post('/users/:id/reject', async (req, res) => {
  try {
    if (!(await assertCanManageUser(req, res, req.params.id))) return;
    // 거절 = 가입 신청 자체를 삭제 (승인된 계정은 대신 아래 비활성화를 쓰세요)
    await pool.query(`DELETE FROM users WHERE id = $1 AND approved = false`, [req.params.id]);
    res.json({ ok: true });
  } catch (err) {
    console.error('거절 처리 오류:', err);
    res.status(500).json({ error: '거절 처리에 실패했습니다.' });
  }
});

router.post('/users/:id/deactivate', async (req, res) => {
  try {
    if (!(await assertCanManageUser(req, res, req.params.id))) return;
    // 이미 승인된 계정을 다시 승인 대기 상태로 되돌려 로그인을 막습니다 (퇴사 등).
    await pool.query(`UPDATE users SET approved = false WHERE id = $1`, [req.params.id]);
    res.json({ ok: true });
  } catch (err) {
    console.error('비활성화 오류:', err);
    res.status(500).json({ error: '처리에 실패했습니다.' });
  }
});

// ── 지사장 계정 생성 (상무 전용) ────────────────────────────────
router.post('/branch-admins', async (req, res) => {
  if (req.userRole !== 'super_admin') {
    return res.status(403).json({ error: '상무(전체관리자)만 지사장 계정을 만들 수 있습니다.' });
  }
  const { name, loginId, password, branchId } = req.body || {};
  if (!name || !loginId || !password || !branchId) {
    return res.status(400).json({ error: '이름, 아이디, 비밀번호, 소속 지사를 모두 입력해주세요.' });
  }
  if (password.length < 6) {
    return res.status(400).json({ error: '비밀번호는 6자 이상이어야 합니다.' });
  }
  try {
    const branchCheck = await pool.query('SELECT id FROM branches WHERE id = $1', [branchId]);
    if (branchCheck.rows.length === 0) {
      return res.status(400).json({ error: '선택한 지사를 찾을 수 없습니다.' });
    }
    const existing = await pool.query('SELECT id FROM users WHERE login_id = $1', [loginId]);
    if (existing.rows.length > 0) {
      return res.status(409).json({ error: '이미 사용 중인 아이디입니다.' });
    }
    const hash = await bcrypt.hash(password, 10);
    const result = await pool.query(
      `INSERT INTO users (name, login_id, password_hash, role, approved, approved_at, branch_id)
       VALUES ($1, $2, $3, 'branch_admin', true, now(), $4)
       RETURNING id, name, login_id, branch_id`,
      [name, loginId, hash, branchId]
    );
    res.json({ item: result.rows[0] });
  } catch (err) {
    console.error('지사장 계정 생성 오류:', err);
    res.status(500).json({ error: '지사장 계정 생성에 실패했습니다.' });
  }
});

// ── 약관(terms) 관리 ─────────────────────────────────────────
router.get('/terms', async (req, res) => {
  const result = await pool.query('SELECT * FROM terms ORDER BY id DESC');
  res.json({ items: result.rows });
});

router.post('/terms', async (req, res) => {
  const { company, product, rider, coverage, exclusions } = req.body || {};
  if (!company || !product || !rider || !coverage) {
    return res.status(400).json({ error: '회사명, 상품명, 특약명, 보장내용은 필수입니다.' });
  }
  const list = Array.isArray(exclusions) ? exclusions : String(exclusions || '').split('\n').filter(Boolean);
  const result = await pool.query(
    `INSERT INTO terms (company, product, rider, coverage, exclusions, updated_by)
     VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
    [company, product, rider, coverage, JSON.stringify(list), req.userId]
  );
  res.json({ item: result.rows[0] });
});

router.put('/terms/:id', async (req, res) => {
  const { company, product, rider, coverage, exclusions } = req.body || {};
  const list = Array.isArray(exclusions) ? exclusions : String(exclusions || '').split('\n').filter(Boolean);
  const result = await pool.query(
    `UPDATE terms SET company=$1, product=$2, rider=$3, coverage=$4, exclusions=$5,
     updated_by=$6, updated_at=now() WHERE id=$7 RETURNING *`,
    [company, product, rider, coverage, JSON.stringify(list), req.userId, req.params.id]
  );
  if (result.rows.length === 0) return res.status(404).json({ error: '해당 약관을 찾을 수 없습니다.' });
  res.json({ item: result.rows[0] });
});

router.delete('/terms/:id', async (req, res) => {
  await pool.query('DELETE FROM terms WHERE id = $1', [req.params.id]);
  res.json({ ok: true });
});

// ── 보상사례(claims) 관리 ────────────────────────────────────
router.get('/claims', async (req, res) => {
  const result = await pool.query('SELECT * FROM claims ORDER BY id DESC');
  res.json({ items: result.rows });
});

router.post('/claims', async (req, res) => {
  const { caseTitle, summary, rangeDesc, note } = req.body || {};
  if (!caseTitle || !summary || !rangeDesc) {
    return res.status(400).json({ error: '사례 제목, 요약, 지급범위는 필수입니다.' });
  }
  const result = await pool.query(
    `INSERT INTO claims (case_title, summary, range_desc, note, updated_by)
     VALUES ($1, $2, $3, $4, $5) RETURNING *`,
    [caseTitle, summary, rangeDesc, note || '', req.userId]
  );
  res.json({ item: result.rows[0] });
});

router.put('/claims/:id', async (req, res) => {
  const { caseTitle, summary, rangeDesc, note } = req.body || {};
  const result = await pool.query(
    `UPDATE claims SET case_title=$1, summary=$2, range_desc=$3, note=$4,
     updated_by=$5, updated_at=now() WHERE id=$6 RETURNING *`,
    [caseTitle, summary, rangeDesc, note || '', req.userId, req.params.id]
  );
  if (result.rows.length === 0) return res.status(404).json({ error: '해당 사례를 찾을 수 없습니다.' });
  res.json({ item: result.rows[0] });
});

router.delete('/claims/:id', async (req, res) => {
  await pool.query('DELETE FROM claims WHERE id = $1', [req.params.id]);
  res.json({ ok: true });
});

module.exports = router;
