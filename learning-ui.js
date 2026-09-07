(() => {
  const lessonId = new URLSearchParams(location.search).get('lesson');
  const content = document.querySelector('#content'), notice = document.querySelector('#notice'), editor = document.querySelector('#editor');
  const esc = v => String(v ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const fmt = v => v ? new Date(v).toLocaleString('ru-RU') : '—';
  const stateName = { draft: 'Черновик', open: 'Открыт', closed: 'Завершён' };
  const reasons = { submitted: 'Сдан студентом', timeout: 'Время истекло', teacher: 'Завершён преподавателем' };
  const typeNames = {single:'Один ответ',multiple:'Несколько ответов',text:'Свободный ответ'};
  let data, mode = 'overview', poll, clock, saveTimer, activeAttempt = false;
  const lessonUrl = `/api/learning/lessons/${lessonId}`;
  async function api(url, method = 'GET', body) {
    const r = await fetch(url, {method, ...(body !== undefined ? {headers:{'Content-Type':'application/json'},body:JSON.stringify(body)} : {})});
    const d = await r.json(); if (!r.ok) throw new Error(d.error || `Ошибка ${r.status}`); return d;
  }
  const testUrl = (id, action='') => `/api/learning/tests/${id}${action ? '/'+action : ''}`;
  function error(e) { notice.textContent = e.message; }
  function stop() { clearInterval(poll); clearInterval(clock); clearTimeout(saveTimer); activeAttempt = false; }
  function score(r) { return r ? `${r.score} / ${r.total}${r.pending ? ` · ждут проверки: ${r.pending}` : ''}` : '—'; }
  function button(label, action, id, cls='') { return `<button class="${cls}" data-action="${action}" data-id="${id}">${label}</button>`; }
  async function overview() {
    stop(); mode='overview'; notice.textContent=''; data = await api(lessonUrl);
    document.querySelector('#lessonTitle').textContent = data.lesson.title;
    document.querySelector('#back').href = data.role === 'teacher' ? '/teacher.html' : '/student.html';
    const teacher = data.role === 'teacher';
    const attempts = teacher ? [] : await Promise.all(data.tests.map(t => api(testUrl(t.id,'attempt'))));
    content.innerHTML = `<section class="card"><div class="card-head"><h2>План занятия</h2>${teacher ? '<div class="actions"><a class="button" href="/journal.html?lesson='+lessonId+'">Журнал занятия</a>'+button('Редактировать план','plan','')+'</div>' : ''}</div>
      <p>${esc(data.plan.objective || 'Цель занятия пока не указана.')}</p>
      <ol class="steps">${data.plan.steps.map(s => `<li><strong>${esc(s.title)}</strong> <span class="muted">${s.minutes} мин.</span><p>${esc(s.description)}</p>${s.testId ? `<a href="#test-${s.testId}" class="badge">Тест: ${esc(data.tests.find(t => String(t.id) === String(s.testId))?.title || 'Тест')}</a>` : ''}</li>`).join('')}</ol>
      ${!data.plan.steps.length ? '<p class="muted">Этапы пока не добавлены.</p>' : ''}</section>
      <div class="card-head"><h2>Тестирование</h2><div class="actions">${teacher ? button('＋ Создать тест','create','', 'primary') : ''}${button('Обновить','refresh','')}</div></div>
      <p class="muted">${teacher ? 'Задания редактируются до открытия теста. Каждому студенту доступна одна попытка. Свободные ответы проверяются вручную.' : 'Начать можно после открытия теста преподавателем. Таймер начинается при нажатии «Начать тест» и не останавливается при закрытии страницы.'}</p>
      ${data.tests.map((t,i) => {const a=attempts[i]?.attempt;return `<article class="card test-card" id="test-${t.id}"><div class="card-head"><div><h3>${esc(t.title)}</h3><span class="badge ${t.state==='closed'?'closed':''}">${stateName[t.state]}</span> <span class="muted">${t.questionCount} заданий · ${t.durationMinutes} мин.</span></div><div class="actions">${teacher ? (t.state==='draft' ? button('Редактировать','edit',t.id)+button('Открыть тест','open',t.id,'primary')+button('Удалить','delete',t.id,'danger') : button('Ход выполнения','monitor',t.id)+(t.state==='open'?button('Завершить всем','close',t.id,'danger'):'')) : a ? button(a.finishedAt?'Посмотреть результат':'Продолжить','attempt',t.id,'primary') : (t.state==='open' && data.lesson.status==='Запланировано' ? button('Начать тест','start',t.id,'primary') : '<span class="muted">Начало недоступно</span>')}</div></div>${a ? `<p class="muted">Начало: ${fmt(a.startedAt)} · ${a.finishedAt ? reasons[a.finishReason]+' · '+score(a.result) : 'Выполняется до '+fmt(a.expiresAt)}</p>` : ''}</article>`;}).join('') || '<section class="card muted">Тесты пока не созданы.</section>'}`;
    content.onclick = async e => {
      const b=e.target.closest('[data-action]'); if(!b)return; b.disabled=true;
      try {
        const id=b.dataset.id, action=b.dataset.action;
        if(action==='plan')return editPlan();
        if(action==='create'||action==='edit')return editTest(data.tests.find(t=>String(t.id)===id));
        if(action==='monitor')return await monitor(id);
        if(action==='attempt'||action==='start')return await take(id,action==='start');
        if(action==='open'||action==='close') {
          if(!confirm(action==='open'?'Открыть тест студентам? После открытия задания нельзя будет изменить.':'Завершить тест? Все начатые попытки будут закрыты с сохранёнными ответами.'))return;
          await api(testUrl(id,action),'POST',{});
        }
        if(action==='delete') {if(!confirm('Удалить черновик теста?'))return;await api(testUrl(id),'DELETE');}
        await overview();
      }catch(e){error(e);}finally{b.disabled=false;}
    };
  }
  function shell(title, inner) {
    editor.innerHTML=`<form><h2 id="editorTitle">${title}</h2>${inner}<p class="inline-error" role="alert"></p><footer><button type="button" data-dismiss>Закрыть</button><button class="primary" type="submit">Сохранить</button></footer></form>`;
    editor.querySelector('[data-dismiss]').onclick=()=>editor.close(); if(!editor.open)editor.showModal();
  }
  function editPlan() {
    let steps=structuredClone(data.plan.steps), objective=data.plan.objective;
    const read = () => {objective=editor.querySelector('[name=objective]').value;steps=[...editor.querySelectorAll('.editor-step')].map(el=>({title:el.querySelector('[name=title]').value,description:el.querySelector('[name=description]').value,minutes:Number(el.querySelector('[name=minutes]').value),testId:el.querySelector('[name=testId]').value||null}));};
    function render() {
      shell('План занятия', `<label>Цель занятия<textarea name="objective" maxlength="5000">${esc(objective)}</textarea></label><div id="steps">${steps.map((s,i)=>`<section class="editor-step"><div class="row"><h3>Этап ${i+1}</h3><div class="actions"><button type="button" data-move="${i}" data-dir="-1" ${i===0?'disabled':''}>↑</button><button type="button" data-move="${i}" data-dir="1" ${i===steps.length-1?'disabled':''}>↓</button><button type="button" data-remove="${i}">Убрать</button></div></div><label>Название этапа<input name="title" required maxlength="200" value="${esc(s.title)}"></label><label>Описание<textarea name="description" maxlength="5000">${esc(s.description)}</textarea></label><div class="grid"><label>Длительность, мин.<input name="minutes" type="number" min="0" max="480" required value="${s.minutes}"></label><label>Тест этапа<select name="testId"><option value="">Без теста</option>${data.tests.map(t=>`<option value="${t.id}" ${String(s.testId)===String(t.id)?'selected':''}>${esc(t.title)}</option>`).join('')}</select></label></div></section>`).join('')}</div><button type="button" id="addStep">＋ Добавить этап</button>`);
      editor.querySelector('#addStep').onclick=()=>{read();if(steps.length>=50)return;steps.push({title:'',description:'',minutes:10,testId:null});render();};
      editor.querySelectorAll('[data-remove]').forEach(b=>b.onclick=()=>{read();steps.splice(Number(b.dataset.remove),1);render();});
      editor.querySelectorAll('[data-move]').forEach(b=>b.onclick=()=>{read();const i=Number(b.dataset.move),j=i+Number(b.dataset.dir);[steps[i],steps[j]]=[steps[j],steps[i]];render();});
      editor.querySelector('form').onsubmit=async e=>{e.preventDefault();read();const b=e.submitter;b.disabled=true;try{await api(lessonUrl+'/plan','PUT',{objective,steps,version:data.plan.version});editor.close();await overview();}catch(e){editor.querySelector('.inline-error').textContent=e.message;}finally{b.disabled=false;}};
    }render();
  }
  function editTest(test) {
    let title=test?.title||'', duration=test?.durationMinutes||15;
    let questions=structuredClone(test?.questions||[{type:'single',prompt:'',options:['',''],correct:[]}]);
    function read() {
      title=editor.querySelector('[name=testTitle]').value;duration=Number(editor.querySelector('[name=duration]').value);
      questions=[...editor.querySelectorAll('.question')].map(el=>({type:el.querySelector('[name=type]').value,prompt:el.querySelector('[name=prompt]').value,options:[...el.querySelectorAll('[name=option]')].map(x=>x.value),correct:[...el.querySelectorAll('[name=correct]')].flatMap((x,i)=>x.checked?[i]:[])}));
    }
    function render() {
      shell(test?'Редактировать тест':'Новый тест', `<label>Название теста<input name="testTitle" required maxlength="200" value="${esc(title)}"></label><div class="grid"><label>Время на попытку, мин.<input name="duration" type="number" min="1" max="240" required value="${duration}"></label><label>Количество заданий<input id="questionCount" type="number" min="1" max="50" value="${questions.length}"></label></div><button type="button" id="resizeQuestions">Применить количество</button><p class="muted">Каждое задание — 1 балл. Отметьте правильные варианты. Для множественного выбора требуется точное совпадение всех выбранных ответов.</p>
        ${questions.map((q,i)=>`<fieldset class="question"><legend>Задание ${i+1}</legend><label>Тип ответа<select name="type">${Object.entries(typeNames).map(([key,label])=>`<option value="${key}" ${q.type===key?'selected':''}>${label}</option>`).join('')}</select></label><label>Вопрос<textarea name="prompt" required maxlength="2000">${esc(q.prompt)}</textarea></label>${q.type==='text'?'<p class="muted">Студент введёт текст. Оценка преподавателя: 0 или 1 балл.</p>':q.options.map((o,j)=>`<label class="option-edit"><input name="correct" type="${q.type==='single'?'radio':'checkbox'}" ${q.correct.includes(j)?'checked':''} aria-label="Правильный вариант ${j+1} задания ${i+1}"><input name="option" type="text" maxlength="500" required value="${esc(o)}" aria-label="Вариант ${j+1} задания ${i+1}"><button type="button" data-option-remove="${i}:${j}" ${q.options.length<=2?'disabled':''}>×</button></label>`).join('')+`<button type="button" data-option-add="${i}" ${q.options.length>=10?'disabled':''}>＋ Вариант ответа</button>`}</fieldset>`).join('')}`);
      // Each single-choice question has an independent radio group.
      editor.querySelectorAll('.question').forEach((el,i)=>{
        el.querySelectorAll('input[type=radio]').forEach(r=>r.name='correct-'+i);
        el.querySelector('[name=type]').onchange=()=>{read();if(questions[i].type!=='text'&&questions[i].options.length<2)questions[i].options=['',''];questions[i].correct=[];render();};
      });
      // Read radio groups together with the multi-choice checkboxes.
      editor.querySelector('#resizeQuestions').onclick=()=>{const count=Number(editor.querySelector('#questionCount').value);if(!Number.isInteger(count)||count<1||count>50)return;read();if(count<questions.length&&!confirm('Убрать последние задания из черновика?'))return;questions=questions.slice(0,count);while(questions.length<count)questions.push({type:'single',prompt:'',options:['',''],correct:[]});render();};
      editor.querySelectorAll('[data-option-add]').forEach(b=>b.onclick=()=>{read();questions[Number(b.dataset.optionAdd)].options.push('');render();});
      editor.querySelectorAll('[data-option-remove]').forEach(b=>b.onclick=()=>{read();const [i,j]=b.dataset.optionRemove.split(':').map(Number);questions[i].options.splice(j,1);questions[i].correct=questions[i].correct.filter(v=>v!==j).map(v=>v>j?v-1:v);render();});
      editor.querySelector('form').onsubmit=async e=>{e.preventDefault();read();const b=e.submitter;b.disabled=true;try{await api(test?testUrl(test.id):lessonUrl+'/tests',test?'PUT':'POST',{title,durationMinutes:duration,questionCount:questions.length,questions,version:test?.version});editor.close();await overview();}catch(e){editor.querySelector('.inline-error').textContent=e.message;}finally{b.disabled=false;}};
    }
    // The prefix includes uniquely named single-choice radio groups.
    const originalRead=read;
    read=function(){originalRead();[...editor.querySelectorAll('.question')].forEach((el,i)=>questions[i].correct=[...el.querySelectorAll('input[name^=correct]')].flatMap((x,j)=>x.checked?[j]:[]));};
    render();
  }
  async function monitor(id) {
    stop();mode='monitor';notice.textContent='';
    async function update() {
      const report=await api(testUrl(id,'monitor'));if(mode!=='monitor')return;
      content.innerHTML=`<div class="card-head"><h2>Ход выполнения теста</h2><div class="actions">${button('К плану','overview','')}${report.state==='open'?button('Завершить всем','close',id,'danger'):''}</div></div><p class="muted">Обновление каждые 3 секунды. Окончание по таймеру фиксируется сервером.</p><section class="card table-wrap"><table><thead><tr><th>Студент</th><th>Состояние</th><th>Начало</th><th>Окончание / срок</th><th>Баллы</th><th></th></tr></thead><tbody>${report.students.map(s=>`<tr><td>${esc(s.name)}</td><td>${s.attempt?(s.attempt.finishedAt?reasons[s.attempt.finishReason]:'Выполняет'):'Не начал'}</td><td>${fmt(s.attempt?.startedAt)}</td><td>${fmt(s.attempt?.finishedAt||s.attempt?.expiresAt)}</td><td>${score(s.attempt?.result)}</td><td>${s.attempt?.finishedAt?button('Ответы и оценка','grade',s.studentId):''}</td></tr>`).join('')}</tbody></table>${!report.students.length?'<p>В группе пока нет студентов.</p>':''}</section>`;
      content.onclick=async e=>{const b=e.target.closest('[data-action]');if(!b)return;try{if(b.dataset.action==='overview')return await overview();if(b.dataset.action==='close'){if(!confirm('Завершить все начатые попытки?'))return;await api(testUrl(id,'close'),'POST',{});return update();}if(b.dataset.action==='grade')grade(id,report.questions,report.students.find(s=>String(s.studentId)===b.dataset.id));}catch(e){error(e);}};
    }
    await update();poll=setInterval(()=>{if(!editor.open)update().catch(error);},3000);
  }
  function grade(id,questions,student) {
    const a=student.attempt;
    shell('Ответы: '+esc(student.name),questions.map(q=>`<fieldset class="question"><legend>${esc(q.prompt)}</legend><p class="muted">${typeNames[q.type]}</p><pre>${esc(q.type==='text'?a.answers[q.id]||'(Нет ответа)':(a.answers[q.id]||[]).map(i=>q.options[i]).join('\n')||'(Нет ответа)')}</pre>${q.type==='text'?`<label>Оценка<select name="grade-${q.id}" required><option value="">Не проверено</option><option value="0" ${a.grades[q.id]===0?'selected':''}>0 — неверно</option><option value="1" ${a.grades[q.id]===1?'selected':''}>1 — верно</option></select></label>`:`<p class="muted">Верно: ${esc(q.correct.map(i=>q.options[i]).join('; '))}</p>`}</fieldset>`).join(''));
    editor.querySelector('form').onsubmit=async e=>{e.preventDefault();const grades={};editor.querySelectorAll('[name^=grade-]').forEach(el=>{if(el.value!=='')grades[el.name.slice(6)]=Number(el.value);});try{await api(testUrl(id,'grade'),'PUT',{attemptId:a.id,grades});editor.close();await monitor(id);}catch(e){editor.querySelector('.inline-error').textContent=e.message;}};
  }
  async function take(id,start=false) {
    stop();mode='attempt';notice.textContent='';
    const d=await api(testUrl(id,start?'start':'attempt'),start?'POST':'GET',start?{}:undefined);
    if(!d.attempt){await overview();return;}
    const a=d.attempt;
    if(a.finishedAt){showResult(d);return;}
    activeAttempt=true;
    content.innerHTML=`<div class="sticky row"><h2>${esc(d.title)}</h2><div><div id="remaining" class="timer"></div><small id="saveStatus">Ответы сохраняются автоматически</small></div></div><p class="muted">После истечения времени или завершения теста преподавателем принимаются только ответы, сохранённые на сервере. Не закрывайте страницу до подтверждения сохранения.</p><form id="attemptForm">${d.questions.map((q,i)=>`<fieldset class="question card"><legend>${i+1}. ${typeNames[q.type]}</legend><p>${esc(q.prompt)}</p>${q.type==='text'?`<label>Ваш ответ<textarea name="q-${q.id}" maxlength="10000">${esc(a.answers[q.id]||'')}</textarea></label>`:q.options.map((o,j)=>`<label class="choice"><input name="q-${q.id}" type="${q.type==='single'?'radio':'checkbox'}" value="${j}" ${(a.answers[q.id]||[]).includes(j)?'checked':''}><span>${esc(o)}</span></label>`).join('')}</fieldset>`).join('')}<div class="actions"><button class="primary" type="submit">Завершить и сдать тест</button><button type="button" id="saveReturn">Сохранить и вернуться</button></div></form>`;
    content.onclick=null;
    const form=content.querySelector('form'), status=content.querySelector('#saveStatus');let queue=Promise.resolve(), submitting=false;
    function answers(){const out={};for(const q of d.questions)out[q.id]=q.type==='text'?form.elements['q-'+q.id].value:[...form.querySelectorAll(`[name="q-${q.id}"]:checked`)].map(x=>Number(x.value));return out;}
    function save(submit=false){const payload=answers();queue=queue.catch(()=>{}).then(async()=>{if(!activeAttempt)return;status.textContent='Сохранение…';const saved=await api(testUrl(id,submit?'submit':'answers'),'PUT',{answers:payload});if(saved.attempt.finishedAt){showResult(saved);return;}status.textContent='Сохранено в '+new Date().toLocaleTimeString('ru-RU');});return queue;}
    form.oninput=()=>{status.textContent='Есть несохранённые изменения';clearTimeout(saveTimer);saveTimer=setTimeout(()=>save().catch(e=>{status.textContent='Не сохранено. Проверьте соединение';error(e);}),400);};
    form.onsubmit=async e=>{e.preventDefault();if(submitting||!confirm('Сдать тест? Изменить ответы после сдачи нельзя.'))return;submitting=true;clearTimeout(saveTimer);try{await save(true);}catch(e){error(e);}finally{submitting=false;}};
    content.querySelector('#saveReturn').onclick=async()=>{clearTimeout(saveTimer);try{await save();await overview();}catch(e){error(e);}};
    const offset=Date.parse(d.serverNow)-Date.now();
    function tick(){const left=Math.max(0,Math.ceil((Date.parse(a.expiresAt)-Date.now()-offset)/1000));const timer=document.querySelector('#remaining');if(timer)timer.textContent=`Осталось ${Math.floor(left/60)}:${String(left%60).padStart(2,'0')}`;if(!left&&activeAttempt){form.querySelectorAll('input,textarea,button').forEach(el=>el.disabled=true);}}
    tick();clock=setInterval(tick,1000);
    poll=setInterval(async()=>{try{const current=await api(testUrl(id,'attempt'));if(mode==='attempt'&&current.attempt?.finishedAt)showResult(current);}catch(e){error(e);}},2000);
  }
  function showResult(d){stop();mode='result';notice.textContent='';const a=d.attempt;content.innerHTML=`<section class="card"><span class="badge closed">${reasons[a.finishReason]}</span><h2>${esc(d.title)}</h2><p>Начало: ${fmt(a.startedAt)}<br>Окончание: ${fmt(a.finishedAt)}</p><h3>Результат: ${score(a.result)}</h3>${a.result.pending?'<p class="muted">Итог обновится после проверки свободных ответов преподавателем.</p>':''}${button('К плану занятия','overview','')}</section>`;content.onclick=e=>{if(e.target.closest('[data-action="overview"]'))overview().catch(error);};}
  window.addEventListener('beforeunload',e=>{if(activeAttempt){e.preventDefault();e.returnValue='';}});
  if(!/^\d+$/.test(lessonId||'')){notice.textContent='Откройте план из списка занятий';content.textContent='';return;}
  overview().catch(e=>{error(e);content.textContent='Не удалось загрузить занятие. Проверьте вход и доступ к группе.';});
})();
