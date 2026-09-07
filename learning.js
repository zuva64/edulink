// Lesson plans and timed assessments. PostgreSQL is the source of truth for attempts.
const fail = (statusCode, message) => { throw Object.assign(new Error(message), { statusCode }); };
const integer = (v, min, max) => Number.isInteger(Number(v)) && Number(v) >= min && Number(v) <= max;
const clean = (v, max = 200) => typeof v === 'string' && v.trim().length <= max ? v.trim() : '';
const same = (a, b) => JSON.stringify([...a].sort()) === JSON.stringify([...b].sort());

async function init(query) {
  await query(`CREATE TABLE IF NOT EXISTS lesson_plans (
    lesson_id BIGINT PRIMARY KEY REFERENCES lessons(id) ON DELETE CASCADE,
    objective TEXT NOT NULL DEFAULT '', steps JSONB NOT NULL DEFAULT '[]',
    version INTEGER NOT NULL DEFAULT 1, updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW());
  CREATE TABLE IF NOT EXISTS lesson_tests (
    id BIGSERIAL PRIMARY KEY, lesson_id BIGINT NOT NULL REFERENCES lessons(id) ON DELETE RESTRICT,
    title TEXT NOT NULL, duration_minutes INTEGER NOT NULL CHECK(duration_minutes BETWEEN 1 AND 240),
    questions JSONB NOT NULL, state TEXT NOT NULL DEFAULT 'draft' CHECK(state IN ('draft','open','closed')),
    version INTEGER NOT NULL DEFAULT 1, opened_at TIMESTAMPTZ, closed_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW());
  CREATE TABLE IF NOT EXISTS test_attempts (
    id BIGSERIAL PRIMARY KEY, test_id BIGINT NOT NULL REFERENCES lesson_tests(id) ON DELETE RESTRICT,
    student_id BIGINT NOT NULL REFERENCES accounts(id) ON DELETE RESTRICT,
    started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), expires_at TIMESTAMPTZ NOT NULL,
    finished_at TIMESTAMPTZ, finish_reason TEXT CHECK(finish_reason IN ('submitted','timeout','teacher')),
    answers JSONB NOT NULL DEFAULT '{}', grades JSONB NOT NULL DEFAULT '{}',
    UNIQUE(test_id,student_id));
  CREATE INDEX IF NOT EXISTS idx_lesson_tests_lesson ON lesson_tests(lesson_id);
  CREATE INDEX IF NOT EXISTS idx_attempts_active ON test_attempts(expires_at) WHERE finished_at IS NULL;`);
}

function validateTest(body) {
  if (!body || !clean(body.title)) fail(400, 'Укажите название теста (до 200 символов)');
  if (!integer(body.durationMinutes, 1, 240)) fail(400, 'Длительность: от 1 до 240 минут');
  if (!integer(body.questionCount, 1, 50) || !Array.isArray(body.questions) || body.questions.length !== Number(body.questionCount)) fail(400, 'Количество заданий должно совпадать с числом вопросов (1–50)');
  const questions = body.questions.map((q, index) => {
    if (!q || !clean(q.prompt, 2000) || !['single','multiple','text'].includes(q.type)) fail(400, `Проверьте формулировку и тип задания ${index + 1}`);
    if (q.type === 'text') return { id: String(index + 1), type: 'text', prompt: q.prompt.trim(), options: [], correct: [] };
    if (!Array.isArray(q.options) || q.options.length < 2 || q.options.length > 10 || q.options.some(v => !clean(v, 500))) fail(400, `Задание ${index + 1}: необходимо 2–10 непустых вариантов`);
    if (new Set(q.options.map(v => v.trim())).size !== q.options.length) fail(400, 'Варианты ответа не должны повторяться');
    if (!Array.isArray(q.correct) || !q.correct.length || (q.type === 'single' && q.correct.length !== 1) || new Set(q.correct).size !== q.correct.length || q.correct.some(v => !Number.isInteger(v) || v < 0 || v >= q.options.length)) fail(400, `Укажите правильные ответы задания ${index + 1}`);
    return { id: String(index + 1), type: q.type, prompt: q.prompt.trim(), options: q.options.map(v => v.trim()), correct: q.correct };
  });
  return { title: body.title.trim(), duration: Number(body.durationMinutes), questions };
}
function validateAnswers(questions, answers) {
  if (!answers || typeof answers !== 'object' || Array.isArray(answers) || Object.keys(answers).some(k => !questions.some(q => q.id === k))) fail(400, 'Некорректные ответы');
  const normalized = {};
  for (const q of questions) {
    const value = answers[q.id];
    if (value === undefined) continue;
    if (q.type === 'text') {
      if (typeof value !== 'string' || value.length > 10000) fail(400, 'Свободный ответ: не более 10 000 символов');
      normalized[q.id] = value;
    } else {
      if (!Array.isArray(value) || (q.type === 'single' && value.length > 1) || new Set(value).size !== value.length || value.some(v => !Number.isInteger(v) || v < 0 || v >= q.options.length)) fail(400, 'Некорректный выбор ответа');
      normalized[q.id] = value;
    }
  }
  return normalized;
}
function result(attempt, questions) {
  if (!attempt.finished_at) return null;
  let score = 0, pending = 0;
  for (const q of questions) {
    if (q.type === 'text') {
      if (attempt.grades[q.id] === undefined) pending++;
      else score += attempt.grades[q.id];
    } else if (same(attempt.answers[q.id] || [], q.correct)) score++;
  }
  return { score, total: questions.length, pending };
}
function attemptView(a, questions) {
  return a ? { id: a.id, startedAt: a.started_at, expiresAt: a.expires_at, finishedAt: a.finished_at,
    finishReason: a.finish_reason, answers: a.answers, result: result(a, questions) } : null;
}
async function expire(client) {
  await client.query(`UPDATE test_attempts SET finished_at=expires_at,finish_reason='timeout'
    WHERE finished_at IS NULL AND expires_at<=clock_timestamp()`);
}

