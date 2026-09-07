const test=require('node:test');
const assert=require('node:assert/strict');
const {Pool}=require('pg');
test('journal and discipline ranking',{skip:!process.env.TEST_BASE_URL||!process.env.TEST_DATABASE_URL},async t=>{
  assert.match(new URL(process.env.TEST_DATABASE_URL).pathname,/_test$/);
  const pool=new Pool({connectionString:process.env.TEST_DATABASE_URL}),base=process.env.TEST_BASE_URL;
  async function call(path,method='GET',body,cookie=''){const r=await fetch(base+path,{method,headers:{'Content-Type':'application/json',Cookie:cookie},...(body!==undefined?{body:JSON.stringify(body)}:{})});return {status:r.status,data:await r.json(),cookie:r.headers.get('set-cookie')?.split(';')[0]};}
  const login=async(email,password)=>(await call('/api/login','POST',{email,password})).cookie;
  const teacher=await login('anna.krylova@edulink.local','TeacherDemo123!'),other=await login('maria.volkova@edulink.local','TeacherDemo123!'),student=await login('elena.smirnova@edulink.local','StudentDemo123!'),admin=await login('admin@edulink.local','ChangeMe123!');
  const api=(path,method,body)=>call(path,method,body,teacher);
  const J=id=>'/api/journal/lessons/'+id;
  let courseId;
  try{
    await pool.query("UPDATE student_profiles SET group_id=1 WHERE account_id=5");
    courseId=(await pool.query("INSERT INTO courses(code,name,teacher_id,status) VALUES('JOURNAL-TEST','Journal test',1,'Активна') RETURNING id")).rows[0].id;
    async function lesson(title,start,status='Проведено') {return (await pool.query(`INSERT INTO lessons(course_id,teacher_id,group_id,title,starts_at,ends_at,status,video_room_id)
      VALUES($1,1,1,$2,$3,$3::timestamptz+interval '1 hour',$4,$5) RETURNING id`,[courseId,title,start,status,'journal-'+title])).rows[0].id;}
    const first=await lesson('first','2020-01-01T10:00:00Z'),second=await lesson('second','2020-01-02T10:00:00Z'),future=await lesson('future','2099-01-01T10:00:00Z','Запланировано');
    const rows=scores=>[3,5].map((studentId,i)=>({studentId,attendance:i===0?'present':'absent',finalScore:scores[i],note:i===0?'Хорошая работа':''}));
    await t.test('only assigned teacher can edit; journal distinguishes missing from zero',async()=>{
      assert.equal((await call(J(first),'GET',undefined,other)).status,403);
      assert.equal((await call(J(first),'GET',undefined,student)).status,403);
      const journal=await api(J(first));assert.equal(journal.data.rows.length,2);assert(journal.data.rows.every(r=>r.finalScore===null));
      assert.equal((await call(J(first),'PUT',{version:0,rows:rows([0,null])},admin)).status,403);
      assert.equal((await api(J(first),'PUT',{version:0,rows:rows([0,null])})).status,200);
      const read=(await api(J(first))).data;assert.equal(read.rows.find(s=>String(s.studentId)==='3').finalScore,0);assert.equal(read.rows.find(s=>String(s.studentId)==='5').finalScore,null);
    });
    await t.test('score boundaries, roster, version and end-of-lesson guards',async()=>{
      assert.equal((await api(J(first),'PUT',{version:0,rows:rows([10,20])})).status,409);
      for(const score of [-1,101,1.234,'10'])assert.equal((await api(J(first),'PUT',{version:1,rows:rows([score,0])})).status,400);
      assert.equal((await api(J(first),'PUT',{version:1,rows:[rows([10,20])[0]]})).status,400);
      assert.equal((await api(J(future),'PUT',{version:0,rows:rows([10,null])})).status,409);
      assert.equal((await api(J(future),'PUT',{version:0,rows:rows([null,null])})).status,200);
    });
    await t.test('automatic test totals reflect manual free-answer grading without entering final mark',async()=>{
      const questions=[{id:'1',type:'single',prompt:'Q',options:['A','B'],correct:[0]},{id:'2',type:'text',prompt:'Explain',options:[],correct:[]}];
      const testId=(await pool.query("INSERT INTO lesson_tests(lesson_id,title,duration_minutes,questions,state) VALUES($1,'Result',5,$2,'closed') RETURNING id",[first,JSON.stringify(questions)])).rows[0].id;
      const attemptId=(await pool.query(`INSERT INTO test_attempts(test_id,student_id,expires_at,finished_at,finish_reason,answers) VALUES($1,3,NOW(),NOW(),'submitted',$2) RETURNING id`,[testId,JSON.stringify({'1':[0],'2':'Text'})])).rows[0].id;
      let s=(await api(J(first))).data.rows.find(s=>String(s.studentId)==='3');assert.deepEqual(s.tests,{points:1,max:2,completed:1,total:1,running:0,pending:1});assert.equal(s.finalScore,0);
      assert.equal((await api('/api/learning/tests/'+testId+'/grade','PUT',{attemptId,grades:{'2':1}})).status,200);
      s=(await api(J(first))).data.rows.find(s=>String(s.studentId)==='3');assert.equal(s.tests.points,2);assert.equal(s.tests.pending,0);assert.equal(s.finalScore,0);
    });
    await t.test('sums final marks exactly once, ties, corrections and student privacy',async()=>{
      await api(J(first),'PUT',{version:1,rows:rows([75.5,80])});await api(J(second),'PUT',{version:0,rows:rows([14.5,10])});
      let rating=(await api('/api/journal/courses/'+courseId)).data;assert.deepEqual(rating.rows.map(r=>r.total),[90,90]);assert(rating.rows.every(r=>r.rank===1));
      const own=(await call('/api/journal/courses/'+courseId,'GET',undefined,student)).data;assert.equal(own.rows.length,1);assert.equal(String(own.rows[0].studentId),'3');assert.equal(own.lessons.find(l=>String(l.id)===String(first)).finalScore,75.5);
      await api(J(second),'PUT',{version:1,rows:rows([20,10])});rating=(await api('/api/journal/courses/'+courseId)).data;
      assert.equal(rating.rows[0].total,95.5);assert.equal(rating.rows[0].rank,1);assert.equal(rating.rows[1].rank,2);
    });
    await t.test('cancelled lessons excluded; history protected; missing scores unranked',async()=>{
      await pool.query("UPDATE lessons SET status='Отменено' WHERE id=$1",[second]);
      const rating=(await api('/api/journal/courses/'+courseId)).data;assert.equal(rating.rows.find(r=>String(r.studentId)==='3').total,75.5);
      assert.equal((await api(J(second),'PUT',{version:2,rows:rows([10,10])})).status,409);
      assert.equal((await call('/api/admin/lessons/'+future,'DELETE',undefined,admin)).status,409);
      assert.equal((await call('/api/users/5','DELETE',undefined,admin)).status,409);
      await api(J(first),'PUT',{version:2,rows:rows([null,0])});const updated=(await api('/api/journal/courses/'+courseId)).data;
      assert.equal(updated.rows.find(r=>String(r.studentId)==='3').rank,null);assert.equal(updated.rows.find(r=>String(r.studentId)==='5').rank,1);
    });
  }finally{
    await pool.query('UPDATE student_profiles SET group_id=NULL WHERE account_id=5');
    await pool.end();
  }
});
