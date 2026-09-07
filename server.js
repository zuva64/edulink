const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');

const port = Number(process.env.PORT || 8000);
const root = __dirname;
const sessions = new Map();
const db = new DatabaseSync(path.join(root, 'edulink.sqlite'));
db.exec('PRAGMA foreign_keys = ON');

db.exec(`
CREATE TABLE IF NOT EXISTS accounts(
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  email TEXT UNIQUE NOT NULL,
  role TEXT NOT NULL,
  status TEXT NOT NULL,
  last_login TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  password_salt TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS teacher_profiles(
  account_id INTEGER PRIMARY KEY,
  department TEXT,
  position TEXT,
  phone TEXT,
  FOREIGN KEY(account_id) REFERENCES accounts(id) ON DELETE CASCADE
);
CREATE TABLE IF NOT EXISTS student_profiles(
  account_id INTEGER PRIMARY KEY,
  student_number TEXT,
  group_name TEXT,
  FOREIGN KEY(account_id) REFERENCES accounts(id) ON DELETE CASCADE
);
CREATE TABLE IF NOT EXISTS courses(
  id INTEGER PRIMARY KEY,
  code TEXT UNIQUE NOT NULL,
  name TEXT NOT NULL,
  description TEXT
);
CREATE TABLE IF NOT EXISTS lessons(
  id INTEGER PRIMARY KEY,
  course_id INTEGER NOT NULL,
  teacher_id INTEGER NOT NULL,
  group_name TEXT NOT NULL,
  title TEXT NOT NULL,
  starts_at TEXT NOT NULL,
  ends_at TEXT NOT NULL,
  status TEXT NOT NULL,
  video_room_id TEXT NOT NULL,
  FOREIGN KEY(course_id) REFERENCES courses(id),
  FOREIGN KEY(teacher_id) REFERENCES accounts(id)
);
CREATE TABLE IF NOT EXISTS auth_otps(
  email TEXT NOT NULL,
  purpose TEXT NOT NULL,
  otp_hash TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY(email,purpose)
);
`);

function ensureColumn(name, definition) {
  const columns = db.prepare('PRAGMA table_info(accounts)').all().map((row) => row.name);
  if (!columns.includes(name)) db.exec(`ALTER TABLE accounts ADD COLUMN ${name} ${definition}`);
}
ensureColumn('email_verified', 'INTEGER NOT NULL DEFAULT 0');
ensureColumn('failed_login_attempts', 'INTEGER NOT NULL DEFAULT 0');
ensureColumn('locked_at', 'INTEGER');

function hashPassword(password, salt) {
  return crypto.scryptSync(password, salt, 64).toString('hex');
}
function strongPassword(password) {
  return typeof password === 'string' && password.length >= 10 && /[A-Za-zА-Яа-я]/.test(password) && /\d/.test(password);
}
function normalizeEmail(value) {
  return String(value || '').trim().toLowerCase();
}
function validEmail(value) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
}
function safeEqual(a, b) {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}
function roleCode(role) {
  return role === 'Администратор' ? 'admin' : role === 'Преподаватель' ? 'teacher' : role === 'Студент' ? 'student' : 'staff';
}
function invalidateUserSessions(accountId) {
  for (const [token, session] of sessions) if (session.accountId === accountId) sessions.delete(token);
}

function seedAccount(id, name, email, role, password, status = 'Активен') {
  const salt = crypto.createHash('sha256').update(email).digest('hex').slice(0, 32);
  db.prepare(`INSERT OR IGNORE INTO accounts
    (id,name,email,role,status,last_login,password_hash,password_salt,email_verified)
    VALUES(?,?,?,?,?,?,?,?,1)`)
    .run(id, name, email, role, status, 'Сегодня', hashPassword(password, salt), salt);
}
seedAccount(1, 'Анна Крылова', 'anna.krylova@edulink.local', 'Преподаватель', process.env.TEACHER_PASSWORD || 'TeacherDemo123!');
seedAccount(2, 'Алексей Морозов', process.env.ADMIN_EMAIL || 'admin@edulink.local', 'Администратор', process.env.ADMIN_PASSWORD || 'ChangeMe123!');
seedAccount(3, 'Елена Смирнова', 'elena.smirnova@edulink.local', 'Студент', process.env.STUDENT_PASSWORD || 'StudentDemo123!');
seedAccount(4, 'Мария Волкова', 'maria.volkova@edulink.local', 'Преподаватель', 'TeacherDemo123!');
seedAccount(5, 'Илья Петров', 'ilya.petrov@edulink.local', 'Студент', 'StudentDemo123!', 'Ожидает активации');

