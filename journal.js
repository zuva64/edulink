const { result: testResult } = require('./learning');
const fail = (statusCode,message) => {throw Object.assign(new Error(message),{statusCode});};
async function init(query) {
  await query(`CREATE TABLE IF NOT EXISTS lesson_journals(
    lesson_id BIGINT PRIMARY KEY REFERENCES lessons(id) ON DELETE RESTRICT,
    version INTEGER NOT NULL DEFAULT 1, updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW());
  CREATE TABLE IF NOT EXISTS lesson_marks(
    lesson_id BIGINT NOT NULL REFERENCES lessons(id) ON DELETE RESTRICT,
    student_id BIGINT NOT NULL REFERENCES accounts(id) ON DELETE RESTRICT,
    attendance TEXT NOT NULL DEFAULT 'unmarked' CHECK(attendance IN ('unmarked','present','late','absent','excused')),
    final_score NUMERIC(5,2) CHECK(final_score BETWEEN 0 AND 100),
    note TEXT NOT NULL DEFAULT '', updated_by BIGINT REFERENCES accounts(id) ON DELETE SET NULL,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), PRIMARY KEY(lesson_id,student_id));
  CREATE INDEX IF NOT EXISTS idx_marks_student ON lesson_marks(student_id);`);
}
function create({transaction,currentSession,readBody,sendJson}) {
  return async(req,res)=>{
    const url=new URL(req.url,'http://localhost');
    if(!url.pathname.startsWith('/api/journal/'))return false;
    const session=currentSession(req);if(!session)fail(401,'Войдите в учётную запись');
    const lessonMatch=url.pathname.match(/^\/api\/journal\/lessons\/(\d+)(?:\/(complete))?$/);
    const ratingMatch=url.pathname.match(/^\/api\/journal\/courses\/(\d+)$/);
    const list=url.pathname==='/api/journal/courses';
    if(!list&&!lessonMatch&&!ratingMatch)fail(404,'Не найдено');
    const body=['PUT','POST'].includes(req.method)?await readBody(req):null;
    const output=await transaction(async c=>{
      if(list&&req.method==='GET') {
        return (await c.query(`SELECT DISTINCT c.id,c.code,c.name FROM courses c LEFT JOIN lessons l ON l.course_id=c.id
          WHERE $1='admin' OR ($1='teacher' AND (c.teacher_id=$2 OR l.teacher_id=$2))
          OR ($1='student' AND (l.group_id=(SELECT group_id FROM student_profiles WHERE account_id=$2)
            OR l.id IN (SELECT lesson_id FROM lesson_marks WHERE student_id=$2))) ORDER BY c.name`,[session.role,session.accountId])).rows;
      }
      if(lessonMatch) {
        // Same lock order as schedule mutations: lesson first, then journal rows.
        const lesson=(await c.query(`SELECT l.*,c.name AS course_name,g.name AS group_name FROM lessons l
          JOIN courses c ON c.id=l.course_id JOIN study_groups g ON g.id=l.group_id WHERE l.id=$1 FOR UPDATE OF l`,[lessonMatch[1]])).rows[0];
        if(!lesson)fail(404,'Занятие не найдено');
        if(!['teacher','admin'].includes(session.role)||(session.role==='teacher'&&Number(lesson.teacher_id)!==session.accountId))fail(403,'Нет доступа к журналу этого занятия');
        const header=(await c.query('SELECT * FROM lesson_journals WHERE lesson_id=$1',[lesson.id])).rows[0];
        const roster=(await c.query(`SELECT a.id,a.name,a.email,m.attendance,m.final_score,m.note FROM accounts a
          LEFT JOIN lesson_marks m ON m.student_id=a.id AND m.lesson_id=$1
          WHERE a.id IN (SELECT account_id FROM student_profiles WHERE group_id=$2)
          OR m.student_id IS NOT NULL OR a.id IN (SELECT p.student_id FROM test_attempts p JOIN lesson_tests t ON t.id=p.test_id WHERE t.lesson_id=$1)
          ORDER BY a.name,a.id`,[lesson.id,lesson.group_id])).rows;
        if(req.method==='PUT'&&!lessonMatch[2]) {
          if(session.role!=='teacher')fail(403,'Журнал заполняет преподаватель занятия');
          if(lesson.status==='Отменено')fail(409,'Нельзя изменять журнал отменённого занятия');
          if(!body||!Number.isInteger(body.version)||body.version!==(header?.version||0))fail(409,'Журнал уже изменён. Обновите страницу');
          if(!Array.isArray(body.rows)||body.rows.length!==roster.length||new Set(body.rows.map(r=>String(r?.studentId))).size!==roster.length)fail(400,'Отправьте по одной строке для каждого студента журнала');
          const finished=lesson.status==='Проведено'||new Date(lesson.ends_at)<=new Date();
          for(const row of body.rows) {
            if(!row||!roster.some(s=>String(s.id)===String(row.studentId)))fail(400,'Студент не относится к занятию');
            if(!['unmarked','present','late','absent','excused'].includes(row.attendance))fail(400,'Некорректная отметка посещения');
            const raw=row.finalScore;
            if(raw!==null && (typeof raw!=='number'||!Number.isFinite(raw)||raw<0||raw>100||Math.abs(raw*100-Math.round(raw*100))>1e-8))fail(400,'Итоговый балл: от 0 до 100, не более двух знаков после запятой');
            if(raw!==null&&!finished)fail(409,'Итоговый балл выставляется после окончания занятия');
            if(typeof row.note!=='string'||row.note.length>2000)fail(400,'Комментарий: не более 2000 символов');
            await c.query(`INSERT INTO lesson_marks(lesson_id,student_id,attendance,final_score,note,updated_by) VALUES($1,$2,$3,$4,$5,$6)
              ON CONFLICT(lesson_id,student_id) DO UPDATE SET attendance=$3,final_score=$4,note=$5,updated_by=$6,updated_at=NOW()`,[lesson.id,row.studentId,row.attendance,raw,row.note,session.accountId]);
          }
          const changed=(await c.query(`INSERT INTO lesson_journals(lesson_id) VALUES($1)
            ON CONFLICT(lesson_id) DO UPDATE SET version=lesson_journals.version+1,updated_at=NOW() RETURNING version`,[lesson.id])).rows[0];
          return {ok:true,version:changed.version};
        }
        if(req.method==='POST'&&lessonMatch[2]==='complete') {
          if(session.role!=='teacher')fail(403,'Только преподаватель может завершить занятие');
          if(lesson.status==='Отменено')fail(409,'Занятие отменено');
          const open=(await c.query("SELECT id FROM lesson_tests WHERE lesson_id=$1 AND state='open' LIMIT 1",[lesson.id])).rows[0];
          if(open)fail(409,'Сначала завершите открытые тесты в разделе «План и тестирование»');
          await c.query("UPDATE lessons SET status='Проведено' WHERE id=$1",[lesson.id]);return {ok:true};
        }
        if(req.method!=='GET'||lessonMatch[2])fail(405,'Метод не поддерживается');
        const tests=(await c.query("SELECT * FROM lesson_tests WHERE lesson_id=$1 AND state<>'draft'",[lesson.id])).rows;
        const attempts=(await c.query('SELECT p.* FROM test_attempts p JOIN lesson_tests t ON t.id=p.test_id WHERE t.lesson_id=$1',[lesson.id])).rows;
        return {lesson:{id:lesson.id,title:lesson.title,courseId:lesson.course_id,courseName:lesson.course_name,groupName:lesson.group_name,status:lesson.status,endsAt:lesson.ends_at},
          canEdit:session.role==='teacher'&&lesson.status!=='Отменено',canGrade:lesson.status!=='Отменено'&&(lesson.status==='Проведено'||new Date(lesson.ends_at)<=new Date()),version:header?.version||0,
          rows:roster.map(s=>{
            let points=0,pending=0,completed=0,running=0;
            for(const a of attempts.filter(a=>String(a.student_id)===String(s.id))) {
              if(!a.finished_at&&new Date(a.expires_at)<=new Date())a.finished_at=a.expires_at;
              const r=testResult(a,tests.find(t=>String(t.id)===String(a.test_id)).questions);
              if(r){points+=r.score;pending+=r.pending;completed++;}else running++;
            }
            return {studentId:s.id,name:s.name,attendance:s.attendance||'unmarked',finalScore:s.final_score===null?null:Number(s.final_score),note:s.note||'',
              tests:{points:completed?points:null,max:tests.reduce((v,t)=>v+t.questions.length,0),completed,total:tests.length,running,pending}};
          })};
      }
      if(!ratingMatch||req.method!=='GET')fail(405,'Метод не поддерживается');
      const course=(await c.query('SELECT * FROM courses WHERE id=$1',[ratingMatch[1]])).rows[0];if(!course)fail(404,'Дисциплина не найдена');
      const assigned=(await c.query('SELECT id FROM lessons WHERE course_id=$1 AND teacher_id=$2 LIMIT 1',[course.id,session.accountId])).rowCount;
      if(session.role==='teacher'&&Number(course.teacher_id)!==session.accountId&&!assigned)fail(403,'Нет доступа к этой дисциплине');
      if(!['teacher','student','admin'].includes(session.role))fail(403,'Нет доступа');
      // Union current enrollment with recorded marks: transfers do not erase previous results.
      const rows=(await c.query(`WITH eligible AS (
        SELECT p.account_id AS id FROM student_profiles p WHERE p.group_id IN (SELECT group_id FROM lessons WHERE course_id=$1)
        UNION SELECT m.student_id FROM lesson_marks m JOIN lessons l ON l.id=m.lesson_id WHERE l.course_id=$1),
      totals AS (SELECT a.id,a.name,COUNT(m.final_score)::int AS graded,
        COALESCE(SUM(m.final_score),0)::numeric AS total,
        COUNT(*) FILTER(WHERE m.attendance IN ('present','late'))::int AS attended,
        COUNT(*) FILTER(WHERE m.attendance='absent')::int AS absent,
        COUNT(*) FILTER(WHERE m.attendance='excused')::int AS excused
        FROM eligible e JOIN accounts a ON a.id=e.id LEFT JOIN lesson_marks m ON m.student_id=a.id
          AND m.lesson_id IN (SELECT id FROM lessons WHERE course_id=$1 AND status<>'Отменено' AND (status='Проведено' OR ends_at<=NOW()))
        GROUP BY a.id,a.name)
      SELECT *,CASE WHEN graded>0 THEN DENSE_RANK() OVER(ORDER BY (graded>0) DESC,total DESC) ELSE NULL END AS rank FROM totals
      ORDER BY (graded>0) DESC,total DESC,name,id`,[course.id])).rows;
      if(session.role==='student'&&!rows.some(r=>Number(r.id)===session.accountId))fail(403,'Дисциплина недоступна');
      const selected=session.role==='student'?rows.filter(r=>Number(r.id)===session.accountId):rows;
      const detail=(await c.query(`SELECT l.id,l.teacher_id,l.title,l.starts_at,l.status,m.attendance,m.final_score,m.note FROM lessons l
        LEFT JOIN lesson_marks m ON m.lesson_id=l.id AND m.student_id=$2
        WHERE l.course_id=$1 AND ($3<>'student' OR m.student_id IS NOT NULL OR l.group_id=(SELECT group_id FROM student_profiles WHERE account_id=$2)) ORDER BY l.starts_at,l.id`,[course.id,session.accountId,session.role])).rows;
      return {course:{id:course.id,name:course.name,code:course.code},role:session.role,totalStudents:rows.length,
        rows:selected.map(r=>({studentId:r.id,name:r.name,total:Number(r.total),graded:r.graded,rank:r.rank===null?null:Number(r.rank),attended:r.attended,absent:r.absent,excused:r.excused})),
        lessons:detail.map(l=>({id:l.id,canViewJournal:session.role==='admin'||Number(l.teacher_id)===session.accountId,title:l.title,startsAt:l.starts_at,status:l.status,attendance:l.attendance||'unmarked',finalScore:l.final_score===null?null:Number(l.final_score),note:session.role==='student'?l.note:null}))};
    });sendJson(res,200,output);return true;
  };
}
module.exports={init,create};
