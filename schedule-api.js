const crypto = require('node:crypto');
const statuses = ['Запланировано', 'Проведено', 'Отменено'];
const select = `SELECT l.id,l.title,l.course_id AS "courseId",l.teacher_id AS "teacherId",
  l.group_id AS "groupId",l.starts_at AS "startsAt",l.ends_at AS "endsAt",l.status,
  l.video_room_id AS "videoRoomId",c.name AS "courseName",c.code AS "courseCode",
  a.name AS "teacherName",g.name AS "groupName"
  FROM lessons l JOIN courses c ON c.id=l.course_id
  JOIN accounts a ON a.id=l.teacher_id JOIN study_groups g ON g.id=l.group_id`;
const fail = (code, message) => { throw Object.assign(new Error(message), { statusCode: code }); };
function id(value) {
  if (!/^[1-9]\d*$/.test(String(value)) || !Number.isSafeInteger(Number(value))) fail(400, 'Некорректный идентификатор');
  return Number(value);
}
function date(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T.*(?:Z|[+-]\d{2}:\d{2})$/.test(value) || !Number.isFinite(Date.parse(value))) fail(400, 'Укажите корректные дату и время с часовым поясом');
  return new Date(value);
}

module.exports = ({ transaction, many, requireRole, readBody, sendJson }) => async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  if (!/^\/api\/admin\/lessons(?:\/|$)/.test(url.pathname)) return false;
  if (!requireRole(req, res, ['admin'])) return true;
  const match = url.pathname.match(/^\/api\/admin\/lessons(?:\/(\d+))?$/);
  if (!match) { sendJson(res, 404, { error: 'Занятие не найдено' }); return true; }
  const lessonId = match[1] ? id(match[1]) : null;
  if (req.method === 'GET') {
    const values = [], clauses = [];
    const where = (sql, value) => { values.push(value); clauses.push(sql.replace('?', `$${values.length}`)); };
    if (lessonId) where('l.id=?', lessonId);
    for (const [key, column] of [['teacherId', 'teacher_id'], ['groupId', 'group_id'], ['courseId', 'course_id']]) {
      if (url.searchParams.get(key)) where(`l.${column}=?`, id(url.searchParams.get(key)));
    }
    const status = url.searchParams.get('status');
    if (status) { if (!statuses.includes(status)) fail(400, 'Некорректный статус'); where('l.status=?', status); }
    const from = url.searchParams.get('from'), to = url.searchParams.get('to');
    if (from) where('l.ends_at>?', date(from));
    if (to) where('l.starts_at<?', date(to));
    if (from && to && date(from) >= date(to)) fail(400, 'Начало периода должно быть раньше конца');
    const search = url.searchParams.get('q')?.trim();
    if (search) where("concat_ws(' ',l.title,c.name,c.code,a.name,g.name) ILIKE ?", `%${search}%`);
    const rows = await many(select + (clauses.length ? ' WHERE ' + clauses.join(' AND ') : '') + ' ORDER BY l.starts_at,l.id', values);
    if (lessonId && !rows.length) fail(404, 'Занятие не найдено');
    sendJson(res, 200, lessonId ? rows[0] : rows); return true;
  }
  if (!((req.method === 'POST' && !lessonId) || (['PUT', 'DELETE'].includes(req.method) && lessonId))) {
    sendJson(res, 405, { error: 'Метод не поддерживается' }); return true;
  }
  const body = req.method === 'DELETE' ? null : await readBody(req);
  const result = await transaction(async (client) => {
    // Serialize schedule mutations so concurrent checks cannot both accept an overlap.
    await client.query('LOCK TABLE lessons IN SHARE ROW EXCLUSIVE MODE');
    let existing;
    if (lessonId) {
      existing = (await client.query('SELECT * FROM lessons WHERE id=$1', [lessonId])).rows[0];
      if (!existing) fail(404, 'Занятие не найдено');
    }
    if (req.method === 'DELETE') {
      const journal = await client.query('SELECT lesson_id FROM lesson_journals WHERE lesson_id=$1', [lessonId]);
      if (journal.rowCount) fail(409, 'У занятия есть журнал. Вместо удаления можно отменить занятие');
      const tests = await client.query('SELECT id FROM lesson_tests WHERE lesson_id=$1 LIMIT 1', [lessonId]);
      if (tests.rowCount) fail(409, 'Занятие содержит тесты. Сохраните его для истории результатов; вместо удаления можно отменить занятие');
      await client.query('DELETE FROM lessons WHERE id=$1', [lessonId]);
      return { ok: true };
    }
    if (!body || typeof body !== 'object' || Array.isArray(body)) fail(400, 'Некорректные данные занятия');
    const title = typeof body.title === 'string' ? body.title.trim() : '';
    if (title.length < 2 || title.length > 200) fail(400, 'Название должно содержать от 2 до 200 символов');
    const courseId = id(body.courseId), teacherId = id(body.teacherId), groupId = id(body.groupId);
    const startsAt = date(body.startsAt), endsAt = date(body.endsAt);
    if (endsAt <= startsAt) fail(400, 'Окончание занятия должно быть позже начала');
    if (!statuses.includes(body.status)) fail(400, 'Некорректный статус занятия');
    const course = (await client.query('SELECT status FROM courses WHERE id=$1 FOR SHARE', [courseId])).rows[0];
    const group = (await client.query('SELECT status FROM study_groups WHERE id=$1 FOR SHARE', [groupId])).rows[0];
    const teacher = (await client.query('SELECT status,role FROM accounts WHERE id=$1 FOR SHARE', [teacherId])).rows[0];
    if (!course || !group || !teacher) fail(400, 'Дисциплина, группа или преподаватель не найдены');
    // Permit cancellation/history editing when an assigned entity was subsequently archived.
    if (body.status !== 'Отменено' && !(existing && body.status === 'Проведено' &&
        Number(existing.course_id) === courseId && Number(existing.group_id) === groupId && Number(existing.teacher_id) === teacherId)) {
      if (course.status !== 'Активна' || group.status !== 'Активна' || teacher.status !== 'Активен' || teacher.role !== 'Преподаватель') fail(400, 'Выберите активную дисциплину, группу и преподавателя');
    }
    if (body.status !== 'Отменено') {
      const conflict = (await client.query(`SELECT l.id,l.title,l.starts_at,l.teacher_id FROM lessons l
        WHERE l.status <> 'Отменено' AND ($1::bigint IS NULL OR l.id<>$1)
        AND (l.teacher_id=$2 OR l.group_id=$3) AND l.starts_at<$5 AND l.ends_at>$4 LIMIT 1`,
      [lessonId, teacherId, groupId, startsAt, endsAt])).rows[0];
      if (conflict) fail(409, `Пересечение расписания: ${Number(conflict.teacher_id) === teacherId ? 'преподаватель' : 'группа'} уже занят(а) — «${conflict.title}»`);
    }
    const values = [title, courseId, teacherId, groupId, startsAt, endsAt, body.status];
    let savedId = lessonId;
    if (lessonId) await client.query(`UPDATE lessons SET title=$1,course_id=$2,teacher_id=$3,group_id=$4,starts_at=$5,ends_at=$6,status=$7 WHERE id=$8`, [...values, lessonId]);
    else savedId = (await client.query(`INSERT INTO lessons(title,course_id,teacher_id,group_id,starts_at,ends_at,status,video_room_id)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`, [...values, 'lesson-' + crypto.randomUUID()])).rows[0].id;
    return (await client.query(select + ' WHERE l.id=$1', [savedId])).rows[0];
  });
  sendJson(res, req.method === 'POST' ? 201 : 200, result); return true;
};