db.prepare('INSERT OR IGNORE INTO teacher_profiles(account_id,department,position,phone) VALUES(1,?,?,?)')
  .run('Кафедра терапии', 'Доцент', '+7 (999) 123-45-67');
db.prepare('INSERT OR IGNORE INTO student_profiles(account_id,student_number,group_name) VALUES(3,?,?)')
  .run('ST-0003', 'МЕД-21-01');
db.prepare('INSERT OR IGNORE INTO courses(id,code,name,description) VALUES(1,?,?,?)')
  .run('MED101', 'Основы клинического мышления', 'Учебный курс с очными и онлайн-занятиями.');
db.prepare(`INSERT OR IGNORE INTO lessons
  (id,course_id,teacher_id,group_name,title,starts_at,ends_at,status,video_room_id)
  VALUES(1,1,1,?,?,?,?,?,?)`)
  .run('МЕД-21-01', 'Разбор клинического случая', new Date(Date.now() + 15 * 60000).toISOString(), new Date(Date.now() + 75 * 60000).toISOString(), 'Запланировано', 'lesson-1');

const videoRoom = { active: false, teacherJoined: false, studentJoined: false, startedAt: null, revision: 0 };
const videoSignals = { teacher: [], student: [] };
let nextSignalId = 1;

function sendJson(response, status, body, headers = {}) {
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', ...headers });
  response.end(JSON.stringify(body));
}
function parseCookies(request) {
  return Object.fromEntries((request.headers.cookie || '').split(';').filter(Boolean).map((item) => item.trim().split('=')));
}
function currentSession(request) {
  const token = parseCookies(request).edulink_session;
  return token && sessions.get(token);
}
function readBody(request) {
  return new Promise((resolve, reject) => {
    let body = '';
    request.on('data', (chunk) => {
      body += chunk;
      if (body.length > 100000) request.destroy();
    });
    request.on('end', () => {
      try { resolve(JSON.parse(body || '{}')); } catch (error) { reject(error); }
    });
    request.on('error', reject);
  });
}
function requireRole(request, response, roles) {
  const session = currentSession(request);
  if (!session || !roles.includes(session.role)) {
    sendJson(response, 403, { error: 'Недостаточно прав' });
    return null;
  }
  return session;
}
function serveStatic(request, response) {
  const url = request.url.split('?')[0];
  const requested = url === '/' ? '/index.html' : url;
  const filePath = path.normalize(path.join(root, requested));
  if (!filePath.startsWith(root) || !fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
    return sendJson(response, 404, { error: 'Не найдено' });
  }
  const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8' };
  response.writeHead(200, { 'Content-Type': types[path.extname(filePath)] || 'application/octet-stream' });
  fs.createReadStream(filePath).pipe(response);
}
function iceServers() {
  const stun = String(process.env.STUN_URLS || 'stun:stun.l.google.com:19302').split(',').map((v) => v.trim()).filter(Boolean);
  const result = [{ urls: stun.length === 1 ? stun[0] : stun }];
  const turn = String(process.env.TURN_URLS || process.env.TURN_URL || '').split(',').map((v) => v.trim()).filter(Boolean);
  if (turn.length) result.push({ urls: turn.length === 1 ? turn[0] : turn, username: process.env.TURN_USERNAME || '', credential: process.env.TURN_CREDENTIAL || '' });
  return result;
}

