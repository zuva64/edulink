const test = require('node:test');
const assert = require('node:assert/strict');
const { Pool } = require('pg');
const base = process.env.TEST_BASE_URL;
test('lesson plans and assessment lifecycle on isolated PostgreSQL', { skip: !base || !process.env.TEST_DATABASE_URL }, async t => {
  const pool = new Pool({ connectionString: process.env.TEST_DATABASE_URL });
  assert.match(new URL(process.env.TEST_DATABASE_URL).pathname, /_test$/,'Use a disposable test database');
  async function call(path,method='GET',body,cookie='') {
    const r=await fetch(base+path,{method,headers:{'Content-Type':'application/json',Cookie:cookie},...(body!==undefined?{body:JSON.stringify(body)}:{})});
    return {status:r.status,data:await r.json(),cookie:r.headers.get('set-cookie')?.split(';')[0]};
  }
  const login=async(email,password)=>(await call('/api/login','POST',{email,password})).cookie;
  const teacher=await login('anna.krylova@edulink.local','TeacherDemo123!'), other=await login('maria.volkova@edulink.local','TeacherDemo123!');
  const student=await login('elena.smirnova@edulink.local','StudentDemo123!');
  const admin=await login('admin@edulink.local','ChangeMe123!');
  const api=(path,method,body)=>call(path,method,body,teacher);
  const stu=(path,method,body)=>call(path,method,body,student);
  const L='/api/learning/lessons/1', T=id=>'/api/learning/tests/'+id;
  const fixture={title:'Три типа ответа',durationMinutes:10,questionCount:3,questions:[
    {type:'single',prompt:'2 + 2?',options:['4','5'],correct:[0]},
    {type:'multiple',prompt:'Чётные числа?',options:['2','3','4'],correct:[0,2]},
    {type:'text',prompt:'Объясните решение',options:[],correct:[]}
  ]};
  try {
    await t.test('ownership and plan version conflict',async()=>{
      assert.equal((await call(L,'GET',undefined,other)).status,403);
      assert.equal((await stu(L+'/plan','PUT',{objective:'x',steps:[],version:0})).status,403);
      assert.equal((await api(L+'/plan','PUT',{objective:'Цель',steps:[{title:'Введение',description:'Тема',minutes:10}],version:0})).status,200);
      assert.equal((await api(L+'/plan','PUT',{objective:'stale',steps:[],version:0})).status,409);
    });
    await t.test('question validation',async()=>{
      assert.equal((await api(L+'/tests','POST',{...fixture,questionCount:4})).status,400);
      const bad=structuredClone(fixture);bad.questions[0].correct=[0,1];assert.equal((await api(L+'/tests','POST',bad)).status,400);
      bad.questions[0].correct=[9];assert.equal((await api(L+'/tests','POST',bad)).status,400);
    });
    const created=await api(L+'/tests','POST',fixture);assert.equal(created.status,200);const id=created.data.id;
    await t.test('plan includes test; student receives no answer key',async()=>{
      assert.equal((await api(L+'/plan','PUT',{objective:'Проверка',steps:[{title:'Тестирование',description:'Ответьте',minutes:10,testId:id}],version:1})).status,200);
      const overview=await stu(L);assert(overview.data.plan.steps[0].testId);
      assert(!('questions' in overview.data.tests[0]));
      assert.equal((await stu(T(id)+'/start','POST',{})).status,409);
      assert.equal((await call(T(id)+'/open','POST',{},other)).status,403);
      assert.equal((await stu(T(id)+'/open','POST',{})).status,403);
    });
    await t.test('open freezes questions; concurrent starts create one timed attempt',async()=>{
      assert.equal((await api(T(id)+'/open','POST',{})).status,200);
      assert.equal((await api(T(id),'PUT',{...fixture,version:2})).status,409);
      const starts=await Promise.all([stu(T(id)+'/start','POST',{}),stu(T(id)+'/start','POST',{})]);
      assert.equal(starts[0].data.attempt.id,starts[1].data.attempt.id);
      assert.equal(starts[0].data.attempt.expiresAt,starts[1].data.attempt.expiresAt);
      assert(!JSON.stringify(starts[0].data).includes('correct'));
      assert.equal((await stu(T(id)+'/monitor')).status,403);
    });
    await t.test('save, resume, submit, automatic score and manual grading',async()=>{
      const answers={'1':[0],'2':[0,2],'3':'Пояснение студента'};
      const saved=await stu(T(id)+'/answers','PUT',{answers});assert.equal(saved.status,200);
      assert.deepEqual((await stu(T(id)+'/attempt')).data.attempt.answers,answers);
      const submitted=await stu(T(id)+'/submit','PUT',{answers});assert.equal(submitted.data.attempt.finishReason,'submitted');
      assert.deepEqual(submitted.data.attempt.result,{score:2,total:3,pending:1});
      const late=await stu(T(id)+'/answers','PUT',{answers:{'1':[1]}});assert.deepEqual(late.data.attempt.answers,answers);
      const attemptId=submitted.data.attempt.id;
      assert.equal((await stu(T(id)+'/grade','PUT',{attemptId,grades:{'3':1}})).status,403);
      assert.equal((await api(T(id)+'/grade','PUT',{attemptId,grades:{'1':1}})).status,400);
      assert.equal((await api(T(id)+'/grade','PUT',{attemptId,grades:{'3':1}})).status,200);
      assert.deepEqual((await stu(T(id)+'/attempt')).data.attempt.result,{score:3,total:3,pending:0});
    });
    await t.test('timeout rejects late changes and keeps saved answers',async()=>{
      const id2=(await api(L+'/tests','POST',fixture)).data.id;
      await api(T(id2)+'/open','POST',{});await stu(T(id2)+'/start','POST',{});
      await stu(T(id2)+'/answers','PUT',{answers:{'1':[0]}});
      await pool.query("UPDATE test_attempts SET expires_at=clock_timestamp()-interval '1 second' WHERE test_id=$1",[id2]);
      const late=await stu(T(id2)+'/submit','PUT',{answers:{'1':[1],'3':'too late'}});
      assert.equal(late.data.attempt.finishReason,'timeout');assert.deepEqual(late.data.attempt.answers,{'1':[0]});
      assert.equal(late.data.attempt.finishedAt,late.data.attempt.expiresAt);
    });
    await t.test('background worker finishes an attempt without student requests',async()=>{
      const id4=(await api(L+'/tests','POST',fixture)).data.id;
      await api(T(id4)+'/open','POST',{});await stu(T(id4)+'/start','POST',{});
      await pool.query("UPDATE test_attempts SET expires_at=clock_timestamp()-interval '1 second' WHERE test_id=$1",[id4]);
      let row;
      for(let i=0;i<20;i++) {
        row=(await pool.query('SELECT finished_at,expires_at,finish_reason FROM test_attempts WHERE test_id=$1',[id4])).rows[0];
        if(row.finished_at)break;
        await new Promise(resolve=>setTimeout(resolve,200));
      }
      assert.equal(row.finish_reason,'timeout');assert.equal(+row.finished_at,+row.expires_at);
    });
    await t.test('teacher closes active attempts and prevents new starts; wrong group denied',async()=>{
      const id3=(await api(L+'/tests','POST',fixture)).data.id;
      await api(T(id3)+'/open','POST',{});await stu(T(id3)+'/start','POST',{});
      await stu(T(id3)+'/answers','PUT',{answers:{'2':[0]}});
      await api(T(id3)+'/close','POST',{});
      const closed=await stu(T(id3)+'/attempt');assert.equal(closed.data.attempt.finishReason,'teacher');assert.equal(closed.data.attempt.result.score,0);
      await pool.query("UPDATE accounts SET status='Активен' WHERE id=5");
      const outsider=await login('ilya.petrov@edulink.local','StudentDemo123!');
      assert.equal((await call(T(id3)+'/start','POST',{},outsider)).status,403);
      await pool.query('UPDATE student_profiles SET group_id=1 WHERE account_id=5');
      assert.equal((await call(T(id3)+'/start','POST',{},outsider)).status,409);
      const monitor=(await api(T(id3)+'/monitor')).data;assert(monitor.students.some(s=>!s.attempt));
      assert.equal((await call('/api/admin/lessons/1','DELETE',undefined,admin)).status,409);
    });
  }finally{await pool.end();}
});
