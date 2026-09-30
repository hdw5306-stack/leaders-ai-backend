/**
 * auth.js — 별도 계정 로그인 (자체 아이디/비밀번호, JWT 발급)
 *
 * 권한 3단계:
 *   - agent        : 일반 설계사. 가입 시 소속 지사(branch)를 선택해야 하고,
 *                     approved=false로 생성되어 그 지사의 지사장(branch_admin)
 *                     또는 상무(super_admin)의 승인이 있어야 로그인할 수 있습니다.
 *   - branch_admin : 지사장. 자기 지사 소속 설계사만 승인/관리할 수 있습니다.
 *                     (계정은 상무가 관리자 화면에서 만들어줍니다 — /api/admin/branch-admins)
 *   - super_admin  : 상무(전체관리자). 모든 지사·모든 설계사를 볼 수 있고, 지사와
 *                     지사장 계정을 만들 수 있습니다.
 *
 * 가입 흐름:
 *   1) 일반 설계사가 가입하면 소속 지사를 선택하고, approved=false 상태로 생성됩니다.
 *   2) 회원가입 시 "관리자 코드"(환경변수 ADMIN_SIGNUP_CODE)를 정확히 입력하면
 *      그 계정은 role='super_admin', approved=true로 바로 생성됩니다 (지사 선택 불필요).
 *      이 코드는 맨 처음 상무 계정을 만들 때 한 번만 쓰고, 이후에는 이 계정으로
 *      지사와 지사장 계정을 직접 만들면 됩니다.
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
  const { name, loginId, password, adminCode, branchId } = req.body || {};
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

    const isAdminSignup = !!(process.env.ADMIN_SIGNUP_CODE && adminCode && adminCode === process.env.ADMIN_SIGNUP_CODE);
    const role = isAdminSignup ? 'super_admin' : 'agent';
    const approved = isAdminSignup; // 관리자 코드로 가입하면 즉시 승인, 아니면 지사장 승인 대기
    let resolvedBranchId = null;

    if (!isAdminSignup) {
      // 일반 설계사는 소속 지사를 반드시 선택해야, 그 지사의 지사장이 승인할 수 있습니다.
      if (!branchId) {
        return res.status(400).json({ error: '소속 지사를 선택해주세요.' });
      }
      const branchCheck = await pool.query('SELECT id FROM branches WHERE id = $1', [branchId]);
      if (branchCheck.rows.length === 0) {
        return res.status(400).json({ error: '선택한 지사를 찾을 수 없습니다. 목록을 새로고침해주세요.' });
      }
      resolvedBranchId = branchCheck.rows[0].id;
    }

    const hash = await bcrypt.hash(password, 10);
    const result = await pool.query(
      `INSERT INTO users (name, login_id, password_hash, role, approved, approved_at, branch_id)
       VALUES ($1, $2, $3, $4, $5, ${approved ? 'now()' : 'NULL'}, $6)
       RETURNING id, name, role, approved, branch_id`,
      [name, loginId, hash, role, approved, resolvedBranchId]
    );
    const user = result.rows[0];

    if (!user.approved) {
      // 승인 대기 상태 — 토큰을 발급하지 않고, 승인 필요 안내만 돌려줍니다.
      return res.status(202).json({
        pendingApproval: true,
        message: '가입 신청이 접수되었습니다. 소속 지사의 지사장 승인 후 로그인하실 수 있습니다.'
      });
    }

    const token = jwt.sign(
      { userId: user.id, name: user.name, role: user.role, branchId: user.branch_id },
      JWT_SECRET, { expiresIn: '90d' }
    );
    res.json({ token, name: user.name, role: user.role });
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
    const result = await pool.query(
      'SELECT id, name, password_hash, role, approved, branch_id FROM users WHERE login_id = $1',
      [loginId]
    );
    if (result.rows.length === 0) {
      return res.status(401).json({ error: '아이디 또는 비밀번호가 일치하지 않습니다.' });
    }
    const user = result.rows[0];
    const ok = await bcrypt.compare(password, user.password_hash);
    if (!ok) {
      return res.status(401).json({ error: '아이디 또는 비밀번호가 일치하지 않습니다.' });
    }
    if (!user.approved) {
      return res.status(403).json({
        pendingApproval: true,
        error: '아직 지사장(또는 상무) 승인이 완료되지 않았습니다. 승인 후 다시 로그인해주세요.'
      });
    }
    const token = jwt.sign(
      { userId: user.id, name: user.name, role: user.role, branchId: user.branch_id },
      JWT_SECRET, { expiresIn: '90d' }
    );
    res.json({ token, name: user.name, role: user.role });
  } catch (err) {
    console.error('로그인 오류:', err);
    res.status(500).json({ error: '로그인 처리 중 오류가 발생했습니다.' });
  }
});

// 내 계정 정보 변경 (아이디/비밀번호를 본인이 직접 변경)
// 상무/지사장이 임시로 만들어준 아이디·비번을, 로그인한 본인이 원하는 값으로 바꿀 수 있게 합니다.
router.put('/me', requireDb, verifyToken, async (req, res) => {
  const { currentPassword, newLoginId, newPassword } = req.body || {};
  if (!currentPassword) {
    return res.status(400).json({ error: '본인 확인을 위해 현재 비밀번호를 입력해주세요.' });
  }
  if (!newLoginId && !newPassword) {
    return res.status(400).json({ error: '변경할 아이디 또는 비밀번호를 입력해주세요.' });
  }
  if (newPassword && newPassword.length < 6) {
    return res.status(400).json({ error: '새 비밀번호는 6자 이상이어야 합니다.' });
  }
  try {
    const result = await pool.query('SELECT id, password_hash FROM users WHERE id = $1', [req.userId]);
    if (result.rows.length === 0) {
      return res.status(404).json({ error: '계정을 찾을 수 없습니다.' });
    }
    const ok = await bcrypt.compare(currentPassword, result.rows[0].password_hash);
    if (!ok) {
      return res.status(401).json({ error: '현재 비밀번호가 일치하지 않습니다.' });
    }

    if (newLoginId) {
      const dup = await pool.query('SELECT id FROM users WHERE login_id = $1 AND id != $2', [newLoginId, req.userId]);
      if (dup.rows.length > 0) {
        return res.status(409).json({ error: '이미 사용 중인 아이디입니다.' });
      }
    }

    const newHash = newPassword ? await bcrypt.hash(newPassword, 10) : null;
    await pool.query(
      `UPDATE users SET
         login_id = COALESCE($1, login_id),
         password_hash = COALESCE($2, password_hash)
       WHERE id = $3`,
      [newLoginId || null, newHash, req.userId]
    );
    res.json({ success: true, message: '계정 정보가 변경되었습니다. 다음 로그인부터 새 정보로 접속해주세요.', loginId: newLoginId || undefined });
  } catch (err) {
    console.error('계정 변경 오류:', err);
    res.status(500).json({ error: '계정 정보 변경 중 오류가 발생했습니다.' });
  }
});

// 다른 라우터(schedule.js, admin.js)에서 재사용하는 인증 미들웨어
function verifyToken(req, res, next) {
  const auth = req.headers.authorization || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : null;
  if (!token) return res.status(401).json({ error: '로그인이 필요합니다.' });
  try {
    const payload = jwt.verify(token, JWT_SECRET);
    req.userId = payload.userId;
    req.userName = payload.name;
    req.userRole = payload.role || 'agent';
    req.userBranchId = payload.branchId || null;
    next();
  } catch (err) {
    res.status(401).json({ error: '로그인이 만료되었습니다. 다시 로그인해주세요.' });
  }
}

// 관리자(지사장 이상) 전용 라우트에 붙이는 미들웨어 (verifyToken 다음에 사용)
function requireAdmin(req, res, next) {
  if (req.userRole !== 'branch_admin' && req.userRole !== 'super_admin') {
    return res.status(403).json({ error: '관리자만 사용할 수 있는 기능입니다.' });
  }
  next();
}

// 상무(전체관리자) 전용 라우트에 붙이는 미들웨어 (verifyToken 다음에 사용)
function requireSuperAdmin(req, res, next) {
  if (req.userRole !== 'super_admin') {
    return res.status(403).json({ error: '상무(전체관리자)만 사용할 수 있는 기능입니다.' });
  }
  next();
}

module.exports = { router, verifyToken, requireAdmin, requireSuperAdmin };
