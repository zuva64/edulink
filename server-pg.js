const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { query, one, many, transaction, initDb } = require('./database');

const port = Number(process.env.PORT || 8000);
const root = __dirname;
const sessions = new Map();

function hashPassword(password, salt) { return crypto.scryptSync(password, salt, 64).toString('hex'); }
function strongPassword(password) { return typeof password === 'string' && password.length >= 10 && /[A-Za-zА-Яа-я]/.test(password) && /\d/.test(password); }
function normalizeEmail(value) { return String(value || '').trim().toLowerCase(); }
function validEmail(value) { return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value); }
function safeEqual(a, b) { const x = Buffer.from(String(a)); const y = Buffer.from(String(b)); return x.length === y.length && crypto.timingSafeEqual(x, y); }
function roleCode(role) { return role === 'Администратор' ? 'admin' : role === 'Преподаватель' ? 'teacher' : role === 'Студент' ? 'student' : 'staff'; }
function invalidateUserSessions(accountId) { for (const [token, session] of sessions) if (session.accountId === Number(accountId)) sessions.delete(token); }

function sendJson(response, status, body, headers = {}) {
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...headers });
  response.end(JSON.stringify(body));
}
function parseCookies(request) {
  return Object.fromEntries((request.headers.cookie || '').split(';').filter(Boolean).map((item) => {
    const i = item.indexOf('='); return [item.slice(0, i).trim(), decodeURIComponent(item.slice(i + 1))];
  }));
}
function currentSession(request) { const token = parseCookies(request).edulink_session; return token && sessions.get(token); }
function requireRole(request, response, roles) {
  const session = currentSession(request);
  if (!session || !roles.includes(session.role)) { sendJson(response, 403, { error: 'Недостаточно прав' }); return null; }
  return session;
}
function readBody(request) {
  return new Promise((resolve, reject) => {
    let body = '';
    request.on('data', (chunk) => { body += chunk; if (body.length > 200000) request.destroy(); });
    request.on('end', () => { try { resolve(JSON.parse(body || '{}')); } catch (error) { reject(error); } });
    request.on('error', reject);
  });
}
function serveStatic(request, response) {
  const url = request.url.split('?')[0];
  const requested = url === '/' ? '/index.html' : url;
  const filePath = path.normalize(path.join(root, requested));
  if (!filePath.startsWith(root) || !fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) return sendJson(response, 404, { error: 'Не найдено' });
  const ext = path.extname(filePath);
  const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8' };
  const headers = { 'Content-Type': types[ext] || 'application/octet-stream' };
  if (['.js', '.css', '.html'].includes(ext)) headers['Cache-Control'] = 'no-cache, no-store, must-revalidate';
  response.writeHead(200, headers);
  fs.createReadStream(filePath).pipe(response);
}
function iceServers() {
  const stun = String(process.env.STUN_URLS || 'stun:stun.l.google.com:19302').split(',').map((v) => v.trim()).filter(Boolean);
  const result = [{ urls: stun.length === 1 ? stun[0] : stun }];
  const turn = String(process.env.TURN_URLS || process.env.TURN_URL || '').split(',').map((v) => v.trim()).filter(Boolean);
  if (turn.length) result.push({ urls: turn.length === 1 ? turn[0] : turn, username: process.env.TURN_USERNAME || '', credential: process.env.TURN_CREDENTIAL || '' });
  return result;
}

