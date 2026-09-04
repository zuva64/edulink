const { Pool } = require('pg');
const crypto = require('node:crypto');

if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required for PostgreSQL');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  max: Number(process.env.PG_POOL_MAX || 10),
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 10000
});

async function query(text, params = []) {
  return pool.query(text, params);
}
async function one(text, params = []) {
  const result = await pool.query(text, params);
  return result.rows[0] || null;
}
async function many(text, params = []) {
  const result = await pool.query(text, params);
  return result.rows;
}
async function transaction(work) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await work(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

function hashPassword(password, salt) {
  return crypto.scryptSync(password, salt, 64).toString('hex');
}

async function initDb() {
  await query(`
    CREATE TABLE IF NOT EXISTS accounts(
      id BIGSERIAL PRIMARY KEY,
      name TEXT NOT NULL,
      email TEXT UNIQUE NOT NULL,
      role TEXT NOT NULL CHECK (role IN ('Администратор','Преподаватель','Студент')),
      status TEXT NOT NULL CHECK (status IN ('Активен','Ожидает активации','Заблокирован')),
      last_login TEXT NOT NULL DEFAULT 'Никогда',
      password_hash TEXT NOT NULL,
      password_salt TEXT NOT NULL,
      email_verified BOOLEAN NOT NULL DEFAULT FALSE,
      failed_login_attempts INTEGER NOT NULL DEFAULT 0,
      locked_at BIGINT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS teacher_profiles(
      account_id BIGINT PRIMARY KEY REFERENCES accounts(id) ON DELETE CASCADE,
      department TEXT,
      position TEXT,
      phone TEXT
    );

    CREATE TABLE IF NOT EXISTS study_groups(
      id BIGSERIAL PRIMARY KEY,
      name TEXT UNIQUE NOT NULL,
      academic_year TEXT NOT NULL,
      description TEXT,
      status TEXT NOT NULL DEFAULT 'Активна' CHECK (status IN ('Активна','Архив')),
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS student_profiles(
      account_id BIGINT PRIMARY KEY REFERENCES accounts(id) ON DELETE CASCADE,
      student_number TEXT UNIQUE,
      group_id BIGINT REFERENCES study_groups(id) ON DELETE SET NULL
    );

    CREATE TABLE IF NOT EXISTS courses(
      id BIGSERIAL PRIMARY KEY,
      code TEXT UNIQUE NOT NULL,
      name TEXT NOT NULL,
      description TEXT,
      teacher_id BIGINT REFERENCES accounts(id) ON DELETE SET NULL,
      status TEXT NOT NULL DEFAULT 'Активна' CHECK (status IN ('Активна','Архив')),
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS lessons(
      id BIGSERIAL PRIMARY KEY,
      course_id BIGINT NOT NULL REFERENCES courses(id) ON DELETE RESTRICT,
      teacher_id BIGINT NOT NULL REFERENCES accounts(id) ON DELETE RESTRICT,
      group_id BIGINT NOT NULL REFERENCES study_groups(id) ON DELETE RESTRICT,
      title TEXT NOT NULL,
      starts_at TIMESTAMPTZ NOT NULL,
      ends_at TIMESTAMPTZ NOT NULL,
      status TEXT NOT NULL,
      video_room_id TEXT UNIQUE NOT NULL
    );

    CREATE TABLE IF NOT EXISTS auth_otps(
      email TEXT NOT NULL,
      purpose TEXT NOT NULL,
      otp_hash TEXT NOT NULL,
      expires_at BIGINT NOT NULL,
      attempts INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY(email,purpose)
    );

    CREATE INDEX IF NOT EXISTS idx_accounts_role ON accounts(role);
    CREATE INDEX IF NOT EXISTS idx_accounts_status ON accounts(status);
    CREATE INDEX IF NOT EXISTS idx_student_profiles_group ON student_profiles(group_id);
    CREATE INDEX IF NOT EXISTS idx_courses_teacher ON courses(teacher_id);
    CREATE INDEX IF NOT EXISTS idx_lessons_teacher ON lessons(teacher_id);
    CREATE INDEX IF NOT EXISTS idx_lessons_group ON lessons(group_id);
  `);

  const accounts = [
    [1, 'Анна Крылова', 'anna.krylova@edulink.local', 'Преподаватель', process.env.TEACHER_PASSWORD || 'TeacherDemo123!', 'Активен'],
    [2, 'Алексей Морозов', process.env.ADMIN_EMAIL || 'admin@edulink.local', 'Администратор', process.env.ADMIN_PASSWORD || 'ChangeMe123!', 'Активен'],
    [3, 'Елена Смирнова', 'elena.smirnova@edulink.local', 'Студент', process.env.STUDENT_PASSWORD || 'StudentDemo123!', 'Активен'],
    [4, 'Мария Волкова', 'maria.volkova@edulink.local', 'Преподаватель', 'TeacherDemo123!', 'Активен'],
    [5, 'Илья Петров', 'ilya.petrov@edulink.local', 'Студент', 'StudentDemo123!', 'Ожидает активации']
  ];
  for (const [id, name, email, role, password, status] of accounts) {
    const salt = crypto.createHash('sha256').update(email).digest('hex').slice(0, 32);
    await query(`INSERT INTO accounts(id,name,email,role,status,last_login,password_hash,password_salt,email_verified)
      VALUES($1,$2,$3,$4,$5,'Никогда',$6,$7,TRUE) ON CONFLICT DO NOTHING`,
      [id, name, email, role, status, hashPassword(password, salt), salt]);
  }

  await query(`INSERT INTO teacher_profiles(account_id,department,position,phone)
    VALUES(1,'Кафедра терапии','Доцент','+7 (999) 123-45-67') ON CONFLICT(account_id) DO NOTHING`);
  await query(`INSERT INTO teacher_profiles(account_id,department,position,phone)
    VALUES(4,NULL,NULL,NULL) ON CONFLICT(account_id) DO NOTHING`);

  await query(`INSERT INTO study_groups(id,name,academic_year,description,status)
    VALUES(1,'МЕД-21-01','2026/2027','Демонстрационная учебная группа','Активна') ON CONFLICT DO NOTHING`);
  await query(`INSERT INTO student_profiles(account_id,student_number,group_id)
    VALUES(3,'ST-0003',1) ON CONFLICT(account_id) DO NOTHING`);
  await query(`INSERT INTO student_profiles(account_id,student_number,group_id)
    VALUES(5,'ST-0005',NULL) ON CONFLICT(account_id) DO NOTHING`);

  await query(`INSERT INTO courses(id,code,name,description,teacher_id,status)
    VALUES(1,'MED101','Основы клинического мышления','Учебный курс с очными и онлайн-занятиями.',1,'Активна') ON CONFLICT DO NOTHING`);

  const lessonExists = await one('SELECT id FROM lessons WHERE id=1');
  if (!lessonExists) {
    await query(`INSERT INTO lessons(id,course_id,teacher_id,group_id,title,starts_at,ends_at,status,video_room_id)
      VALUES(1,1,1,1,$1,$2,$3,'Запланировано','lesson-1')`, [
        'Разбор клинического случая',
        new Date(Date.now() + 15 * 60000).toISOString(),
        new Date(Date.now() + 75 * 60000).toISOString()
      ]);
  }

  for (const table of ['accounts','study_groups','courses','lessons']) {
    await query(`SELECT setval(pg_get_serial_sequence('${table}','id'), GREATEST(COALESCE((SELECT MAX(id) FROM ${table}),1),1), true)`);
  }

  await query('SELECT 1');
}

module.exports = { pool, query, one, many, transaction, initDb };