function create({ query, transaction, currentSession, readBody, sendJson }) {
  return async (req, res) => {
    const path = new URL(req.url, 'http://localhost').pathname;
    const planMatch = path.match(/^\/api\/learning\/lessons\/(\d+)(?:\/(plan|tests))?$/);
    const testMatch = path.match(/^\/api\/learning\/tests\/(\d+)(?:\/(open|close|attempt|start|answers|submit|monitor|grade))?$/);
    if (!path.startsWith('/api/learning/')) return false;
    const session = currentSession(req);
    if (!session || !['teacher','student'].includes(session.role)) fail(403, 'Требуется вход преподавателя или студента');
    if (!planMatch && !testMatch) fail(404, 'Не найдено');
    const body = ['POST','PUT'].includes(req.method) ? await readBody(req) : null;
    const data = await transaction(async client => {
      let test, lesson;
      if (testMatch) {
        // All operations on a test share this lock (including start, submit and teacher close).
        test = (await client.query('SELECT * FROM lesson_tests WHERE id=$1 FOR UPDATE', [testMatch[1]])).rows[0];
        if (!test) fail(404, 'Тест не найден');
        lesson = (await client.query('SELECT * FROM lessons WHERE id=$1 FOR SHARE', [test.lesson_id])).rows[0];
      } else lesson = (await client.query('SELECT * FROM lessons WHERE id=$1 FOR SHARE', [planMatch[1]])).rows[0];
      if (!lesson) fail(404, 'Занятие не найдено');
      if (session.role === 'teacher') {
        if (Number(lesson.teacher_id) !== session.accountId) fail(403, 'Это занятие другого преподавателя');
      } else {
        const profile = (await client.query('SELECT group_id FROM student_profiles WHERE account_id=$1', [session.accountId])).rows[0];
        if (!profile || Number(profile.group_id) !== Number(lesson.group_id)) fail(403, 'Занятие недоступно вашей группе');
      }
      const teacherOnly = () => { if (session.role !== 'teacher') fail(403, 'Действие доступно только преподавателю'); };
      const op = planMatch?.[2] || testMatch?.[2] || '';
      if (planMatch) {
        if (req.method === 'GET' && !op) {
          const plan = (await client.query('SELECT * FROM lesson_plans WHERE lesson_id=$1', [lesson.id])).rows[0];
          const tests = (await client.query('SELECT * FROM lesson_tests WHERE lesson_id=$1 ORDER BY id', [lesson.id])).rows;
          return { lesson: { id: lesson.id, title: lesson.title, status: lesson.status }, role: session.role,
            plan: plan || { objective: '', steps: [], version: 0 },
            tests: tests.map(t => ({ id: t.id, title: t.title, durationMinutes: t.duration_minutes, questionCount: t.questions.length,
              state: t.state, version: t.version, openedAt: t.opened_at, closedAt: t.closed_at,
              ...(session.role === 'teacher' ? { questions: t.questions } : {}) })) };
        }
        teacherOnly();
        if (req.method === 'PUT' && op === 'plan') {
          if (!body || typeof body.objective !== 'string' || body.objective.length > 5000 || !Array.isArray(body.steps) || body.steps.length > 50) fail(400, 'Проверьте цель и этапы плана (не более 50)');
          await client.query('SELECT pg_advisory_xact_lock(72931,$1::int)', [Number(lesson.id)]);
          const steps = [];
          for (const s of body.steps) {
            if (!s || !clean(s.title) || typeof s.description !== 'string' || s.description.length > 5000 || !integer(s.minutes, 0, 480)) fail(400, 'Укажите название, описание и длительность этапа');
            if (s.testId) {
              if (!integer(s.testId, 1, Number.MAX_SAFE_INTEGER)) fail(400, 'Некорректный тест');
              const linked = (await client.query('SELECT id FROM lesson_tests WHERE id=$1 AND lesson_id=$2', [s.testId, lesson.id])).rows[0];
              if (!linked) fail(400, 'Тест этапа должен принадлежать этому занятию');
            }
            steps.push({ title: s.title.trim(), description: s.description, minutes: Number(s.minutes), testId: s.testId ? String(s.testId) : null });
          }
          // Serialize concurrent first saves and reject stale edits.
          const existing = (await client.query('SELECT version FROM lesson_plans WHERE lesson_id=$1', [lesson.id])).rows[0];
          if (Number(body.version) !== (existing?.version || 0)) fail(409, 'План уже изменён. Обновите страницу перед сохранением');
          return (await client.query(`INSERT INTO lesson_plans(lesson_id,objective,steps) VALUES($1,$2,$3)
            ON CONFLICT(lesson_id) DO UPDATE SET objective=$2,steps=$3,version=lesson_plans.version+1,updated_at=NOW() RETURNING *`, [lesson.id, body.objective, JSON.stringify(steps)])).rows[0];
        }
        if (req.method === 'POST' && op === 'tests') {
          const t = validateTest(body);
          return (await client.query(`INSERT INTO lesson_tests(lesson_id,title,duration_minutes,questions) VALUES($1,$2,$3,$4) RETURNING id`, [lesson.id, t.title, t.duration, JSON.stringify(t.questions)])).rows[0];
        }
        fail(405, 'Метод не поддерживается');
      }
      // Set the exact deadline as completion time, regardless of polling or server restarts.
      await client.query(`UPDATE test_attempts SET finished_at=expires_at,finish_reason='timeout'
        WHERE test_id=$1 AND finished_at IS NULL AND expires_at<=clock_timestamp()`, [test.id]);
      if (!op && ['PUT','DELETE'].includes(req.method)) {
        teacherOnly();
        if (test.state !== 'draft') fail(409, 'После открытия тест нельзя редактировать или удалять');
        if (req.method === 'DELETE') {
          await client.query('SELECT pg_advisory_xact_lock(72931,$1::int)', [Number(lesson.id)]);
          const plans = (await client.query('SELECT steps FROM lesson_plans WHERE lesson_id=$1', [lesson.id])).rows;
          if (plans.some(p => p.steps.some(s => String(s.testId) === String(test.id)))) fail(409, 'Сначала уберите тест из этапов плана');
          await client.query('DELETE FROM lesson_tests WHERE id=$1', [test.id]); return { ok: true };
        }
        if (Number(body?.version) !== test.version) fail(409, 'Тест изменён. Обновите страницу');
        const t = validateTest(body);
        await client.query('UPDATE lesson_tests SET title=$1,duration_minutes=$2,questions=$3,version=version+1 WHERE id=$4', [t.title, t.duration, JSON.stringify(t.questions), test.id]);
        return { ok: true };
      }
      if (['open','close'].includes(op) && req.method === 'POST') {
        teacherOnly();
        if (op === 'open') {
          if (test.state !== 'draft') fail(409, 'Открыть можно только новый тест');
          if (lesson.status !== 'Запланировано') fail(409, 'Занятие отменено или уже проведено');
          await client.query("UPDATE lesson_tests SET state='open',opened_at=clock_timestamp(),version=version+1 WHERE id=$1", [test.id]);
        } else {
          if (test.state !== 'open') fail(409, 'Тест не открыт');
          const closed = (await client.query("UPDATE lesson_tests SET state='closed',closed_at=clock_timestamp(),version=version+1 WHERE id=$1 RETURNING closed_at", [test.id])).rows[0].closed_at;
          await client.query("UPDATE test_attempts SET finished_at=LEAST(expires_at,$2),finish_reason=CASE WHEN expires_at<=$2 THEN 'timeout' ELSE 'teacher' END WHERE test_id=$1 AND finished_at IS NULL", [test.id, closed]);
        }
        return { ok: true };
      }
      if (op === 'monitor' && req.method === 'GET') {
        teacherOnly();
        const rows = (await client.query(`SELECT a.id AS account_id,a.name,a.email,p.* FROM accounts a
          LEFT JOIN test_attempts p ON p.student_id=a.id AND p.test_id=$1
          WHERE a.id IN (SELECT account_id FROM student_profiles WHERE group_id=$2)
          OR a.id IN (SELECT student_id FROM test_attempts WHERE test_id=$1) ORDER BY a.name`, [test.id, lesson.group_id])).rows;
        return { serverNow: new Date().toISOString(), state: test.state, questions: test.questions,
          students: rows.map(a => ({ studentId: a.account_id, name: a.name, email: a.email,
            attempt: a.id ? { ...attemptView(a, test.questions), grades: a.grades } : null })) };
      }
      if (op === 'grade' && req.method === 'PUT') {
        teacherOnly();
        if (!integer(body?.attemptId, 1, Number.MAX_SAFE_INTEGER) || !body.grades || typeof body.grades !== 'object' || Array.isArray(body.grades)) fail(400, 'Некорректная оценка');
        for (const [key, value] of Object.entries(body.grades)) if (!test.questions.some(q => q.id === key && q.type === 'text') || ![0,1].includes(value)) fail(400, 'Свободный ответ оценивается в 0 или 1 балл');
        const changed = await client.query('UPDATE test_attempts SET grades=grades || $1::jsonb WHERE id=$2 AND test_id=$3 AND finished_at IS NOT NULL RETURNING id', [JSON.stringify(body.grades), body.attemptId, test.id]);
        if (!changed.rowCount) fail(409, 'Можно оценить только завершённую попытку этого теста');
        return { ok: true };
      }
      if (session.role !== 'student') fail(403, 'Попытка доступна только студенту');
      let attempt = (await client.query('SELECT * FROM test_attempts WHERE test_id=$1 AND student_id=$2 FOR UPDATE', [test.id, session.accountId])).rows[0];
      if (op === 'start' && req.method === 'POST') {
        if (!attempt) {
          if (test.state !== 'open' || lesson.status !== 'Запланировано') fail(409, 'Преподаватель ещё не открыл тест или уже завершил занятие');
          attempt = (await client.query(`INSERT INTO test_attempts(test_id,student_id,expires_at)
            VALUES($1,$2,clock_timestamp()+($3 * interval '1 minute')) RETURNING *`, [test.id, session.accountId, test.duration_minutes])).rows[0];
        }
      } else if (['answers','submit'].includes(op) && req.method === 'PUT') {
        if (!attempt) fail(409, 'Сначала начните тест');
        if (!attempt.finished_at) {
          const answers = validateAnswers(test.questions, body?.answers);
          const changed = await client.query(`UPDATE test_attempts SET answers=$1,
            finished_at=CASE WHEN $2 THEN clock_timestamp() ELSE NULL END,
            finish_reason=CASE WHEN $2 THEN 'submitted' ELSE NULL END
            WHERE id=$3 AND finished_at IS NULL AND expires_at>clock_timestamp() RETURNING *`, [JSON.stringify(answers), op === 'submit', attempt.id]);
          if (changed.rowCount) attempt = changed.rows[0];
          else {
            attempt = (await client.query("UPDATE test_attempts SET finished_at=expires_at,finish_reason='timeout' WHERE id=$1 AND finished_at IS NULL RETURNING *", [attempt.id])).rows[0];
          }
        }
      } else if (!(op === 'attempt' && req.method === 'GET')) fail(405, 'Метод не поддерживается');
      return { serverNow: new Date().toISOString(), state: test.state, title: test.title,
        questions: attempt ? test.questions.map(({ correct, ...q }) => q) : [], attempt: attemptView(attempt, test.questions) };
    });
    sendJson(res, 200, data); return true;
  };
}
module.exports = { init, create, expire, result };