async function sendOtp(email, otp, purpose) {
  const apiKey = process.env.RESEND_API_KEY;
  const from = process.env.EMAIL_FROM;
  if (!apiKey || !from) {
    if (process.env.ALLOW_DEV_OTP === 'true') { console.log(`[DEV OTP] ${email} ${purpose}: ${otp}`); return { devOtp: otp }; }
    throw new Error('Сервис отправки e-mail не настроен');
  }
  const title = purpose === 'register' ? 'Подтверждение регистрации EduLink' : 'Восстановление пароля EduLink';
  const html = `<p>Ваш одноразовый код EduLink:</p><p style="font-size:28px;font-weight:bold;letter-spacing:4px">${otp}</p><p>Код действует 10 минут. Никому его не сообщайте.</p>`;
  const result = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json', 'User-Agent': 'EduLink/1.0' },
    body: JSON.stringify({ from, to: [email], subject: title, html })
  });
  if (!result.ok) { console.error('Resend error', result.status, await result.text()); throw new Error('Не удалось отправить e-mail'); }
  return {};
}
async function issueOtp(email, purpose) {
  const otp = String(crypto.randomInt(100000, 1000000));
  const hash = crypto.createHash('sha256').update(`${email}:${purpose}:${otp}`).digest('hex');
  await query(`INSERT INTO auth_otps(email,purpose,otp_hash,expires_at,attempts) VALUES($1,$2,$3,$4,0)
    ON CONFLICT(email,purpose) DO UPDATE SET otp_hash=EXCLUDED.otp_hash,expires_at=EXCLUDED.expires_at,attempts=0`,
    [email, purpose, hash, Date.now() + 10 * 60000]);
  return { otp, ...(await sendOtp(email, otp, purpose)) };
}
async function verifyOtp(email, purpose, otp) {
  const row = await one('SELECT * FROM auth_otps WHERE email=$1 AND purpose=$2', [email, purpose]);
  if (!row || Date.now() > Number(row.expires_at)) { await query('DELETE FROM auth_otps WHERE email=$1 AND purpose=$2', [email, purpose]); return false; }
  if (row.attempts >= 5) return false;
  const hash = crypto.createHash('sha256').update(`${email}:${purpose}:${otp}`).digest('hex');
  if (!safeEqual(hash, row.otp_hash)) { await query('UPDATE auth_otps SET attempts=attempts+1 WHERE email=$1 AND purpose=$2', [email, purpose]); return false; }
  await query('DELETE FROM auth_otps WHERE email=$1 AND purpose=$2', [email, purpose]);
  return true;
}
async function syncRoleProfile(accountId, role, client = null) {
  const run = (text, params) => client ? client.query(text, params) : query(text, params);
  if (role === 'Преподаватель') {
    await run('INSERT INTO teacher_profiles(account_id,department,position,phone) VALUES($1,NULL,NULL,NULL) ON CONFLICT(account_id) DO NOTHING', [accountId]);
    await run('DELETE FROM student_profiles WHERE account_id=$1', [accountId]);
  } else if (role === 'Студент') {
    await run(`INSERT INTO student_profiles(account_id,student_number,group_id) VALUES($1,$2,NULL) ON CONFLICT(account_id) DO NOTHING`, [accountId, `ST-${String(accountId).padStart(4, '0')}`]);
    await run('DELETE FROM teacher_profiles WHERE account_id=$1', [accountId]);
  } else {
    await run('DELETE FROM teacher_profiles WHERE account_id=$1', [accountId]);
    await run('DELETE FROM student_profiles WHERE account_id=$1', [accountId]);
  }
}
async function validateTeacher(id) {
  if (id === null || id === undefined || id === '') return null;
  const teacher = await one(`SELECT id FROM accounts WHERE id=$1 AND role='Преподаватель'`, [Number(id)]);
  if (!teacher) throw Object.assign(new Error('Выберите существующего преподавателя'), { statusCode: 400 });
  return Number(id);
}

const videoRoom = { active: false, teacherJoined: false, studentJoined: false, startedAt: null, revision: 0 };
const videoSignals = { teacher: [], student: [] };
let nextSignalId = 1;

