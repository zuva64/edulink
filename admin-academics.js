(() => {
  const existingView = document.querySelector('.page-content#overview');
  const main = document.querySelector('main.main');
  const nav = document.querySelector('.sidebar nav');
  const title = document.querySelector('.topbar h1');
  const crumb = document.querySelector('.topbar .crumb');
  const toast = document.querySelector('#toast');
  if (!existingView || !main || !nav) return;

  const css = document.createElement('style');
  css.textContent = `
    .admin-view[hidden]{display:none!important}.catalog-grid{display:grid;gap:14px}.catalog-panel{background:#fff;border:1px solid var(--line);border-radius:12px;overflow:hidden}.catalog-table-wrap{overflow:auto}.catalog-panel table{min-width:840px}.catalog-actions{display:flex;gap:6px;justify-content:flex-end;flex-wrap:wrap}.catalog-button{border:1px solid #d5ddd8;background:#fff;border-radius:8px;padding:7px 10px;cursor:pointer;font-size:11px}.catalog-button.danger{color:#a63e39;border-color:#e7cbc9}.catalog-empty{text-align:center;color:var(--muted);padding:30px}.catalog-code{font-weight:800;color:#174b39}.catalog-desc{display:block;color:var(--muted);font-size:11px;margin-top:3px;max-width:420px}.catalog-status{display:inline-flex;padding:4px 8px;border-radius:999px;background:#e8f5ee;color:#236e53;font-size:10px}.catalog-status.archived{background:#f0f1f0;color:#707a75}.catalog-modal-backdrop{position:fixed;inset:0;z-index:80;background:#173b3066;display:none;align-items:center;justify-content:center;padding:20px}.catalog-modal-backdrop.open{display:flex}.catalog-modal{background:#fff;width:min(620px,100%);max-height:90vh;overflow:auto;border-radius:16px;padding:24px;box-shadow:0 24px 80px rgba(0,0,0,.2)}.catalog-modal h2{margin:4px 0 8px}.catalog-modal label{display:block;margin:12px 0;font-size:12px}.catalog-modal input,.catalog-modal select,.catalog-modal textarea{width:100%;box-sizing:border-box;margin-top:6px;padding:10px 11px;border:1px solid #d5ddd8;border-radius:9px;font:inherit;background:#fff}.catalog-modal textarea{min-height:90px;resize:vertical}.catalog-modal-grid{display:grid;grid-template-columns:1fr 1fr;gap:12px}.catalog-modal-actions{display:flex;justify-content:flex-end;gap:8px;margin-top:20px}.student-picker{border:1px solid #dfe5e2;border-radius:10px;max-height:230px;overflow:auto;padding:8px}.student-choice{display:flex!important;align-items:center;gap:9px;padding:8px;margin:0!important;border-bottom:1px solid #edf1ef}.student-choice:last-child{border-bottom:0}.student-choice input{width:auto;margin:0}.student-choice span{display:flex;flex-direction:column}.student-choice small{color:var(--muted)}@media(max-width:760px){.catalog-modal-grid{grid-template-columns:1fr}.catalog-panel table{min-width:720px}}
  `;
  document.head.appendChild(css);

  existingView.classList.add('admin-view');
  existingView.dataset.view = 'users';

  const coursesView = document.createElement('section');
  coursesView.className = 'page-content admin-view';
  coursesView.dataset.view = 'courses';
  coursesView.hidden = true;
  coursesView.innerHTML = `
    <div class="intro"><div><h2>Дисциплины</h2><p>Создавайте дисциплины и назначайте ответственных преподавателей.</p></div><button class="primary-button" id="addCourse">＋ Добавить дисциплину</button></div>
    <section class="catalog-panel"><div class="panel-header"><div><h2>Все дисциплины</h2><p id="courseCount">Загрузка...</p></div></div><div class="catalog-table-wrap"><table><thead><tr><th>КОД</th><th>ДИСЦИПЛИНА</th><th>ПРЕПОДАВАТЕЛЬ</th><th>СТАТУС</th><th>ЗАНЯТИЙ</th><th></th></tr></thead><tbody id="courseTable"></tbody></table><div class="catalog-empty" id="courseEmpty" hidden>Дисциплины не созданы</div></div></section>`;

  const groupsView = document.createElement('section');
  groupsView.className = 'page-content admin-view';
  groupsView.dataset.view = 'groups';
  groupsView.hidden = true;
  groupsView.innerHTML = `
    <div class="intro"><div><h2>Учебные группы</h2><p>Управляйте учебными группами и распределением студентов.</p></div><button class="primary-button" id="addGroup">＋ Добавить группу</button></div>
    <section class="catalog-panel"><div class="panel-header"><div><h2>Все группы</h2><p id="groupCount">Загрузка...</p></div></div><div class="catalog-table-wrap"><table><thead><tr><th>ГРУППА</th><th>УЧЕБНЫЙ ГОД</th><th>СТУДЕНТОВ</th><th>СТАТУС</th><th>ЗАНЯТИЙ</th><th></th></tr></thead><tbody id="groupTable"></tbody></table><div class="catalog-empty" id="groupEmpty" hidden>Учебные группы не созданы</div></div></section>`;
  main.append(coursesView, groupsView);

  const modal = document.createElement('div');
  modal.className = 'catalog-modal-backdrop';
  document.body.appendChild(modal);

  let courses = [], groups = [], directoryUsers = [];

  const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  async function request(url, options = {}) {
    const r = await fetch(url, options);
    const body = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(body.error || `Ошибка ${r.status}`);
    return body;
  }
  function notify(message, type = 'ok') {
    if (typeof showToast === 'function') return showToast(message, type);
    toast.textContent = message; toast.dataset.type = type; toast.classList.add('show'); setTimeout(() => toast.classList.remove('show'), 3000);
  }
  function json(method, body) { return { method, headers: {'Content-Type':'application/json'}, body: JSON.stringify(body) }; }
  function closeModal() { modal.classList.remove('open'); modal.innerHTML = ''; }
  modal.addEventListener('click', (e) => { if (e.target === modal) closeModal(); });

  async function loadDirectory() { directoryUsers = await request('/api/users'); }
  async function loadCourses() {
    courses = await request('/api/admin/courses');
    const table = document.querySelector('#courseTable'), empty = document.querySelector('#courseEmpty');
    table.innerHTML = courses.map((c) => `<tr><td><span class="catalog-code">${esc(c.code)}</span></td><td><strong>${esc(c.name)}</strong>${c.description ? `<span class="catalog-desc">${esc(c.description)}</span>` : ''}</td><td>${esc(c.teacherName || 'Не назначен')}</td><td><span class="catalog-status ${c.status === 'Архив' ? 'archived' : ''}">${esc(c.status)}</span></td><td>${c.lessonCount || 0}</td><td><div class="catalog-actions"><button class="catalog-button" data-course-edit="${c.id}">Редактировать</button><button class="catalog-button danger" data-course-delete="${c.id}">Удалить</button></div></td></tr>`).join('');
    empty.hidden = Boolean(courses.length); document.querySelector('#courseCount').textContent = `${courses.length} дисциплин`;
    table.querySelectorAll('[data-course-edit]').forEach((b) => b.onclick = () => openCourse(Number(b.dataset.courseEdit)));
    table.querySelectorAll('[data-course-delete]').forEach((b) => b.onclick = () => deleteCourse(Number(b.dataset.courseDelete)));
  }
  async function loadGroups() {
    groups = await request('/api/admin/groups');
    const table = document.querySelector('#groupTable'), empty = document.querySelector('#groupEmpty');
    table.innerHTML = groups.map((g) => `<tr><td><strong>${esc(g.name)}</strong>${g.description ? `<span class="catalog-desc">${esc(g.description)}</span>` : ''}</td><td>${esc(g.academicYear)}</td><td>${g.studentCount || 0}</td><td><span class="catalog-status ${g.status === 'Архив' ? 'archived' : ''}">${esc(g.status)}</span></td><td>${g.lessonCount || 0}</td><td><div class="catalog-actions"><button class="catalog-button" data-group-edit="${g.id}">Редактировать</button><button class="catalog-button danger" data-group-delete="${g.id}">Удалить</button></div></td></tr>`).join('');
    empty.hidden = Boolean(groups.length); document.querySelector('#groupCount').textContent = `${groups.length} групп`;
    table.querySelectorAll('[data-group-edit]').forEach((b) => b.onclick = () => openGroup(Number(b.dataset.groupEdit)));
    table.querySelectorAll('[data-group-delete]').forEach((b) => b.onclick = () => deleteGroup(Number(b.dataset.groupDelete)));
  }

  async function openCourse(id = null) {
    try { await loadDirectory(); } catch (e) { return notify(e.message, 'error'); }
    const item = id ? courses.find((c) => c.id === id) : null;
    const teachers = directoryUsers.filter((u) => u.role === 'Преподаватель');
    modal.innerHTML = `<form class="catalog-modal" id="courseForm"><div class="modal-kicker">ДИСЦИПЛИНА</div><h2>${item ? 'Редактировать дисциплину' : 'Новая дисциплина'}</h2><p>Код дисциплины должен быть уникальным.</p><div class="catalog-modal-grid"><label>Код<input name="code" required minlength="2" value="${esc(item?.code || '')}" placeholder="MATH101"></label><label>Статус<select name="status"><option ${item?.status !== 'Архив' ? 'selected' : ''}>Активна</option><option ${item?.status === 'Архив' ? 'selected' : ''}>Архив</option></select></label></div><label>Название<input name="name" required minlength="2" value="${esc(item?.name || '')}"></label><label>Преподаватель<select name="teacherId"><option value="">Не назначен</option>${teachers.map((t) => `<option value="${t.id}" ${Number(item?.teacherId) === t.id ? 'selected' : ''}>${esc(t.name)} — ${esc(t.email)}</option>`).join('')}</select></label><label>Описание<textarea name="description">${esc(item?.description || '')}</textarea></label><div class="catalog-modal-actions"><button type="button" class="cancel-button" id="courseCancel">Отмена</button><button class="primary-button">Сохранить</button></div></form>`;
    modal.classList.add('open'); modal.querySelector('#courseCancel').onclick = closeModal;
    modal.querySelector('#courseForm').onsubmit = async (e) => { e.preventDefault(); const f = new FormData(e.currentTarget); const body = { code:f.get('code'), name:f.get('name'), teacherId:f.get('teacherId') || null, status:f.get('status'), description:f.get('description') };
      try { await request(item ? `/api/admin/courses/${item.id}` : '/api/admin/courses', json(item ? 'PUT' : 'POST', body)); closeModal(); notify(item ? 'Дисциплина обновлена' : 'Дисциплина создана'); await loadCourses(); } catch (err) { notify(err.message, 'error'); }
    };
  }
  async function deleteCourse(id) {
    const item = courses.find((c) => c.id === id); if (!item || !confirm(`Удалить дисциплину «${item.name}»?`)) return;
    try { await request(`/api/admin/courses/${id}`, {method:'DELETE'}); notify('Дисциплина удалена'); await loadCourses(); } catch (e) { notify(e.message, 'error'); }
  }

  async function openGroup(id = null) {
    try { await loadDirectory(); } catch (e) { return notify(e.message, 'error'); }
    const item = id ? groups.find((g) => g.id === id) : null;
    const students = directoryUsers.filter((u) => u.role === 'Студент');
    const selected = new Set((item?.studentIds || []).map(Number));
    modal.innerHTML = `<form class="catalog-modal" id="groupForm"><div class="modal-kicker">УЧЕБНАЯ ГРУППА</div><h2>${item ? 'Редактировать группу' : 'Новая учебная группа'}</h2><div class="catalog-modal-grid"><label>Название<input name="name" required minlength="2" value="${esc(item?.name || '')}" placeholder="ИВТ-26-01"></label><label>Учебный год<input name="academicYear" required value="${esc(item?.academicYear || '2026/2027')}" placeholder="2026/2027"></label></div><label>Статус<select name="status"><option ${item?.status !== 'Архив' ? 'selected' : ''}>Активна</option><option ${item?.status === 'Архив' ? 'selected' : ''}>Архив</option></select></label><label>Описание<textarea name="description">${esc(item?.description || '')}</textarea></label><label>Студенты</label><div class="student-picker">${students.length ? students.map((s) => `<label class="student-choice"><input type="checkbox" name="studentIds" value="${s.id}" ${selected.has(s.id) ? 'checked' : ''}><span>${esc(s.name)}<small>${esc(s.email)}${s.groupName ? ` · сейчас: ${esc(s.groupName)}` : ''}</small></span></label>`).join('') : '<div class="catalog-empty">Нет студентов для назначения</div>'}</div><div class="catalog-modal-actions"><button type="button" class="cancel-button" id="groupCancel">Отмена</button><button class="primary-button">Сохранить</button></div></form>`;
    modal.classList.add('open'); modal.querySelector('#groupCancel').onclick = closeModal;
    modal.querySelector('#groupForm').onsubmit = async (e) => { e.preventDefault(); const f = new FormData(e.currentTarget); const body = { name:f.get('name'), academicYear:f.get('academicYear'), status:f.get('status'), description:f.get('description'), studentIds:f.getAll('studentIds').map(Number) };
      try { await request(item ? `/api/admin/groups/${item.id}` : '/api/admin/groups', json(item ? 'PUT' : 'POST', body)); closeModal(); notify(item ? 'Учебная группа обновлена' : 'Учебная группа создана'); await Promise.all([loadGroups(), loadDirectory()]); if (typeof loadUsers === 'function') await loadUsers(); } catch (err) { notify(err.message, 'error'); }
    };
  }
  async function deleteGroup(id) {
    const item = groups.find((g) => g.id === id); if (!item || !confirm(`Удалить учебную группу «${item.name}»? Студенты останутся без группы.`)) return;
    try { await request(`/api/admin/groups/${id}`, {method:'DELETE'}); notify('Учебная группа удалена'); await loadGroups(); if (typeof loadUsers === 'function') await loadUsers(); } catch (e) { notify(e.message, 'error'); }
  }

  function setView(view) {
    document.querySelectorAll('.admin-view').forEach((el) => { el.hidden = el.dataset.view !== view; });
    nav.querySelectorAll('a').forEach((a) => a.classList.remove('active'));
    const active = nav.querySelector(`[data-admin-view="${view}"]`) || nav.querySelector(view === 'users' ? 'a[href="#users"]' : `a[href="#${view}"]`);
    active?.classList.add('active');
    const meta = { users:['Учетные записи','АДМИНИСТРИРОВАНИЕ / ПОЛЬЗОВАТЕЛИ'], courses:['Дисциплины','АДМИНИСТРИРОВАНИЕ / ДИСЦИПЛИНЫ'], groups:['Учебные группы','АДМИНИСТРИРОВАНИЕ / УЧЕБНЫЕ ГРУППЫ'] }[view];
    if (meta) { title.textContent = meta[0]; crumb.textContent = meta[1]; }
    if (view === 'courses') loadCourses().catch((e) => notify(e.message,'error'));
    if (view === 'groups') loadGroups().catch((e) => notify(e.message,'error'));
    history.replaceState(null, '', `#${view}`);
  }

  const usersLink = nav.querySelector('a[href="#users"]'); if (usersLink) usersLink.dataset.adminView = 'users';
  const overviewLink = nav.querySelector('a[href="#overview"]'); if (overviewLink) overviewLink.dataset.adminView = 'users';
  const coursesLink = nav.querySelector('a[href="#courses"]'); if (coursesLink) coursesLink.dataset.adminView = 'courses';
  const groupsLink = nav.querySelector('a[href="#groups"]'); if (groupsLink) groupsLink.dataset.adminView = 'groups';
  nav.querySelectorAll('[data-admin-view]').forEach((a) => a.addEventListener('click', (e) => { e.preventDefault(); setView(a.dataset.adminView); }));
  nav.querySelectorAll('a[href="#activity"],a[href="#settings"]').forEach((a) => a.addEventListener('click', (e) => { e.preventDefault(); notify('Этот раздел будет добавлен на следующем этапе'); }));

  coursesView.querySelector('#addCourse').onclick = () => openCourse();
  groupsView.querySelector('#addGroup').onclick = () => openGroup();

  const initial = location.hash === '#courses' ? 'courses' : location.hash === '#groups' ? 'groups' : 'users';
  setView(initial);
})();