const { sendOtp } = require('./mailer');
async function issueOtp(email, purpose) {
  const otp = String(crypto.randomInt(100000, 1000000));
  const hash = crypto.createHash('sha256').update(`${email}:${purpose}:${otp}`).digest('hex');
  db.prepare(`INSERT INTO auth_otps(email,purpose,otp_hash,expires_at,attempts)
    VALUES(?,?,?,?,0)
    ON CONFLICT(email,purpose) DO UPDATE SET otp_hash=excluded.otp_hash,expires_at=excluded.expires_at,attempts=0`)
    .run(email, purpose, hash, Date.now() + 10 * 60000);
  return { otp, ...(await sendOtp(email, otp, purpose)) };
}
function verifyOtp(email, purpose, otp) {
  const row = db.prepare('SELECT * FROM auth_otps WHERE email=? AND purpose=?').get(email, purpose);
  if (!row || Date.now() > row.expires_at) {
    db.prepare('DELETE FROM auth_otps WHERE email=? AND purpose=?').run(email, purpose);
    return false;
  }
  if (row.attempts >= 5) return false;
  const hash = crypto.createHash('sha256').update(`${email}:${purpose}:${otp}`).digest('hex');
  if (!safeEqual(hash, row.otp_hash)) {
    db.prepare('UPDATE auth_otps SET attempts=attempts+1 WHERE email=? AND purpose=?').run(email, purpose);
    return false;
  }
  db.prepare('DELETE FROM auth_otps WHERE email=? AND purpose=?').run(email, purpose);
  return true;
}
function syncRoleProfile(accountId, role) {
  if (role === 'Преподаватель') {
    db.prepare('INSERT OR IGNORE INTO teacher_profiles(account_id,department,position,phone) VALUES(?,?,?,?)').run(accountId, null, null, null);
    db.prepare('DELETE FROM student_profiles WHERE account_id=?').run(accountId);
  } else if (role === 'Студент') {
    db.prepare('INSERT OR IGNORE INTO student_profiles(account_id,student_number,group_name) VALUES(?,?,?)').run(accountId, `ST-${String(accountId).padStart(4, '0')}`, null);
    db.prepare('DELETE FROM teacher_profiles WHERE account_id=?').run(accountId);
  } else {
    db.prepare('DELETE FROM teacher_profiles WHERE account_id=?').run(accountId);
    db.prepare('DELETE FROM student_profiles WHERE account_id=?').run(accountId);
  }
}

