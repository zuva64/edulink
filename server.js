const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');

const port = Number(process.env.PORT || 8000);
const root = __dirname;
const sessions = new Map();
const db = new DatabaseSync(path.join(root, 'edulink.sqlite'));

db.exec(`
CREATE TABLE IF NOT EXISTS accounts (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  email TEXT UNIQUE NOT NULL,
  role TEXT NOT NULL,
  status TEXT NOT NULL,
  last_login TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  password_salt TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS teacher_profiles (
  account_id INTEGER PRIMARY KEY,
  department TEXT,
  position TEXT,
  phone TEXT,
  FOREIGN KEY(account_id) REFERENCES accounts(id)
);
CREATE TABLE IF NOT EXISTS student_profiles (
  account_id INTEGER PRIMARY KEY,
  student_number TEXT,
  group_name TEXT,
  FOREIGN KEY(account_id) REFERENCES accounts(id)
);
CREATE TABLE IF NOT EXISTS courses (
  id INTEGER PRIMARY KEY,
  code TEXT UNIQUE NOT NULL,
  name TEXT NOT NULL,
  description TEXT
);
CREATE TABLE IF NOT EXISTS lessons (
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
`);

function hashPassword(password, salt) { return crypto.scryptSync(password, salt, 64).toString('hex'); }
function seedAccount(id, name, email, role, password, status = 'Активен') {
  const salt = `${email}-salt`;
  db.prepare('INSERT OR IGNORE INTO accounts (id,name,email,role,status,last_login,password_hash,password_salt) VALUES (?,?,?,?,?,?,?,?)')
    .run(id, name, email, role, status, 'Сегодня', hashPassword(password, salt), salt);
}
seedAccount(1, 'Анна Крылова', 'anna.krylova@edulink.local', 'Преподаватель', process.env.TEACHER_PASSWORD || 'TeacherDemo123!');
seedAccount(2, 'Алексей Морозов', process.env.ADMIN_EMAIL || 'admin@edulink.local', 'Администратор', process.env.ADMIN_PASSWORD || 'ChangeMe123!');
seedAccount(3, 'Елена Смирнова', 'elena.smirnova@edulink.local', 'Студент', process.env.STUDENT_PASSWORD || 'StudentDemo123!');
seedAccount(4, 'Мария Волкова', 'maria.volkova@edulink.local', 'Преподаватель', 'TeacherDemo123!');
seedAccount(5, 'Илья Петров', 'ilya.petrov@edulink.local', 'Студент', 'StudentDemo123!', 'Ожидает активации');
db.prepare('INSERT OR IGNORE INTO teacher_profiles (account_id,department,position,phone) VALUES (1,?,?,?)').run('Кафедра терапии', 'Доцент', '+7 (999) 123-45-67');
db.prepare('INSERT OR IGNORE INTO student_profiles (account_id,student_number,group_name) VALUES (3,?,?)').run('ST-0003', 'МЕД-21-01');
db.prepare('INSERT OR IGNORE INTO courses (id,code,name,description) VALUES (1,?,?,?)').run('MED101', 'Основы клинического мышления', 'Учебный курс с очными и онлайн-занятиями.');
db.prepare('INSERT OR IGNORE INTO lessons (id,course_id,teacher_id,group_name,title,starts_at,ends_at,status,video_room_id) VALUES (1,1,1,?,?,?,?,?,?)')
  .run('МЕД-21-01', 'Разбор клинического случая', new Date(Date.now()+15*60*1000).toISOString(), new Date(Date.now()+75*60*1000).toISOString(), 'Запланировано', 'lesson-1');

const videoRoom = { active: false, teacherJoined: false, studentJoined: false, startedAt: null, revision: 0 };
const videoSignals = { teacher: [], student: [] };
let nextSignalId = 1;