const server = http.createServer(async (request, response) => {
  try {
    if (request.method === 'GET' && request.url === '/health') {
      await query('SELECT 1');
      return sendJson(response, 200, { ok: true, database: 'postgresql' });
    }

    if (request.method === 'POST' && request.url === '/api/register/request-otp') {
      const body = await readBody(request);
      const email = normalizeEmail(body.email), name = String(body.name || '').trim(), password = String(body.password || '');
      if (name.length < 2 || !validEmail(email) || !strongPassword(password)) return sendJson(response, 400, { error: 'Укажите имя, корректный e-mail и пароль не короче 10 символов с буквами и цифрами' });
      const existing = await one('SELECT * FROM accounts WHERE lower(email)=lower($1)', [email]);
      if (existing && existing.email_verified) return sendJson(response, 409, { error: 'Учетная запись с таким e-mail уже существует' });
      if (existing && existing.role !== 'Студент') return sendJson(response, 409, { error: 'Эта учетная запись создана администратором. Обратитесь к администратору для активации.' });
      const salt = crypto.randomBytes(16).toString('hex');
      let accountId;
      if (existing) {
        accountId = Number(existing.id);
        await query(`UPDATE accounts SET name=$1,status='Ожидает активации',password_hash=$2,password_salt=$3,email_verified=FALSE,
          failed_login_attempts=0,locked_at=NULL,updated_at=NOW() WHERE id=$4`, [name, hashPassword(password, salt), salt, accountId]);
      } else {
        const created = await one(`INSERT INTO accounts(name,email,role,status,last_login,password_hash,password_salt,email_verified)
          VALUES($1,$2,'Студент','Ожидает активации','Никогда',$3,$4,FALSE) RETURNING id`, [name, email, hashPassword(password, salt), salt]);
        accountId = Number(created.id);
        await syncRoleProfile(accountId, 'Студент');
      }
      const out = await issueOtp(email, 'register');
      return sendJson(response, 200, { ok: true, expiresIn: 600, ...(out.devOtp ? { devOtp: out.devOtp } : {}) });
    }

    if (request.method === 'POST' && request.url === '/api/register/verify') {
      const body = await readBody(request), email = normalizeEmail(body.email);
      if (!(await verifyOtp(email, 'register', String(body.otp || '')))) return sendJson(response, 400, { error: 'Неверный или просроченный код' });
      const account = await one('UPDATE accounts SET status=$1,email_verified=TRUE,updated_at=NOW() WHERE lower(email)=lower($2) RETURNING id', ['Активен', email]);
      if (!account) return sendJson(response, 404, { error: 'Регистрация не найдена' });
      await syncRoleProfile(Number(account.id), 'Студент');
      return sendJson(response, 200, { ok: true });
    }

    if (request.method === 'POST' && request.url === '/api/password/request-reset') {
      const body = await readBody(request), email = normalizeEmail(body.email);
      const account = await one('SELECT email_verified FROM accounts WHERE lower(email)=lower($1)', [email]);
      if (account && account.email_verified) await issueOtp(email, 'reset');
      return sendJson(response, 200, { ok: true });
    }

    if (request.method === 'POST' && request.url === '/api/password/reset') {
      const body = await readBody(request), email = normalizeEmail(body.email), password = String(body.password || '');
      if (!strongPassword(password)) return sendJson(response, 400, { error: 'Новый пароль должен содержать не менее 10 символов, буквы и цифры' });
      if (!(await verifyOtp(email, 'reset', String(body.otp || '')))) return sendJson(response, 400, { error: 'Неверный или просроченный код' });
      const account = await one('SELECT id,email_verified FROM accounts WHERE lower(email)=lower($1)', [email]);
      if (!account) return sendJson(response, 400, { error: 'Не удалось изменить пароль' });
      const salt = crypto.randomBytes(16).toString('hex');
      await query(`UPDATE accounts SET password_hash=$1,password_salt=$2,failed_login_attempts=0,locked_at=NULL,
        status=CASE WHEN email_verified THEN 'Активен' ELSE status END,updated_at=NOW() WHERE id=$3`, [hashPassword(password, salt), salt, account.id]);
      invalidateUserSessions(account.id);
      return sendJson(response, 200, { ok: true });
    }

    if (request.method === 'POST' && request.url === '/api/account/password') {
      const session = currentSession(request);
      if (!session) return sendJson(response, 401, { error: 'Требуется авторизация' });
      const body = await readBody(request);
      const account = await one('SELECT * FROM accounts WHERE id=$1', [session.accountId]);
      if (!account || !safeEqual(hashPassword(String(body.currentPassword || ''), account.password_salt), account.password_hash)) return sendJson(response, 400, { error: 'Текущий пароль указан неверно' });
      if (!strongPassword(String(body.newPassword || ''))) return sendJson(response, 400, { error: 'Новый пароль должен содержать не менее 10 символов, буквы и цифры' });
      const salt = crypto.randomBytes(16).toString('hex');
      await query('UPDATE accounts SET password_hash=$1,password_salt=$2,updated_at=NOW() WHERE id=$3', [hashPassword(body.newPassword, salt), salt, account.id]);
      const currentToken = parseCookies(request).edulink_session;
      for (const [token, s] of sessions) if (s.accountId === Number(account.id) && token !== currentToken) sessions.delete(token);
      return sendJson(response, 200, { ok: true });
    }

    if (request.method === 'POST' && request.url === '/api/login') {
      const body = await readBody(request), email = normalizeEmail(body.email);
      const account = await one('SELECT * FROM accounts WHERE lower(email)=lower($1)', [email]);
      if (!account) return sendJson(response, 401, { error: 'Неверный e-mail или пароль' });
      if (account.status === 'Заблокирован' || account.locked_at) return sendJson(response, 423, { error: 'Учетная запись заблокирована. Восстановите пароль или обратитесь к администратору' });
      if (!account.email_verified) return sendJson(response, 403, { error: 'Сначала подтвердите e-mail' });
      if (!safeEqual(hashPassword(String(body.password || ''), account.password_salt), account.password_hash)) {
        const attempts = Number(account.failed_login_attempts || 0) + 1;
        if (attempts >= 3) {
          await query(`UPDATE accounts SET failed_login_attempts=3,locked_at=$1,status='Заблокирован',updated_at=NOW() WHERE id=$2`, [Date.now(), account.id]);
          invalidateUserSessions(account.id);
          return sendJson(response, 423, { error: 'Учетная запись заблокирована после 3 неверных попыток входа' });
        }
        await query('UPDATE accounts SET failed_login_attempts=$1,updated_at=NOW() WHERE id=$2', [attempts, account.id]);
        return sendJson(response, 401, { error: `Неверный e-mail или пароль. Осталось попыток: ${3 - attempts}` });
      }
      await query('UPDATE accounts SET failed_login_attempts=0,locked_at=NULL,last_login=$1,updated_at=NOW() WHERE id=$2', [new Date().toISOString(), account.id]);
      const token = crypto.randomBytes(32).toString('hex'), role = roleCode(account.role);
      sessions.set(token, { accountId: Number(account.id), email: account.email, role });
      return sendJson(response, 200, { email: account.email, role }, { 'Set-Cookie': `edulink_session=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=28800${process.env.NODE_ENV === 'production' ? '; Secure' : ''}` });
    }

    if (request.method === 'POST' && request.url === '/api/logout') {
      const token = parseCookies(request).edulink_session; if (token) sessions.delete(token);
      return sendJson(response, 200, { ok: true }, { 'Set-Cookie': 'edulink_session=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0' });
    }
    if (request.method === 'GET' && request.url === '/api/session') {
      const session = currentSession(request);
      return session ? sendJson(response, 200, { email: session.email, role: session.role }) : sendJson(response, 401, { error: 'Требуется авторизация' });
    }

    if (request.method === 'GET' && request.url === '/api/users') {
      if (!requireRole(request, response, ['admin'])) return;
      const rows = await many(`SELECT a.id,a.name,a.email,a.role,a.status,a.last_login AS "lastLogin",
        a.email_verified AS "emailVerified",a.failed_login_attempts AS "failedLoginAttempts",a.locked_at AS "lockedAt",
        sp.group_id AS "groupId",g.name AS "groupName"
        FROM accounts a LEFT JOIN student_profiles sp ON sp.account_id=a.id LEFT JOIN study_groups g ON g.id=sp.group_id ORDER BY a.id`);
      return sendJson(response, 200, rows.map((r) => ({ ...r, id: Number(r.id), groupId: r.groupId ? Number(r.groupId) : null })));
    }

    if (request.method === 'POST' && request.url === '/api/users') {
      if (!requireRole(request, response, ['admin'])) return;
      const body = await readBody(request), email = normalizeEmail(body.email), name = String(body.name || '').trim();
      if (name.length < 2 || !validEmail(email) || !['Преподаватель','Студент','Администратор'].includes(body.role)) return sendJson(response, 400, { error: 'Проверьте имя, e-mail и роль' });
      const salt = crypto.randomBytes(16).toString('hex'), temporary = crypto.randomBytes(9).toString('base64url') + '7';
      try {
        const created = await one(`INSERT INTO accounts(name,email,role,status,last_login,password_hash,password_salt,email_verified)
          VALUES($1,$2,$3,'Ожидает активации','Никогда',$4,$5,FALSE) RETURNING id`, [name, email, body.role, hashPassword(temporary, salt), salt]);
        await syncRoleProfile(Number(created.id), body.role);
      } catch (error) {
        if (error.code === '23505') return sendJson(response, 409, { error: 'Пользователь с таким e-mail уже существует' });
        throw error;
      }
      return sendJson(response, 201, { ok: true });
    }

    const userMatch = request.url.match(/^\/api\/users\/(\d+)$/);
    if (request.method === 'PUT' && userMatch) {
      const admin = requireRole(request, response, ['admin']); if (!admin) return;
      const id = Number(userMatch[1]), body = await readBody(request), account = await one('SELECT * FROM accounts WHERE id=$1', [id]);
      if (!account) return sendJson(response, 404, { error: 'Пользователь не найден' });
      const name = String(body.name || '').trim(), email = normalizeEmail(body.email), role = String(body.role || ''), status = String(body.status || ''), verified = Boolean(body.emailVerified);
      if (name.length < 2 || !validEmail(email) || !['Преподаватель','Студент','Администратор'].includes(role) || !['Активен','Ожидает активации','Заблокирован'].includes(status)) return sendJson(response, 400, { error: 'Проверьте данные пользователя' });
      if (id === admin.accountId && (role !== 'Администратор' || status === 'Заблокирован')) return sendJson(response, 400, { error: 'Нельзя снять с себя роль администратора или заблокировать собственную учетную запись' });
      try {
        await transaction(async (client) => {
          await client.query(`UPDATE accounts SET name=$1,email=$2,role=$3,status=$4,email_verified=$5,
            locked_at=CASE WHEN $4='Заблокирован' THEN COALESCE(locked_at,$6) ELSE NULL END,
            failed_login_attempts=CASE WHEN $4='Заблокирован' THEN GREATEST(failed_login_attempts,3) ELSE 0 END,updated_at=NOW() WHERE id=$7`, [name, email, role, status, verified, Date.now(), id]);
          await syncRoleProfile(id, role, client);
        });
      } catch (error) {
        if (error.code === '23505') return sendJson(response, 409, { error: 'Этот e-mail уже используется' });
        throw error;
      }
      invalidateUserSessions(id);
      return sendJson(response, 200, { ok: true });
    }

    const unlock = request.url.match(/^\/api\/users\/(\d+)\/unlock$/);
    if (request.method === 'POST' && unlock) {
      if (!requireRole(request, response, ['admin'])) return;
      const account = await one('SELECT email_verified FROM accounts WHERE id=$1', [Number(unlock[1])]);
      if (!account) return sendJson(response, 404, { error: 'Пользователь не найден' });
      await query(`UPDATE accounts SET status=$1,failed_login_attempts=0,locked_at=NULL,updated_at=NOW() WHERE id=$2`, [account.email_verified ? 'Активен' : 'Ожидает активации', Number(unlock[1])]);
      return sendJson(response, 200, { ok: true });
    }

    const block = request.url.match(/^\/api\/users\/(\d+)\/block$/);
    if (request.method === 'POST' && block) {
      const admin = requireRole(request, response, ['admin']); if (!admin) return;
      const id = Number(block[1]); if (id === admin.accountId) return sendJson(response, 400, { error: 'Нельзя заблокировать собственную учетную запись' });
      const result = await query(`UPDATE accounts SET status='Заблокирован',locked_at=$1,failed_login_attempts=3,updated_at=NOW() WHERE id=$2`, [Date.now(), id]);
      if (!result.rowCount) return sendJson(response, 404, { error: 'Пользователь не найден' });
      invalidateUserSessions(id); return sendJson(response, 200, { ok: true });
    }

    const sendReset = request.url.match(/^\/api\/users\/(\d+)\/send-reset$/);
    if (request.method === 'POST' && sendReset) {
      if (!requireRole(request, response, ['admin'])) return;
      const account = await one('SELECT email,email_verified FROM accounts WHERE id=$1', [Number(sendReset[1])]);
      if (!account) return sendJson(response, 404, { error: 'Пользователь не найден' });
      if (!account.email_verified) return sendJson(response, 400, { error: 'Сначала нужно подтвердить e-mail пользователя' });
      await issueOtp(account.email, 'reset'); return sendJson(response, 200, { ok: true });
    }

    if (request.method === 'DELETE' && userMatch) {
      const admin = requireRole(request, response, ['admin']); if (!admin) return;
      const id = Number(userMatch[1]); if (id === admin.accountId) return sendJson(response, 400, { error: 'Нельзя удалить собственную учетную запись' });
      const account = await one('SELECT email FROM accounts WHERE id=$1', [id]);
      if (!account) return sendJson(response, 404, { error: 'Пользователь не найден' });
      const lessonCount = await one('SELECT COUNT(*)::int AS count FROM lessons WHERE teacher_id=$1', [id]);
      const courseCount = await one('SELECT COUNT(*)::int AS count FROM courses WHERE teacher_id=$1', [id]);
      if (lessonCount.count || courseCount.count) return sendJson(response, 409, { error: 'Нельзя удалить преподавателя, пока на него назначены дисциплины или занятия.' });
      await transaction(async (client) => { await client.query('DELETE FROM auth_otps WHERE lower(email)=lower($1)', [account.email]); await client.query('DELETE FROM accounts WHERE id=$1', [id]); });
      invalidateUserSessions(id); return sendJson(response, 200, { ok: true });
    }

    if (request.method === 'GET' && request.url === '/api/admin/courses') {
      if (!requireRole(request, response, ['admin'])) return;
      const rows = await many(`SELECT c.id,c.code,c.name,c.description,c.status,c.teacher_id AS "teacherId",a.name AS "teacherName",
        COUNT(l.id)::int AS "lessonCount" FROM courses c LEFT JOIN accounts a ON a.id=c.teacher_id LEFT JOIN lessons l ON l.course_id=c.id
        GROUP BY c.id,a.name ORDER BY c.code`);
      return sendJson(response, 200, rows.map((r) => ({ ...r, id: Number(r.id), teacherId: r.teacherId ? Number(r.teacherId) : null })));
    }

    if (request.method === 'POST' && request.url === '/api/admin/courses') {
      if (!requireRole(request, response, ['admin'])) return;
      const b = await readBody(request), code = String(b.code || '').trim().toUpperCase(), name = String(b.name || '').trim();
      if (code.length < 2 || name.length < 2 || !['Активна','Архив'].includes(b.status || 'Активна')) return sendJson(response, 400, { error: 'Проверьте код, название и статус дисциплины' });
      const teacherId = await validateTeacher(b.teacherId);
      try {
        const row = await one(`INSERT INTO courses(code,name,description,teacher_id,status) VALUES($1,$2,$3,$4,$5) RETURNING id`, [code, name, String(b.description || '').trim() || null, teacherId, b.status || 'Активна']);
        return sendJson(response, 201, { ok: true, id: Number(row.id) });
      } catch (error) { if (error.code === '23505') return sendJson(response, 409, { error: 'Дисциплина с таким кодом уже существует' }); throw error; }
    }

    const courseMatch = request.url.match(/^\/api\/admin\/courses\/(\d+)$/);
    if (request.method === 'PUT' && courseMatch) {
      if (!requireRole(request, response, ['admin'])) return;
      const id = Number(courseMatch[1]), b = await readBody(request), code = String(b.code || '').trim().toUpperCase(), name = String(b.name || '').trim();
      if (code.length < 2 || name.length < 2 || !['Активна','Архив'].includes(b.status)) return sendJson(response, 400, { error: 'Проверьте данные дисциплины' });
      const teacherId = await validateTeacher(b.teacherId);
      try {
        const result = await query(`UPDATE courses SET code=$1,name=$2,description=$3,teacher_id=$4,status=$5,updated_at=NOW() WHERE id=$6`, [code, name, String(b.description || '').trim() || null, teacherId, b.status, id]);
        if (!result.rowCount) return sendJson(response, 404, { error: 'Дисциплина не найдена' });
        return sendJson(response, 200, { ok: true });
      } catch (error) { if (error.code === '23505') return sendJson(response, 409, { error: 'Дисциплина с таким кодом уже существует' }); throw error; }
    }
    if (request.method === 'DELETE' && courseMatch) {
      if (!requireRole(request, response, ['admin'])) return;
      const id = Number(courseMatch[1]), dep = await one('SELECT COUNT(*)::int AS count FROM lessons WHERE course_id=$1', [id]);
      if (dep.count) return sendJson(response, 409, { error: 'Нельзя удалить дисциплину, пока к ней привязаны занятия' });
      const result = await query('DELETE FROM courses WHERE id=$1', [id]);
      if (!result.rowCount) return sendJson(response, 404, { error: 'Дисциплина не найдена' });
      return sendJson(response, 200, { ok: true });
    }

    if (request.method === 'GET' && request.url === '/api/admin/groups') {
      if (!requireRole(request, response, ['admin'])) return;
      const rows = await many(`SELECT g.id,g.name,g.academic_year AS "academicYear",g.description,g.status,
        COUNT(sp.account_id)::int AS "studentCount",
        COALESCE(array_agg(sp.account_id ORDER BY sp.account_id) FILTER (WHERE sp.account_id IS NOT NULL),'{}') AS "studentIds",
        (SELECT COUNT(*)::int FROM lessons l WHERE l.group_id=g.id) AS "lessonCount"
        FROM study_groups g LEFT JOIN student_profiles sp ON sp.group_id=g.id GROUP BY g.id ORDER BY g.name`);
      return sendJson(response, 200, rows.map((r) => ({ ...r, id: Number(r.id), studentIds: r.studentIds.map(Number) })));
    }

    if (request.method === 'POST' && request.url === '/api/admin/groups') {
      if (!requireRole(request, response, ['admin'])) return;
      const b = await readBody(request), name = String(b.name || '').trim(), academicYear = String(b.academicYear || '').trim(), status = b.status || 'Активна';
      if (name.length < 2 || academicYear.length < 4 || !['Активна','Архив'].includes(status)) return sendJson(response, 400, { error: 'Проверьте название, учебный год и статус группы' });
      const studentIds = Array.isArray(b.studentIds) ? [...new Set(b.studentIds.map(Number).filter(Number.isFinite))] : [];
      try {
        const id = await transaction(async (client) => {
          const created = await client.query(`INSERT INTO study_groups(name,academic_year,description,status) VALUES($1,$2,$3,$4) RETURNING id`, [name, academicYear, String(b.description || '').trim() || null, status]);
          const groupId = Number(created.rows[0].id);
          if (studentIds.length) await client.query(`UPDATE student_profiles sp SET group_id=$1 FROM accounts a WHERE sp.account_id=a.id AND a.role='Студент' AND sp.account_id=ANY($2::bigint[])`, [groupId, studentIds]);
          return groupId;
        });
        return sendJson(response, 201, { ok: true, id });
      } catch (error) { if (error.code === '23505') return sendJson(response, 409, { error: 'Группа с таким названием уже существует' }); throw error; }
    }

    const groupMatch = request.url.match(/^\/api\/admin\/groups\/(\d+)$/);
    if (request.method === 'PUT' && groupMatch) {
      if (!requireRole(request, response, ['admin'])) return;
      const id = Number(groupMatch[1]), b = await readBody(request), name = String(b.name || '').trim(), academicYear = String(b.academicYear || '').trim();
      if (name.length < 2 || academicYear.length < 4 || !['Активна','Архив'].includes(b.status)) return sendJson(response, 400, { error: 'Проверьте данные учебной группы' });
      const studentIds = Array.isArray(b.studentIds) ? [...new Set(b.studentIds.map(Number).filter(Number.isFinite))] : [];
      try {
        const changed = await transaction(async (client) => {
          const updated = await client.query(`UPDATE study_groups SET name=$1,academic_year=$2,description=$3,status=$4,updated_at=NOW() WHERE id=$5`, [name, academicYear, String(b.description || '').trim() || null, b.status, id]);
          if (!updated.rowCount) return false;
          await client.query('UPDATE student_profiles SET group_id=NULL WHERE group_id=$1', [id]);
          if (studentIds.length) await client.query(`UPDATE student_profiles sp SET group_id=$1 FROM accounts a WHERE sp.account_id=a.id AND a.role='Студент' AND sp.account_id=ANY($2::bigint[])`, [id, studentIds]);
          return true;
        });
        if (!changed) return sendJson(response, 404, { error: 'Учебная группа не найдена' });
        return sendJson(response, 200, { ok: true });
      } catch (error) { if (error.code === '23505') return sendJson(response, 409, { error: 'Группа с таким названием уже существует' }); throw error; }
    }
    if (request.method === 'DELETE' && groupMatch) {
      if (!requireRole(request, response, ['admin'])) return;
      const id = Number(groupMatch[1]), dep = await one('SELECT COUNT(*)::int AS count FROM lessons WHERE group_id=$1', [id]);
      if (dep.count) return sendJson(response, 409, { error: 'Нельзя удалить группу, пока к ней привязаны занятия' });
      const changed = await transaction(async (client) => {
        await client.query('UPDATE student_profiles SET group_id=NULL WHERE group_id=$1', [id]);
        const result = await client.query('DELETE FROM study_groups WHERE id=$1', [id]); return result.rowCount;
      });
      if (!changed) return sendJson(response, 404, { error: 'Учебная группа не найдена' });
      return sendJson(response, 200, { ok: true });
    }

    if (request.method === 'GET' && request.url === '/api/teacher/dashboard') {
      const session = requireRole(request, response, ['teacher']); if (!session) return;
      const profile = await one(`SELECT a.name,a.email,p.department,p.position,p.phone FROM accounts a LEFT JOIN teacher_profiles p ON p.account_id=a.id WHERE a.id=$1`, [session.accountId]);
      const lessons = await many(`SELECT l.id,l.title,g.name AS "groupName",l.starts_at AS "startsAt",l.ends_at AS "endsAt",l.status,c.code AS "courseCode",c.name AS "courseName"
        FROM lessons l JOIN courses c ON c.id=l.course_id JOIN study_groups g ON g.id=l.group_id WHERE l.teacher_id=$1 ORDER BY l.starts_at`, [session.accountId]);
      return sendJson(response, 200, { profile, lessons });
    }

    if (request.method === 'GET' && request.url === '/api/student/dashboard') {
      const session = requireRole(request, response, ['student']); if (!session) return;
      const profile = await one(`SELECT a.name,a.email,p.student_number AS "studentNumber",g.id AS "groupId",g.name AS "groupName" FROM accounts a
        LEFT JOIN student_profiles p ON p.account_id=a.id LEFT JOIN study_groups g ON g.id=p.group_id WHERE a.id=$1`, [session.accountId]);
      const lessons = profile && profile.groupId ? await many(`SELECT l.id,l.title,l.starts_at AS "startsAt",l.ends_at AS "endsAt",l.status,c.code AS "courseCode",c.name AS "courseName",a.name AS "teacherName"
        FROM lessons l JOIN courses c ON c.id=l.course_id JOIN accounts a ON a.id=l.teacher_id WHERE l.group_id=$1 ORDER BY l.starts_at`, [profile.groupId]) : [];
      return sendJson(response, 200, { profile, lessons });
    }

    if (request.method === 'GET' && request.url === '/api/courses') {
      if (!requireRole(request, response, ['admin','teacher','student'])) return;
      const rows = await many(`SELECT c.id,c.code,c.name,c.description,c.status,a.name AS "teacherName" FROM courses c LEFT JOIN accounts a ON a.id=c.teacher_id ORDER BY c.code`);
      return sendJson(response, 200, rows.map((r) => ({ ...r, id: Number(r.id) })));
    }

    if (request.url.startsWith('/api/video/')) {
      const session = requireRole(request, response, ['teacher','student']); if (!session) return;
      if (request.method === 'GET' && request.url === '/api/video/ice-config') return sendJson(response, 200, { iceServers: iceServers() });
      if (request.method === 'GET' && request.url === '/api/video/room') return sendJson(response, 200, { ...videoRoom, viewer: session.role });
      if (request.method === 'GET' && request.url === '/api/video/signals') return sendJson(response, 200, { messages: videoSignals[session.role].splice(0) });
      if (request.method === 'POST' && request.url === '/api/video/signals') {
        const body = await readBody(request), target = session.role === 'teacher' ? 'student' : 'teacher';
        if (body.target !== target || !['offer','answer','ice'].includes(body.type) || !body.payload) return sendJson(response, 400, { error: 'Некорректное WebRTC-сообщение' });
        videoSignals[target].push({ id: nextSignalId++, from: session.role, type: body.type, payload: body.payload });
        return sendJson(response, 202, { ok: true });
      }
      if (request.method === 'POST' && request.url === '/api/video/room') {
        const body = await readBody(request);
        if (body.action === 'join') { videoRoom[`${session.role}Joined`] = true; videoRoom.active = true; videoRoom.startedAt ||= Date.now(); videoRoom.revision++; return sendJson(response, 200, { ...videoRoom, viewer: session.role }); }
        if (body.action === 'leave') { videoRoom[`${session.role}Joined`] = false; videoRoom.active = videoRoom.teacherJoined || videoRoom.studentJoined; if (!videoRoom.active) videoRoom.startedAt = null; videoRoom.revision++; return sendJson(response, 200, { ...videoRoom, viewer: session.role }); }
        return sendJson(response, 400, { error: 'Неизвестное действие' });
      }
    }

    return serveStatic(request, response);
  } catch (error) {
    console.error(error);
    const status = error.statusCode || 500;
    const safeMessage = error.message === 'Сервис отправки e-mail не настроен' || error.message === 'Не удалось отправить e-mail' || error.statusCode ? error.message : 'Внутренняя ошибка сервера';
    return sendJson(response, status, { error: safeMessage });
  }
});

initDb().then(() => {
  server.listen(port, () => console.log(`EduLink PostgreSQL: http://localhost:${port}`));
}).catch((error) => {
  console.error('PostgreSQL initialization failed:', error);
  process.exit(1);
});
