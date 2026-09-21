(() => {
  const main = document.querySelector('main.main'), nav = document.querySelector('.sidebar nav');
  if (!main || !nav) return;
  const esc = v => String(v ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const statuses = ['Запланировано', 'Проведено', 'Отменено'];
  const fmt = v => new Date(v).toLocaleString('ru-RU', { dateStyle: 'short', timeStyle: 'short' });
  const local = v => { const d = new Date(v); return new Date(d - d.getTimezoneOffset() * 60000).toISOString().slice(0, 16); };
  const view = document.createElement('section');
  const style = document.createElement('style');
  style.textContent = '#lessonFilters{gap:12px}#lessonFilters label{display:flex;flex-direction:column;gap:6px;font-size:12px}#lessonFilters input,#lessonFilters select{min-height:36px;max-width:260px}dialog.catalog-modal::backdrop{background:#173b3066}';
  document.head.appendChild(style);
  view.className = 'page-content admin-view'; view.dataset.view = 'schedule'; view.hidden = true;
  view.innerHTML = `<div class="intro"><div><h2>Расписание занятий</h2><p>Планируйте занятия и управляйте нагрузкой преподавателей и групп.</p></div><button class="primary-button" id="addLesson">＋ Добавить занятие</button></div>
    <section class="catalog-panel"><div class="panel-header"><div><h2>Все занятия</h2><p id="lessonCount" aria-live="polite"></p></div><button class="export-button" id="exportLessons">⇩ Экспорт CSV</button></div>
    <form id="lessonFilters" class="toolbar" style="flex-wrap:wrap;align-items:end">
      <label>Поиск<input name="q" type="search" placeholder="Тема, дисциплина, группа"></label>
      <label>С даты<input name="from" type="date"></label><label>По дату<input name="to" type="date"></label>
      <label>Преподаватель<select name="teacherId"><option value="">Все преподаватели</option></select></label>
      <label>Группа<select name="groupId"><option value="">Все группы</option></select></label>
      <label>Дисциплина<select name="courseId"><option value="">Все дисциплины</option></select></label>
      <label>Статус<select name="status"><option value="">Все статусы</option>${statuses.map(s => `<option>${s}</option>`).join('')}</select></label>
      <button class="filter-button">Показать</button><button type="reset" class="filter-button">Сбросить</button>
    </form><p style="padding:0 20px;color:var(--muted)">Время: ${esc(Intl.DateTimeFormat().resolvedOptions().timeZone)}. Отменённые занятия не занимают время в расписании.</p>
    <p id="scheduleError" role="alert" style="padding:0 20px;color:#a63e39"></p>
    <div class="catalog-table-wrap"><table><thead><tr><th>ДАТА И ВРЕМЯ</th><th>ЗАНЯТИЕ</th><th>ПРЕПОДАВАТЕЛЬ</th><th>ГРУППА</th><th>СТАТУС</th><th>ДЕЙСТВИЯ</th></tr></thead><tbody id="lessonTable"></tbody></table></div>
    <div class="catalog-empty" id="lessonEmpty" hidden>Занятия не найдены. Измените фильтры или создайте новое занятие.</div></section>`;
  main.appendChild(view);
  const calendarStyle = document.createElement('style');
  calendarStyle.textContent = '.schedule-calendar-tools{display:flex;gap:10px;align-items:center;flex-wrap:wrap;padding:16px 20px}.schedule-calendar-tools button,.schedule-calendar-tools input{padding:8px;border:1px solid #d5ddd8;border-radius:8px;background:white}.schedule-calendar-tools button{cursor:pointer}.schedule-calendar-tools button[aria-pressed="true"]{background:#174b39;color:white}.schedule-week{display:grid;grid-template-columns:repeat(7,minmax(145px,1fr));gap:8px;padding:12px;min-width:1080px}.schedule-day{background:#f6f8f7;border-radius:10px;padding:8px;min-height:240px}.schedule-day h3{font-size:13px;margin:4px 0 14px}.schedule-day.today{outline:2px solid #28765a;outline-offset:-2px}.schedule-event{display:block;width:100%;text-align:left;border:1px solid #cddfd5;border-left:4px solid #28765a;background:white;border-radius:8px;padding:10px;margin-bottom:8px;cursor:pointer;overflow-wrap:anywhere}.schedule-event span{display:block;font-size:11px;margin-top:5px;color:#526459}.schedule-event.cancelled{opacity:.65;border-left-color:#999}.schedule-event:focus-visible{outline:3px solid #2679b9}.schedule-calendar-scroll{overflow-x:auto}';
  document.head.appendChild(calendarStyle);
  const tableWrap = view.querySelector('.catalog-table-wrap');
  const calendarTools = document.createElement('div');
  calendarTools.className = 'schedule-calendar-tools';
  calendarTools.innerHTML = '<button type="button" data-mode="list" aria-pressed="true">Список</button><button type="button" data-mode="calendar" aria-pressed="false">Календарь</button><span class="week-controls" hidden><button type="button" data-week="-1" aria-label="Предыдущая неделя">←</button> <button type="button" data-week="0">Сегодня</button> <button type="button" data-week="1" aria-label="Следующая неделя">→</button> <label>Перейти к дате <input type="date" id="calendarDate"></label></span><strong id="calendarRange" aria-live="polite"></strong>';
  tableWrap.before(calendarTools);
  const calendar = document.createElement('div');
  calendar.className = 'schedule-calendar-scroll'; calendar.hidden = true;
  tableWrap.after(calendar);
  let calendarMode = false, calendarDay = new Date();
  const dayKey = d => `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
  function renderCalendar() {
    tableWrap.hidden = calendarMode;
    calendar.hidden = !calendarMode;
    calendarTools.querySelector('.week-controls').hidden = !calendarMode;
    calendarTools.querySelectorAll('[data-mode]').forEach(b => b.setAttribute('aria-pressed', String((b.dataset.mode === 'calendar') === calendarMode)));
    const range = calendarTools.querySelector('#calendarRange');
    range.textContent = '';
    if (!calendarMode) return;
    const start = new Date(calendarDay); start.setHours(0,0,0,0); start.setDate(start.getDate() - (start.getDay()+6)%7);
    const finish = new Date(start); finish.setDate(finish.getDate()+6);
    range.textContent = `${start.toLocaleDateString('ru-RU')} — ${finish.toLocaleDateString('ru-RU')}`;
    calendarTools.querySelector('#calendarDate').value = dayKey(calendarDay);
    const time = v => new Date(v).toLocaleTimeString('ru-RU', {hour:'2-digit',minute:'2-digit'});
    calendar.innerHTML = '<div class="schedule-week">' + Array.from({length:7},(_,i)=>{
      const day = new Date(start); day.setDate(day.getDate()+i);
      const next = new Date(day); next.setDate(next.getDate()+1);
      const events = lessons.filter(l => new Date(l.startsAt)<next && new Date(l.endsAt)>day).sort((a,b)=>new Date(a.startsAt)-new Date(b.startsAt));
      return `<section class="schedule-day ${dayKey(day)===dayKey(new Date())?'today':''}"><h3>${esc(day.toLocaleDateString('ru-RU',{weekday:'short',day:'numeric',month:'short'}))}</h3>${events.length ? events.map(l=>`<button type="button" class="schedule-event ${l.status==='Отменено'?'cancelled':''}" data-id="${esc(l.id)}"><strong>${esc(time(l.startsAt))}–${esc(time(l.endsAt))}</strong><span>${esc(l.title)}</span><span>${esc(l.courseName)}</span><span>${esc(l.groupName)} · ${esc(l.teacherName)}</span><span>${esc(l.status)}</span></button>`).join('') : '<p class="meta">Нет занятий</p>'}</section>`;
    }).join('') + '</div>';
  }
  calendarTools.onclick = e => {
    const mode = e.target.closest('[data-mode]'), week = e.target.closest('[data-week]');
    if (mode) calendarMode = mode.dataset.mode === 'calendar';
    if (week) { const offset = Number(week.dataset.week); if (!offset) calendarDay = new Date(); else calendarDay.setDate(calendarDay.getDate()+offset*7); }
    renderCalendar();
  };
  calendarTools.querySelector('#calendarDate').onchange = e => { if (e.target.value) { calendarDay = new Date(e.target.value+'T12:00:00'); renderCalendar(); } };
  calendar.onclick = e => { const button = e.target.closest('[data-id]'); if (button) edit(lessons.find(l => String(l.id)===button.dataset.id)); };
  const modal = document.createElement('dialog');
  modal.className = 'catalog-modal'; modal.style.border = '1px solid #d5ddd8';
  document.body.appendChild(modal);
  let lessons = [], courses = [], groups = [], teachers = [], requestVersion = 0;
  const filters = view.querySelector('#lessonFilters'), error = view.querySelector('#scheduleError');
  async function api(url, method = 'GET', body) {
    const r = await fetch(url, { method, ...(body ? { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : {}) });
    const data = await r.json(); if (!r.ok) throw new Error(data.error || `Ошибка ${r.status}`); return data;
  }
  function options(items, selected, blank = 'Выберите…') {
    return `<option value="">${blank}</option>` + items.map(x => `<option value="${x.id}" ${String(x.id) === String(selected) ? 'selected' : ''}>${esc(x.name)}${['Архив', 'Заблокирован', 'Ожидает активации'].includes(x.status) ? ' (' + esc(x.status) + ')' : ''}</option>`).join('');
  }
  async function directory() {
    const values = await Promise.all([api('/api/admin/courses'), api('/api/admin/groups'), api('/api/users')]);
    [courses, groups] = values; teachers = values[2].filter(x => x.role === 'Преподаватель');
    for (const [name, items, label] of [['teacherId', teachers, 'Все преподаватели'], ['groupId', groups, 'Все группы'], ['courseId', courses, 'Все дисциплины']]) {
      const select = filters.elements[name], selected = select.value; select.innerHTML = options(items, selected, label);
    }
  }
  async function load() {
    const version = ++requestVersion; error.textContent = '';
    try {
      const params = new URLSearchParams();
      for (const [key, value] of new FormData(filters)) if (value) {
        if (key === 'from' || key === 'to') {
          const d = new Date(value + 'T00:00:00'); if (key === 'to') d.setDate(d.getDate() + 1);
          params.set(key, d.toISOString());
        } else params.set(key, value);
      }
      const result = await api('/api/admin/lessons?' + params);
      if (version !== requestVersion) return;
      lessons = result;
      renderCalendar();
      view.querySelector('#lessonCount').textContent = `Найдено занятий: ${lessons.length}`;
      view.querySelector('#lessonEmpty').hidden = lessons.length > 0;
      view.querySelector('#lessonTable').innerHTML = lessons.map(l => `<tr><td>${esc(fmt(l.startsAt))}<span class="catalog-desc">до ${esc(fmt(l.endsAt))}</span></td><td><strong>${esc(l.title)}</strong><span class="catalog-desc">${esc(l.courseCode)} · ${esc(l.courseName)}</span></td><td>${esc(l.teacherName)}</td><td>${esc(l.groupName)}</td><td><span class="catalog-status ${l.status === 'Отменено' ? 'archived' : ''}">${esc(l.status)}</span></td><td><div class="catalog-actions"><button class="catalog-button" data-action="edit" data-id="${l.id}">Редактировать</button><button class="catalog-button" data-action="copy" data-id="${l.id}">Копировать</button>${l.status === 'Запланировано' ? `<button class="catalog-button" data-action="complete" data-id="${l.id}">Проведено</button><button class="catalog-button" data-action="cancel" data-id="${l.id}">Отменить занятие</button>` : ''}<button class="catalog-button danger" data-action="delete" data-id="${l.id}">Удалить</button></div></td></tr>`).join('');
    } catch (e) { if (version === requestVersion) error.textContent = e.message; }
  }
  async function refresh() { try { await directory(); await load(); } catch (e) { error.textContent = e.message; } }
  function show() {
    document.querySelectorAll('.admin-view').forEach(el => el.hidden = el !== view);
    nav.querySelectorAll('a').forEach(a => a.classList.toggle('active', a.hash === '#schedule'));
    document.querySelector('.topbar h1').textContent = 'Расписание занятий';
    document.querySelector('.topbar .crumb').textContent = 'АДМИНИСТРИРОВАНИЕ / РАСПИСАНИЕ';
    history.replaceState(null, '', '#schedule'); if (document.querySelector('#authScreen').classList.contains('hidden')) refresh();
  }
  nav.querySelector('a[href="#schedule"]').onclick = e => { e.preventDefault(); show(); };
  async function edit(lesson, copy = false) {
    try {
      await directory();
      if (lesson) lesson = await api('/api/admin/lessons/' + lesson.id);
    } catch (e) { error.textContent = e.message; return; }
    const start = lesson ? new Date(lesson.startsAt) : new Date();
    if (!lesson) { start.setHours(start.getHours() + 1, 0, 0, 0); }
    const end = lesson ? new Date(lesson.endsAt) : new Date(+start + 3600000);
    modal.innerHTML = `<form id="lessonForm"><div class="modal-kicker">РАСПИСАНИЕ</div><h2>${copy ? 'Копировать занятие' : lesson ? 'Редактировать занятие' : 'Новое занятие'}</h2>
      ${copy ? '<p>Выберите новое время для копии занятия.</p>' : ''}
      <label>Тема занятия<input name="title" required minlength="2" maxlength="200" value="${esc(lesson?.title || '')}"></label>
      <label>Дисциплина<select name="courseId" required>${options(courses.filter(x => x.status === 'Активна' || String(x.id) === String(lesson?.courseId)), lesson?.courseId)}</select></label>
      <div class="catalog-modal-grid"><label>Преподаватель<select name="teacherId" required>${options(teachers.filter(x => x.status === 'Активен' || String(x.id) === String(lesson?.teacherId)), lesson?.teacherId)}</select></label>
      <label>Группа<select name="groupId" required>${options(groups.filter(x => x.status === 'Активна' || String(x.id) === String(lesson?.groupId)), lesson?.groupId)}</select></label>
      <label>Начало<input name="startsAt" type="datetime-local" required value="${local(start)}"></label><label>Окончание<input name="endsAt" type="datetime-local" required value="${local(end)}"></label></div>
      <label>Статус<select name="status">${statuses.map(s => `<option ${s === (copy ? 'Запланировано' : lesson?.status || 'Запланировано') ? 'selected' : ''}>${s}</option>`).join('')}</select></label>
      <p id="lessonFormError" role="alert" style="color:#a63e39"></p><div class="catalog-modal-actions"><button type="button" class="cancel-button" id="closeLesson">Закрыть</button><button class="primary-button" type="submit">Сохранить</button></div></form>`;
    modal.showModal();
    modal.querySelector('#closeLesson').onclick = () => modal.close();
    const form = modal.querySelector('form');
    form.elements.courseId.onchange = () => { const c = courses.find(c => String(c.id) === form.elements.courseId.value); if (c?.teacherId) form.elements.teacherId.value = c.teacherId; };
    form.onsubmit = async e => {
      e.preventDefault(); const button = form.querySelector('[type="submit"]'); button.disabled = true;
      const body = Object.fromEntries(new FormData(form));
      try {
        body.startsAt = new Date(body.startsAt).toISOString(); body.endsAt = new Date(body.endsAt).toISOString();
        await api('/api/admin/lessons' + (lesson && !copy ? '/' + lesson.id : ''), lesson && !copy ? 'PUT' : 'POST', body);
        modal.close(); await load();
      } catch (e) { form.querySelector('#lessonFormError').textContent = e.message; } finally { button.disabled = false; }
    };
  }
  view.querySelector('#addLesson').onclick = () => edit();
  filters.onsubmit = e => { e.preventDefault(); load(); };
  filters.onreset = () => setTimeout(load, 0);
  view.querySelector('#lessonTable').onclick = async e => {
    const b = e.target.closest('button[data-action]'); if (!b) return;
    const l = lessons.find(x => String(x.id) === b.dataset.id), action = b.dataset.action;
    if (action === 'edit' || action === 'copy') return edit(l, action === 'copy');
    const label = { delete: 'Удалить занятие без возможности восстановления', cancel: 'Отменить занятие', complete: 'Отметить занятие проведённым' }[action];
    if (!confirm(`${label} «${l.title}»?`)) return;
    b.disabled = true;
    try {
      if (action === 'delete') await api('/api/admin/lessons/' + l.id, 'DELETE');
      else { const current = await api('/api/admin/lessons/' + l.id); await api('/api/admin/lessons/' + l.id, 'PUT', { ...current, status: action === 'cancel' ? 'Отменено' : 'Проведено' }); }
      await load();
    } catch (e) { error.textContent = e.message; b.disabled = false; }
  };
  view.querySelector('#exportLessons').onclick = () => {
    const cell = v => '"' + String(v ?? '').replace(/^[=+@\-\t\r]/, s => "'" + s).replace(/"/g, '""') + '"';
    const rows = [['Тема', 'Дисциплина', 'Преподаватель', 'Группа', 'Начало', 'Окончание', 'Статус'], ...lessons.map(l => [l.title, l.courseName, l.teacherName, l.groupName, fmt(l.startsAt), fmt(l.endsAt), l.status])];
    const url = URL.createObjectURL(new Blob(['\ufeff' + rows.map(r => r.map(cell).join(';')).join('\r\n')], { type: 'text/csv;charset=utf-8' }));
    const a = document.createElement('a'); a.href = url; a.download = 'edulink-schedule.csv'; a.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
  };
  document.addEventListener('edulink:authenticated', () => { if (!view.hidden) refresh(); });
  // Restore deep links after the academic navigation initializes.
  if (window.edulinkInitialHash === '#schedule' || location.hash === '#schedule') show();
})();