function sendJson(response, status, body, headers = {}) { response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', ...headers }); response.end(JSON.stringify(body)); }
function parseCookies(request) { return Object.fromEntries((request.headers.cookie || '').split(';').filter(Boolean).map((item) => item.trim().split('='))); }
function currentSession(request) { const token = parseCookies(request).edulink_session; return token && sessions.get(token); }
function readBody(request) { return new Promise((resolve, reject) => { let body=''; request.on('data', c => { body += c; if (body.length > 100000) request.destroy(); }); request.on('end', () => { try { resolve(JSON.parse(body || '{}')); } catch (e) { reject(e); } }); request.on('error', reject); }); }
function safeEqual(a,b) { const x=Buffer.from(a); const y=Buffer.from(b); return x.length===y.length && crypto.timingSafeEqual(x,y); }
function roleCode(role) { return role === 'Администратор' ? 'admin' : role === 'Преподаватель' ? 'teacher' : role === 'Студент' ? 'student' : 'staff'; }
function requireRole(request, response, roles) { const session=currentSession(request); if (!session || !roles.includes(session.role)) { sendJson(response, 403, { error:'Недостаточно прав' }); return null; } return session; }
function serveStatic(request,response) { const url=request.url.split('?')[0]; const requested=url==='/'?'/index.html':url; const filePath=path.normalize(path.join(root,requested)); if(!filePath.startsWith(root)||!fs.existsSync(filePath)||fs.statSync(filePath).isDirectory()) return sendJson(response,404,{error:'Не найдено'}); const types={'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8'}; response.writeHead(200,{'Content-Type':types[path.extname(filePath)]||'application/octet-stream'}); fs.createReadStream(filePath).pipe(response); }
function iceServers() { const stun=String(process.env.STUN_URLS||'stun:stun.l.google.com:19302').split(',').map(v=>v.trim()).filter(Boolean); const result=[{urls:stun.length===1?stun[0]:stun}]; const turn=String(process.env.TURN_URLS||process.env.TURN_URL||'').split(',').map(v=>v.trim()).filter(Boolean); if(turn.length) result.push({urls:turn.length===1?turn[0]:turn,username:process.env.TURN_USERNAME||'',credential:process.env.TURN_CREDENTIAL||''}); return result; }

const server=http.createServer(async (request,response)=>{
  try {
    if(request.method==='POST'&&request.url==='/api/login'){
      const body=await readBody(request); const email=String(body.email||'').toLowerCase(); const account=db.prepare('SELECT * FROM accounts WHERE lower(email)=?').get(email);
      if(!account||!safeEqual(hashPassword(String(body.password||''),account.password_salt),account.password_hash)) return sendJson(response,401,{error:'Неверный email или пароль'});
      if(account.status==='Заблокирован') return sendJson(response,403,{error:'Учетная запись заблокирована'});
      const token=crypto.randomBytes(32).toString('hex'); const role=roleCode(account.role); sessions.set(token,{accountId:account.id,email:account.email,role});
      return sendJson(response,200,{email:account.email,role},{'Set-Cookie':`edulink_session=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=28800`});
    }
    if(request.method==='POST'&&request.url==='/api/logout'){ const token=parseCookies(request).edulink_session; if(token) sessions.delete(token); return sendJson(response,200,{ok:true},{'Set-Cookie':'edulink_session=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0'}); }
    if(request.method==='GET'&&request.url==='/api/session'){ const s=currentSession(request); return s?sendJson(response,200,{email:s.email,role:s.role}):sendJson(response,401,{error:'Требуется авторизация'}); }
    if(request.method==='GET'&&request.url==='/api/users'){ if(!requireRole(request,response,['admin'])) return; return sendJson(response,200,db.prepare('SELECT id,name,email,role,status,last_login AS lastLogin FROM accounts ORDER BY id').all()); }
    if(request.method==='POST'&&request.url==='/api/users'){ if(!requireRole(request,response,['admin'])) return; const b=await readBody(request); if(!b.name||!b.email||!['Преподаватель','Студент','Администратор'].includes(b.role)) return sendJson(response,400,{error:'Проверьте имя, email и роль'}); const salt=`${b.email}-salt`; const temp=crypto.randomBytes(9).toString('base64url'); try { db.prepare('INSERT INTO accounts (name,email,role,status,last_login,password_hash,password_salt) VALUES (?,?,?,?,?,?,?)').run(String(b.name).trim(),String(b.email).trim().toLowerCase(),b.role,'Ожидает активации','Никогда',hashPassword(temp,salt),salt); } catch(e) { return sendJson(response,409,{error:'Пользователь с таким email уже существует'}); } return sendJson(response,201,{ok:true}); }

    if(request.method==='GET'&&request.url==='/api/teacher/dashboard'){
      const s=requireRole(request,response,['teacher']); if(!s) return;
      const profile=db.prepare('SELECT a.name,a.email,p.department,p.position,p.phone FROM accounts a LEFT JOIN teacher_profiles p ON p.account_id=a.id WHERE a.id=?').get(s.accountId);
      const lessons=db.prepare(`SELECT l.id,l.title,l.group_name AS groupName,l.starts_at AS startsAt,l.ends_at AS endsAt,l.status,c.code AS courseCode,c.name AS courseName FROM lessons l JOIN courses c ON c.id=l.course_id WHERE l.teacher_id=? ORDER BY l.starts_at`).all(s.accountId);
      return sendJson(response,200,{profile,lessons});
    }
    if(request.method==='GET'&&request.url==='/api/student/dashboard'){
      const s=requireRole(request,response,['student']); if(!s) return;
      const profile=db.prepare('SELECT a.name,a.email,p.student_number AS studentNumber,p.group_name AS groupName FROM accounts a LEFT JOIN student_profiles p ON p.account_id=a.id WHERE a.id=?').get(s.accountId);
      const lessons=profile.groupName?db.prepare(`SELECT l.id,l.title,l.starts_at AS startsAt,l.ends_at AS endsAt,l.status,c.code AS courseCode,c.name AS courseName,a.name AS teacherName FROM lessons l JOIN courses c ON c.id=l.course_id JOIN accounts a ON a.id=l.teacher_id WHERE l.group_name=? ORDER BY l.starts_at`).all(profile.groupName):[];
      return sendJson(response,200,{profile,lessons});
    }
    if(request.method==='GET'&&request.url==='/api/courses'){ const s=requireRole(request,response,['admin','teacher','student']); if(!s) return; return sendJson(response,200,db.prepare('SELECT * FROM courses ORDER BY code').all()); }

    if(request.url.startsWith('/api/video/')){
      const s=requireRole(request,response,['teacher','student']); if(!s) return;
      if(request.method==='GET'&&request.url==='/api/video/ice-config') return sendJson(response,200,{iceServers:iceServers()});
      if(request.method==='GET'&&request.url==='/api/video/room') return sendJson(response,200,{...videoRoom,viewer:s.role});
      if(request.method==='GET'&&request.url==='/api/video/signals') return sendJson(response,200,{messages:videoSignals[s.role].splice(0)});
      if(request.method==='POST'&&request.url==='/api/video/signals'){ const b=await readBody(request); const target=s.role==='teacher'?'student':'teacher'; if(b.target!==target||!['offer','answer','ice'].includes(b.type)||!b.payload) return sendJson(response,400,{error:'Некорректное WebRTC-сообщение'}); videoSignals[target].push({id:nextSignalId++,from:s.role,type:b.type,payload:b.payload}); return sendJson(response,202,{ok:true}); }
      if(request.method==='POST'&&request.url==='/api/video/room'){ const b=await readBody(request); if(b.action==='join'){ videoRoom[`${s.role}Joined`]=true; videoRoom.active=true; videoRoom.startedAt ||= Date.now(); videoRoom.revision++; return sendJson(response,200,{...videoRoom,viewer:s.role}); } if(b.action==='leave'){ videoRoom[`${s.role}Joined`]=false; videoRoom.active=videoRoom.teacherJoined||videoRoom.studentJoined; if(!videoRoom.active) videoRoom.startedAt=null; videoRoom.revision++; return sendJson(response,200,{...videoRoom,viewer:s.role}); } return sendJson(response,400,{error:'Неизвестное действие'}); }
    }
    return serveStatic(request,response);
  } catch(error){ console.error(error); return sendJson(response,500,{error:'Внутренняя ошибка сервера'}); }
});
server.listen(port,()=>console.log(`EduLink: http://localhost:${port}`));
