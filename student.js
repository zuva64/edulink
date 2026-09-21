const esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));const out=document.querySelector('#lessons');function fmt(d){return new Date(d).toLocaleString('ru-RU',{day:'2-digit',month:'short',hour:'2-digit',minute:'2-digit'});}async function load(){const r=await fetch('/api/student/dashboard');if(r.status===403){location.href='/';return;}const d=await r.json();if(!r.ok)throw new Error(d.error || 'Ошибка загрузки');window.dashboardLessons=d.lessons;document.querySelector('#studentName').textContent=d.profile.name;document.querySelector('#studentMeta').textContent=[d.profile.groupName&&`Группа ${d.profile.groupName}`,d.profile.studentNumber&&`№ ${d.profile.studentNumber}`].filter(Boolean).join(' · ');document.querySelector('#studentEmail').textContent=d.profile.email;out.innerHTML=d.lessons.length?d.lessons.map(l=>`<article class="lesson"><div><strong>${esc(l.courseCode)} · ${esc(l.courseName)}</strong><div>${esc(l.title)}</div><div class="meta">${fmt(l.startsAt)} — ${fmt(l.endsAt)} · ${esc(l.teacherName)} · ${esc(l.status)}</div></div><a class="ghost" href="/learning.html?lesson=${l.id}">План и тесты</a><button class="primary" ${l.status !== 'Запланировано' ? 'disabled' : ''} onclick="location.href='/video.html'">Войти в онлайн-занятие</button></article>`).join(''):'<p>Занятий пока нет.</p>';}document.querySelector('#logout').onclick=async()=>{await fetch('/api/logout',{method:'POST'});location.href='/';};load().then(()=>mountScheduleCalendar(window.dashboardLessons || [])).catch(()=>location.href='/');
function mountScheduleCalendar(lessons) {
  if (document.querySelector('#dashboardCalendar')) return;
  const host = document.createElement('section');
  host.id = 'dashboardCalendar';
  host.innerHTML = `<style>
    .dc-tools{display:flex;align-items:center;gap:10px;flex-wrap:wrap;margin:16px 0}.dc-tools input{padding:9px;border:1px solid #ddd;border-radius:8px}.dc-tools button[aria-pressed=true]{background:#174b39;color:white}.dc-scroll{overflow-x:auto}.dc-week{display:grid;grid-template-columns:repeat(7,minmax(140px,1fr));gap:8px;min-width:1040px}.dc-day{background:#f5f7f6;padding:10px;border-radius:10px;min-height:180px}.dc-day h3{font-size:13px}.dc-today{outline:2px solid #28765a;outline-offset:-2px}.dc-event{display:block;background:white;border:1px solid #d5e2db;border-left:4px solid #28765a;padding:10px;margin-bottom:10px;border-radius:8px;overflow-wrap:anywhere}.dc-event span,.dc-event a{display:block;font-size:12px;margin-top:7px}.dc-event a{color:#174b39;text-decoration:underline}.dc-cancelled{border-left-color:#999;opacity:.7}
  </style><div class="dc-tools"><button class="ghost" data-mode="list" aria-pressed="true">Список</button><button class="ghost" data-mode="calendar" aria-pressed="false">Календарь</button></div><div class="dc-navigation" hidden><div class="dc-tools"><button class="ghost" data-offset="-1" aria-label="Предыдущая неделя">←</button><button class="ghost" data-offset="0">Сегодня</button><button class="ghost" data-offset="1" aria-label="Следующая неделя">→</button><label>Перейти к дате <input type="date"></label><strong class="dc-range" aria-live="polite"></strong></div><p class="meta">Время: ${esc(Intl.DateTimeFormat().resolvedOptions().timeZone)}</p><div class="dc-scroll"></div></div>`;
  out.before(host);
  let date = new Date(), mode = 'list';
  const key = d => `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
  const time = d => new Date(d).toLocaleTimeString('ru-RU',{hour:'2-digit',minute:'2-digit'});
  const teacher = Boolean(document.querySelector('#teacherName'));
  function render() {
    out.hidden = mode === 'calendar';
    host.querySelector('.dc-navigation').hidden = mode !== 'calendar';
    host.querySelectorAll('[data-mode]').forEach(b=>b.setAttribute('aria-pressed',String(b.dataset.mode===mode)));
    if(mode !== 'calendar') return;
    const start = new Date(date);start.setHours(0,0,0,0);start.setDate(start.getDate()-(start.getDay()+6)%7);
    const end = new Date(start);end.setDate(end.getDate()+6);
    host.querySelector('input').value=key(date);
    host.querySelector('.dc-range').textContent=`${start.toLocaleDateString('ru-RU')} — ${end.toLocaleDateString('ru-RU')}`;
    host.querySelector('.dc-scroll').innerHTML='<div class="dc-week">'+Array.from({length:7},(_,i)=>{
      const day=new Date(start);day.setDate(day.getDate()+i);const next=new Date(day);next.setDate(next.getDate()+1);
      const events=lessons.filter(l=>new Date(l.startsAt)<next&&new Date(l.endsAt)>day).sort((a,b)=>new Date(a.startsAt)-new Date(b.startsAt));
      return `<section class="dc-day ${key(day)===key(new Date())?'dc-today':''}"><h3>${esc(day.toLocaleDateString('ru-RU',{weekday:'short',day:'numeric',month:'short'}))}</h3>${events.length?events.map(l=>`<article class="dc-event ${l.status==='Отменено'?'dc-cancelled':''}"><strong>${esc(time(l.startsAt))}–${esc(time(l.endsAt))}</strong><span>${esc(l.courseName)}</span><span>${esc(l.title)}</span><span>${esc(teacher?l.groupName:l.teacherName)}</span><span>${esc(l.status)}</span><a href="/learning.html?lesson=${encodeURIComponent(l.id)}">План и тесты</a>${teacher?`<a href="/journal.html?lesson=${encodeURIComponent(l.id)}">Журнал занятия</a>`:''}</article>`).join(''):'<p class="meta">Нет занятий</p>'}</section>`;
    }).join('')+'</div>';
  }
  host.onclick=e=>{const b=e.target.closest('button');if(!b)return;if(b.dataset.mode)mode=b.dataset.mode;if(b.dataset.offset!==undefined){const n=Number(b.dataset.offset);if(n)date.setDate(date.getDate()+7*n);else date=new Date();}render();};
  host.querySelector('input').onchange=e=>{if(e.target.value){date=new Date(e.target.value+'T12:00:00');render();}};
  render();
}