const server = http.createServer(async (request, response) => {
  try {
    if (request.method === 'POST' && request.url === '/api/register/request-otp') {
      const body = await readBody(request);
      const email = normalizeEmail(body.email);
      const name = String(body.name || '').trim();
      const password = String(body.password || '');
      if (name.length < 2 || !validEmail(email) || !strongPassword(password)) {
        return sendJson(response, 400, { error: 'Укажите имя, корректный e-mail и пароль не короче 10 символов с буквами и цифрами' });
      }
      const existing = db.prepare('SELECT * FROM accounts WHERE lower(email)=?').get(email);
      if (existing && existing.email_verified) return sendJson(response, 409, { error: 'Учетная запись с таким e-mail уже существует' });
      const salt = crypto.randomBytes(16).toString('hex');
      if (existing) {
        db.prepare(`UPDATE accounts SET name=?,role=?,status=?,password_hash=?,password_salt=?,email_verified=0,
          failed_login_attempts=0,locked_at=NULL WHERE id=?`)
          .run(name, 'Студент', 'Ожидает активации', hashPassword(password, salt), salt, existing.id);
      } else {
        const result = db.prepare(`INSERT INTO accounts(name,email,role,status,last_login,password_hash,password_salt,email_verified)
          VALUES(?,?,?,?,?,?,?,0)`)
          .run(name, email, 'Студент', 'Ожидает активации', 'Никогда', hashPassword(password, salt), salt);
        syncRoleProfile(Number(result.lastInsertRowid), 'Студент');
      }
      const out = await issueOtp(email, 'register');
      return sendJson(response, 200, { ok: true, expiresIn: 600, ...(out.devOtp ? { devOtp: out.devOtp } : {}) });
    }

    if (request.method === 'POST' && request.url === '/api/register/verify') {
      const body = await readBody(request);
      const email = normalizeEmail(body.email);
      if (!verifyOtp(email, 'register', String(body.otp || ''))) return sendJson(response, 400, { error: 'Неверный или просроченный код' });
      const account = db.prepare('SELECT id FROM accounts WHERE lower(email)=?').get(email);
      if (!account) return sendJson(response, 404, { error: 'Регистрация не найдена' });
      db.prepare('UPDATE accounts SET status=?,email_verified=1 WHERE id=?').run('Активен', account.id);
      syncRoleProfile(account.id, 'Студент');
      return sendJson(response, 200, { ok: true });
    }

    if (request.method === 'POST' && request.url === '/api/password/request-reset') {
      const body = await readBody(request);
      const email = normalizeEmail(body.email);
      const account = db.prepare('SELECT * FROM accounts WHERE lower(email)=?').get(email);
      if (account && account.email_verified) await issueOtp(email, 'reset');
      return sendJson(response, 200, { ok: true });
    }

    if (request.method === 'POST' && request.url === '/api/password/reset') {
      const body = await readBody(request);
      const email = normalizeEmail(body.email);
      const password = String(body.password || '');
      if (!strongPassword(password)) return sendJson(response, 400, { error: 'Новый пароль должен содержать не менее 10 символов, буквы и цифры' });
      if (!verifyOtp(email, 'reset', String(body.otp || ''))) return sendJson(response, 400, { error: 'Неверный или просроченный код' });
      const account = db.prepare('SELECT id FROM accounts WHERE lower(email)=?').get(email);
      if (!account) return sendJson(response, 400, { error: 'Не удалось изменить пароль' });
      const salt = crypto.randomBytes(16).toString('hex');
      db.prepare(`UPDATE accounts SET password_hash=?,password_salt=?,failed_login_attempts=0,locked_at=NULL,
        status=CASE WHEN email_verified=1 THEN ? ELSE status END WHERE id=?`)
        .run(hashPassword(password, salt), salt, 'Активен', account.id);
      invalidateUserSessions(account.id);
      return sendJson(response, 200, { ok: true });
    }

    if (request.method === 'POST' && request.url === '/api/account/password') {
      const session = currentSession(request);
      if (!session) return sendJson(response, 401, { error: 'Требуется авторизация' });
      const body = await readBody(request);
      const account = db.prepare('SELECT * FROM accounts WHERE id=?').get(session.accountId);
      const currentPassword = String(body.currentPassword || '');
      const newPassword = String(body.newPassword || '');
      if (!safeEqual(hashPassword(currentPassword, account.password_salt), account.password_hash)) return sendJson(response, 400, { error: 'Текущий пароль указан неверно' });
      if (!strongPassword(newPassword)) return sendJson(response, 400, { error: 'Новый пароль должен содержать не менее 10 символов, буквы и цифры' });
      const salt = crypto.randomBytes(16).toString('hex');
      db.prepare('UPDATE accounts SET password_hash=?,password_salt=? WHERE id=?').run(hashPassword(newPassword, salt), salt, account.id);
      const currentToken = parseCookies(request).edulink_session;
      for (const [token, s] of sessions) if (s.accountId === account.id && token !== currentToken) sessions.delete(token);
      return sendJson(response, 200, { ok: true });
    }

    if (request.method === 'POST' && request.url === '/api/login') {
      const body = await readBody(request);
      const email = normalizeEmail(body.email);
      const account = db.prepare('SELECT * FROM accounts WHERE lower(email)=?').get(email);
      if (!account) return sendJson(response, 401, { error: 'Неверный e-mail или пароль' });
      if (account.status === 'Заблокирован' || account.locked_at) return sendJson(response, 423, { error: 'Учетная запись заблокирована. Восстановите пароль или обратитесь к администратору' });
      if (!account.email_verified) return sendJson(response, 403, { error: 'Сначала подтвердите e-mail' });
      if (!safeEqual(hashPassword(String(body.password || ''), account.password_salt), account.password_hash)) {
        const attempts = (account.failed_login_attempts || 0) + 1;
        if (attempts >= 3) {
          db.prepare('UPDATE accounts SET failed_login_attempts=?,locked_at=?,status=? WHERE id=?').run(attempts, Date.now(), 'Заблокирован', account.id);
          invalidateUserSessions(account.id);
          return sendJson(response, 423, { error: 'Учетная запись заблокирована после 3 неверных попыток входа' });
        }
        db.prepare('UPDATE accounts SET failed_login_attempts=? WHERE id=?').run(attempts, account.id);
        return sendJson(response, 401, { error: `Неверный e-mail или пароль. Осталось попыток: ${3 - attempts}` });
      }
      db.prepare('UPDATE accounts SET failed_login_attempts=0,locked_at=NULL,last_login=? WHERE id=?').run(new Date().toISOString(), account.id);
      const token = crypto.randomBytes(32).toString('hex');
      const role = roleCode(account.role);
      sessions.set(token, { accountId: account.id, email: account.email, role });
      return sendJson(response, 200, { email: account.email, role }, {
        'Set-Cookie': `edulink_session=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=28800${process.env.NODE_ENV === 'production' ? '; Secure' : ''}`
      });
    }

    if (request.method === 'POST' && request.url === '/api/logout') {
      const token = parseCookies(request).edulink_session;
      if (token) sessions.delete(token);
      return sendJson(response, 200, { ok: true }, { 'Set-Cookie': 'edulink_session=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0' });
    }
    if (request.method === 'GET' && request.url === '/api/session') {
      const session = currentSession(request);
      return session ? sendJson(response, 200, { email: session.email, role: session.role }) : sendJson(response, 401, { error: 'Требуется авторизация' });
    }

    if (request.method === 'GET' && request.url === '/api/users') {
      if (!requireRole(request, response, ['admin'])) return;
      return sendJson(response, 200, db.prepare(`SELECT id,name,email,role,status,last_login AS lastLogin,
        email_verified AS emailVerified,failed_login_attempts AS failedLoginAttempts,locked_at AS lockedAt
        FROM accounts ORDER BY id`).all());
    }

    if (request.method === 'POST' && request.url === '/api/users') {
      if (!requireRole(request, response, ['admin'])) return;
      const body = await readBody(request);
      const email = normalizeEmail(body.email);
      if (!body.name || !validEmail(email) || !['Преподаватель', 'Студент', 'Администратор'].includes(body.role)) {
        return sendJson(response, 400, { error: 'Проверьте имя, e-mail и роль' });
      }
      const salt = crypto.randomBytes(16).toString('hex');
      const temporary = crypto.randomBytes(9).toString('base64url') + '7';
      try {
        const result = db.prepare(`INSERT INTO accounts(name,email,role,status,last_login,password_hash,password_salt,email_verified)
          VALUES(?,?,?,?,?,?,?,0)`)
          .run(String(body.name).trim(), email, body.role, 'Ожидает активации', 'Никогда', hashPassword(temporary, salt), salt);
        syncRoleProfile(Number(result.lastInsertRowid), body.role);
      } catch (error) {
        return sendJson(response, 409, { error: 'Пользователь с таким e-mail уже существует' });
      }
      return sendJson(response, 201, { ok: true });
    }

    const userMatch = request.url.match(/^\/api\/users\/(\d+)$/);
    if (request.method === 'PUT' && userMatch) {
      const adminSession = requireRole(request, response, ['admin']);
      if (!adminSession) return;
      const id = Number(userMatch[1]);
      const body = await readBody(request);
      const account = db.prepare('SELECT * FROM accounts WHERE id=?').get(id);
      if (!account) return sendJson(response, 404, { error: 'Пользователь не найден' });
      const name = String(body.name || '').trim();
      const email = normalizeEmail(body.email);
      const role = String(body.role || '');
      const status = String(body.status || '');
      const emailVerified = body.emailVerified ? 1 : 0;
      if (name.length < 2 || !validEmail(email) || !['Преподаватель', 'Студент', 'Администратор'].includes(role) || !['Активен', 'Ожидает активации', 'Заблокирован'].includes(status)) {
        return sendJson(response, 400, { error: 'Проверьте данные пользователя' });
      }
      if (id === adminSession.accountId && (role !== 'Администратор' || status === 'Заблокирован')) {
        return sendJson(response, 400, { error: 'Нельзя снять с себя роль администратора или заблокировать собственную учетную запись' });
      }
      try {
        db.prepare(`UPDATE accounts SET name=?,email=?,role=?,status=?,email_verified=?,
          locked_at=CASE WHEN ?='Заблокирован' THEN COALESCE(locked_at,?) ELSE NULL END,
          failed_login_attempts=CASE WHEN ?='Заблокирован' THEN failed_login_attempts ELSE 0 END
          WHERE id=?`)
          .run(name, email, role, status, emailVerified, status, Date.now(), status, id);
      } catch (error) {
        return sendJson(response, 409, { error: 'Этот e-mail уже используется' });
      }
      syncRoleProfile(id, role);
      invalidateUserSessions(id);
      return sendJson(response, 200, { ok: true });
    }

    const unlock = request.url.match(/^\/api\/users\/(\d+)\/unlock$/);
    if (request.method === 'POST' && unlock) {
      if (!requireRole(request, response, ['admin'])) return;
      const id = Number(unlock[1]);
      const account = db.prepare('SELECT email_verified FROM accounts WHERE id=?').get(id);
      if (!account) return sendJson(response, 404, { error: 'Пользователь не найден' });
      db.prepare('UPDATE accounts SET status=?,failed_login_attempts=0,locked_at=NULL WHERE id=?').run(account.email_verified ? 'Активен' : 'Ожидает активации', id);
      return sendJson(response, 200, { ok: true });
    }

    const block = request.url.match(/^\/api\/users\/(\d+)\/block$/);
    if (request.method === 'POST' && block) {
      const adminSession = requireRole(request, response, ['admin']);
      if (!adminSession) return;
      const id = Number(block[1]);
      if (id === adminSession.accountId) return sendJson(response, 400, { error: 'Нельзя заблокировать собственную учетную запись' });
      const result = db.prepare('UPDATE accounts SET status=?,locked_at=?,failed_login_attempts=3 WHERE id=?').run('Заблокирован', Date.now(), id);
      if (!result.changes) return sendJson(response, 404, { error: 'Пользователь не найден' });
      invalidateUserSessions(id);
      return sendJson(response, 200, { ok: true });
    }

    const sendReset = request.url.match(/^\/api\/users\/(\d+)\/send-reset$/);
    if (request.method === 'POST' && sendReset) {
      if (!requireRole(request, response, ['admin'])) return;
      const id = Number(sendReset[1]);
      const account = db.prepare('SELECT email,email_verified FROM accounts WHERE id=?').get(id);
      if (!account) return sendJson(response, 404, { error: 'Пользователь не найден' });
      if (!account.email_verified) return sendJson(response, 400, { error: 'Сначала нужно подтвердить e-mail пользователя' });
      await issueOtp(account.email, 'reset');
      return sendJson(response, 200, { ok: true });
    }

    if (request.method === 'DELETE' && userMatch) {
      const adminSession = requireRole(request, response, ['admin']);
      if (!adminSession) return;
      const id = Number(userMatch[1]);
      if (id === adminSession.accountId) return sendJson(response, 400, { error: 'Нельзя удалить собственную учетную запись' });
      const account = db.prepare('SELECT email,role FROM accounts WHERE id=?').get(id);
      if (!account) return sendJson(response, 404, { error: 'Пользователь не найден' });
      const lessonCount = db.prepare('SELECT COUNT(*) AS count FROM lessons WHERE teacher_id=?').get(id).count;
      if (lessonCount > 0) return sendJson(response, 409, { error: 'Нельзя удалить преподавателя, у которого есть занятия. Сначала переназначьте или удалите занятия.' });
      db.prepare('DELETE FROM auth_otps WHERE email=?').run(account.email);
      db.prepare('DELETE FROM teacher_profiles WHERE account_id=?').run(id);
      db.prepare('DELETE FROM student_profiles WHERE account_id=?').run(id);
      db.prepare('DELETE FROM accounts WHERE id=?').run(id);
      invalidateUserSessions(id);
      return sendJson(response, 200, { ok: true });
    }

    if (request.method === 'GET' && request.url === '/api/teacher/dashboard') {
      const session = requireRole(request, response, ['teacher']);
      if (!session) return;
      const profile = db.prepare(`SELECT a.name,a.email,p.department,p.position,p.phone FROM accounts a
        LEFT JOIN teacher_profiles p ON p.account_id=a.id WHERE a.id=?`).get(session.accountId);
      const lessons = db.prepare(`SELECT l.id,l.title,l.group_name AS groupName,l.starts_at AS startsAt,l.ends_at AS endsAt,l.status,
        c.code AS courseCode,c.name AS courseName FROM lessons l JOIN courses c ON c.id=l.course_id
        WHERE l.teacher_id=? ORDER BY l.starts_at`).all(session.accountId);
      return sendJson(response, 200, { profile, lessons });
    }

    if (request.method === 'GET' && request.url === '/api/student/dashboard') {
      const session = requireRole(request, response, ['student']);
      if (!session) return;
      const profile = db.prepare(`SELECT a.name,a.email,p.student_number AS studentNumber,p.group_name AS groupName FROM accounts a
        LEFT JOIN student_profiles p ON p.account_id=a.id WHERE a.id=?`).get(session.accountId);
      const lessons = profile.groupName ? db.prepare(`SELECT l.id,l.title,l.starts_at AS startsAt,l.ends_at AS endsAt,l.status,
        c.code AS courseCode,c.name AS courseName,a.name AS teacherName FROM lessons l JOIN courses c ON c.id=l.course_id
        JOIN accounts a ON a.id=l.teacher_id WHERE l.group_name=? ORDER BY l.starts_at`).all(profile.groupName) : [];
      return sendJson(response, 200, { profile, lessons });
    }

    if (request.method === 'GET' && request.url === '/api/courses') {
      if (!requireRole(request, response, ['admin', 'teacher', 'student'])) return;
      return sendJson(response, 200, db.prepare('SELECT * FROM courses ORDER BY code').all());
    }

    if (request.url.startsWith('/api/video/')) {
      const session = requireRole(request, response, ['teacher', 'student']);
      if (!session) return;
      if (request.method === 'GET' && request.url === '/api/video/ice-config') return sendJson(response, 200, { iceServers: iceServers() });
      if (request.method === 'GET' && request.url === '/api/video/room') return sendJson(response, 200, { ...videoRoom, viewer: session.role });
      if (request.method === 'GET' && request.url === '/api/video/signals') return sendJson(response, 200, { messages: videoSignals[session.role].splice(0) });
      if (request.method === 'POST' && request.url === '/api/video/signals') {
        const body = await readBody(request);
        const target = session.role === 'teacher' ? 'student' : 'teacher';
        if (body.target !== target || !['offer', 'answer', 'ice'].includes(body.type) || !body.payload) return sendJson(response, 400, { error: 'Некорректное WebRTC-сообщение' });
        videoSignals[target].push({ id: nextSignalId++, from: session.role, type: body.type, payload: body.payload });
        return sendJson(response, 202, { ok: true });
      }
      if (request.method === 'POST' && request.url === '/api/video/room') {
        const body = await readBody(request);
        if (body.action === 'join') {
          videoRoom[`${session.role}Joined`] = true;
          videoRoom.active = true;
          videoRoom.startedAt ||= Date.now();
          videoRoom.revision++;
          return sendJson(response, 200, { ...videoRoom, viewer: session.role });
        }
        if (body.action === 'leave') {
          videoRoom[`${session.role}Joined`] = false;
          videoRoom.active = videoRoom.teacherJoined || videoRoom.studentJoined;
          if (!videoRoom.active) videoRoom.startedAt = null;
          videoRoom.revision++;
          return sendJson(response, 200, { ...videoRoom, viewer: session.role });
        }
        return sendJson(response, 400, { error: 'Неизвестное действие' });
      }
    }

    return serveStatic(request, response);
  } catch (error) {
    console.error(error);
    return sendJson(response, 500, { error: error.message === 'Сервис отправки e-mail не настроен' ? error.message : 'Внутренняя ошибка сервера' });
  }
});

server.listen(port, () => console.log(`EduLink: http://localhost:${port}`));
