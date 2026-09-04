let users=[];
const table=document.querySelector('#userTable');
const emptyState=document.querySelector('#emptyState');
const search=document.querySelector('#search');
const roleFilter=document.querySelector('#roleFilter');
const statusFilter=document.querySelector('#statusFilter');
const modal=document.querySelector('#modal');
const toast=document.querySelector('#toast');

function esc(v){return String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));}
function initials(n){return String(n||'').split(' ').filter(Boolean).map(p=>p[0]).join('').slice(0,2).toUpperCase();}
function showToast(message,type='ok'){toast.textContent=message;toast.dataset.type=type;toast.classList.add('show');setTimeout(()=>toast.classList.remove('show'),3200);}
async function api(url,options={}){const r=await fetch(url,options);const body=await r.json().catch(()=>({}));if(!r.ok)throw new Error(body.error||`Ошибка ${r.status}`);return body;}
function closeModal(){modal.classList.remove('open');}

const style=document.createElement('style');
style.textContent=`
.user-actions{display:flex;gap:6px;flex-wrap:wrap;justify-content:flex-end}.admin-action{border:1px solid #d8e1dd;background:#fff;border-radius:8px;padding:7px 9px;font-size:11px;cursor:pointer}.admin-action:hover{background:#f4f8f6}.admin-action.danger{color:#a63e39;border-color:#e7cbc9}.admin-action.warn{color:#8a6218}.admin-action:disabled{opacity:.45;cursor:not-allowed}.verified-badge,.unverified-badge{display:inline-flex;margin-top:4px;padding:2px 6px;border-radius:999px;font-size:9px}.verified-badge{background:#e8f5ee;color:#236e53}.unverified-badge{background:#fff3df;color:#8a6218}.lock-note{font-size:9px;color:#b15b55}.admin-edit-backdrop{position:fixed;inset:0;background:rgba(14,28,22,.45);display:none;align-items:center;justify-content:center;z-index:60}.admin-edit-backdrop.open{display:flex}.admin-edit-card{width:min(520px,calc(100vw - 32px));background:#fff;border-radius:18px;padding:24px;box-shadow:0 24px 80px rgba(0,0,0,.18)}.admin-edit-card h2{margin:0 0 8px}.admin-edit-card p{margin:0 0 18px;color:#66736d}.admin-edit-card label{display:block;margin:12px 0;font-size:12px}.admin-edit-card input,.admin-edit-card select{width:100%;box-sizing:border-box;margin-top:6px;padding:11px 12px;border:1px solid #d5ded9;border-radius:10px;background:#fff}.admin-edit-grid{display:grid;grid-template-columns:1fr 1fr;gap:12px}.admin-edit-check{display:flex!important;gap:9px;align-items:center}.admin-edit-check input{width:auto;margin:0}.admin-edit-actions{display:flex;justify-content:flex-end;gap:8px;margin-top:20px}.admin-secondary{border:1px solid #d8e1dd;background:#fff;border-radius:9px;padding:10px 14px;cursor:pointer}.table-wrap table{min-width:980px}.toast[data-type="error"]{background:#8f3f3a}
`;
document.head.appendChild(style);

const editBackdrop=document.createElement('div');
editBackdrop.className='admin-edit-backdrop';
editBackdrop.innerHTML=`<form class="admin-edit-card" id="adminEditForm">
  <div class="modal-kicker">УПРАВЛЕНИЕ ПОЛЬЗОВАТЕЛЕМ</div><h2 id="adminEditTitle">Редактировать пользователя</h2><p>Изменения применяются сразу. При смене роли, e-mail или статуса активные сессии пользователя будут завершены.</p>
  <input type="hidden" name="id">
  <label>Имя и фамилия<input name="name" required minlength="2"></label>
  <label>E-mail<input name="email" type="email" required></label>
  <div class="admin-edit-grid"><label>Роль<select name="role"><option>Преподаватель</option><option>Студент</option><option>Администратор</option></select></label><label>Статус<select name="status"><option>Активен</option><option>Ожидает активации</option><option>Заблокирован</option></select></label></div>
  <label class="admin-edit-check"><input name="emailVerified" type="checkbox"> E-mail подтвержден</label>
  <div class="admin-edit-actions"><button type="button" class="admin-secondary" id="adminEditCancel">Отмена</button><button class="primary-button">Сохранить</button></div>
</form>`;
document.body.appendChild(editBackdrop);
const editForm=editBackdrop.querySelector('#adminEditForm');
editBackdrop.querySelector('#adminEditCancel').onclick=()=>editBackdrop.classList.remove('open');
editBackdrop.addEventListener('click',e=>{if(e.target===editBackdrop)editBackdrop.classList.remove('open');});

function openEdit(id){const u=users.find(x=>x.id===id);if(!u)return;const e=editForm.elements;e.id.value=u.id;e.name.value=u.name;e.email.value=u.email;e.role.value=u.role;e.status.value=u.status;e.emailVerified.checked=Boolean(u.emailVerified);editBackdrop.querySelector('#adminEditTitle').textContent=`Редактировать: ${u.name}`;editBackdrop.classList.add('open');}

function render(){
  const q=search.value.toLowerCase().trim();
  const filtered=users.filter(u=>`${u.name} ${u.email}`.toLowerCase().includes(q)&&(roleFilter.value==='all'||u.role===roleFilter.value)&&(statusFilter.value==='all'||u.status===statusFilter.value));
  table.innerHTML=filtered.map((u,i)=>`<tr>
    <td><input type="checkbox" data-user-check="${u.id}"></td>
    <td class="user-cell"><span class="user-avatar avatar-${i%5}">${esc(initials(u.name))}</span><span>${esc(u.name)}<small>${esc(u.email)}</small><span class="${u.emailVerified?'verified-badge':'unverified-badge'}">${u.emailVerified?'E-mail подтвержден':'E-mail не подтвержден'}</span>${u.failedLoginAttempts?`<small class="lock-note">Ошибок входа: ${u.failedLoginAttempts}</small>`:''}</span></td>
    <td>${esc(u.role)}</td>
    <td><span class="status ${u.status==='Ожидает активации'?'pending':u.status==='Заблокирован'?'blocked':''}">${esc(u.status)}</span></td>
    <td>${esc(u.lastLogin||'Никогда')}</td>
    <td><div class="user-actions">
      <button class="admin-action" data-edit="${u.id}">Редактировать</button>
      ${u.status==='Заблокирован'?`<button class="admin-action" data-unlock="${u.id}">Разблокировать</button>`:`<button class="admin-action warn" data-block="${u.id}">Блокировать</button>`}
      <button class="admin-action" data-reset="${u.id}" ${u.emailVerified?'':'disabled title="E-mail не подтвержден"'}>Сброс пароля</button>
      <button class="admin-action danger" data-delete="${u.id}">Удалить</button>
    </div></td>
  </tr>`).join('');
  emptyState.style.display=filtered.length?'none':'block';
  document.querySelector('#resultCount').textContent=`Показано ${filtered.length} из ${users.length} пользователей`;
  document.querySelector('#userCount').textContent=users.length;
  document.querySelector('#totalUsers').textContent=users.length;
  document.querySelector('#pendingUsers').textContent=users.filter(u=>u.status==='Ожидает активации').length;
  document.querySelector('#blockedUsers').textContent=users.filter(u=>u.status==='Заблокирован').length;
  bindRowActions();
}

function bindRowActions(){
  document.querySelectorAll('[data-edit]').forEach(b=>b.onclick=()=>openEdit(Number(b.dataset.edit)));
  document.querySelectorAll('[data-unlock]').forEach(b=>b.onclick=async()=>{try{await api(`/api/users/${b.dataset.unlock}/unlock`,{method:'POST'});showToast('Учетная запись разблокирована');await loadUsers();}catch(e){showToast(e.message,'error');}});
  document.querySelectorAll('[data-block]').forEach(b=>b.onclick=async()=>{const u=users.find(x=>x.id===Number(b.dataset.block));if(!confirm(`Заблокировать учетную запись ${u?.name||''}?`))return;try{await api(`/api/users/${b.dataset.block}/block`,{method:'POST'});showToast('Учетная запись заблокирована');await loadUsers();}catch(e){showToast(e.message,'error');}});
  document.querySelectorAll('[data-reset]').forEach(b=>b.onclick=async()=>{const u=users.find(x=>x.id===Number(b.dataset.reset));if(!confirm(`Отправить код сброса пароля на ${u?.email||'e-mail пользователя'}?`))return;try{await api(`/api/users/${b.dataset.reset}/send-reset`,{method:'POST'});showToast('OTP для сброса пароля отправлен');}catch(e){showToast(e.message,'error');}});
  document.querySelectorAll('[data-delete]').forEach(b=>b.onclick=async()=>{const u=users.find(x=>x.id===Number(b.dataset.delete));if(!confirm(`Удалить пользователя ${u?.name||''}? Это действие нельзя отменить.`))return;try{await api(`/api/users/${b.dataset.delete}`,{method:'DELETE'});showToast('Пользователь удален');await loadUsers();}catch(e){showToast(e.message,'error');}});
}

editForm.addEventListener('submit',async e=>{e.preventDefault();const f=new FormData(editForm);const id=Number(f.get('id'));try{await api(`/api/users/${id}`,{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify({name:f.get('name'),email:f.get('email'),role:f.get('role'),status:f.get('status'),emailVerified:editForm.elements.emailVerified.checked})});editBackdrop.classList.remove('open');showToast('Данные пользователя обновлены');await loadUsers();}catch(err){showToast(err.message,'error');}});

[search,roleFilter,statusFilter].forEach(c=>c.addEventListener('input',render));
document.querySelector('#resetFilters').onclick=()=>{search.value='';roleFilter.value='all';statusFilter.value='all';render();};
document.querySelector('#selectAll').onchange=e=>table.querySelectorAll('input[data-user-check]').forEach(b=>b.checked=e.target.checked);
document.querySelector('#addUser').onclick=()=>modal.classList.add('open');
document.querySelector('#closeModal').onclick=closeModal;
document.querySelector('#cancelModal').onclick=closeModal;

document.querySelector('#userForm').addEventListener('submit',async e=>{e.preventDefault();const f=new FormData(e.target);try{await api('/api/users',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({name:f.get('name'),email:f.get('email'),role:f.get('role')})});await loadUsers();e.target.reset();closeModal();showToast('Пользователь создан. Для активации нужно подтвердить e-mail.');}catch(err){showToast(err.message,'error');}});

document.querySelector('#exportUsers').onclick=()=>{const cell=v=>`"${String(v??'').replace(/"/g,'""')}"`;const csv=['Имя,Email,Роль,Статус,Email подтвержден,Ошибок входа,Последний вход',...users.map(u=>[u.name,u.email,u.role,u.status,u.emailVerified?'Да':'Нет',u.failedLoginAttempts||0,u.lastLogin].map(cell).join(','))].join('\n');const url=URL.createObjectURL(new Blob([`\uFEFF${csv}`],{type:'text/csv;charset=utf-8'}));const a=document.createElement('a');a.href=url;a.download='edulink-users.csv';a.click();URL.revokeObjectURL(url);};

async function loadUsers(){users=await api('/api/users');render();}
function redirectByRole(role){if(role==='teacher')location.href='/teacher.html';else if(role==='student')location.href='/student.html';}
function authMode(mode){document.querySelector('#authScreen').classList.toggle('alt',mode!=='login');document.querySelectorAll('.auth-card.secondary').forEach(x=>x.classList.remove('active'));if(mode!=='login')document.querySelector(`#${mode}Form`).classList.add('active');}
document.querySelectorAll('[data-auth]').forEach(b=>b.onclick=()=>authMode(b.dataset.auth));

async function checkSession(){const r=await fetch('/api/session');if(!r.ok)return;const a=await r.json();if(a.role!=='admin'){redirectByRole(a.role);return;}document.querySelector('#authScreen').classList.add('hidden');await loadUsers();}

document.querySelector('#loginForm').addEventListener('submit',async e=>{e.preventDefault();const f=new FormData(e.target);try{const a=await api('/api/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({email:f.get('email'),password:f.get('password')})});if(a.role!=='admin'){redirectByRole(a.role);return;}document.querySelector('#authScreen').classList.add('hidden');await loadUsers();}catch(err){document.querySelector('#authError').textContent=err.message;}});

let registrationRequested=false;
document.querySelector('#registerForm').addEventListener('submit',async e=>{e.preventDefault();const f=new FormData(e.target),err=document.querySelector('#registerError');err.textContent='';try{if(!registrationRequested){const p=await api('/api/register/request-otp',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({name:f.get('name'),email:f.get('email'),password:f.get('password')})});registrationRequested=true;document.querySelector('#registerOtpFields').hidden=false;document.querySelector('#registerSubmit').textContent='Подтвердить регистрацию';if(p.devOtp)err.textContent=`Тестовый OTP: ${p.devOtp}`;return;}await api('/api/register/verify',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({email:f.get('email'),otp:f.get('otp')})});alert('E-mail подтвержден. Теперь можно войти.');location.reload();}catch(ex){err.textContent=ex.message;}});

let resetRequested=false;
document.querySelector('#resetForm').addEventListener('submit',async e=>{e.preventDefault();const f=new FormData(e.target),err=document.querySelector('#resetError');err.textContent='';try{if(!resetRequested){await api('/api/password/request-reset',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({email:f.get('email')})});resetRequested=true;document.querySelector('#resetFields').hidden=false;document.querySelector('#resetSubmit').textContent='Установить новый пароль';return;}await api('/api/password/reset',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({email:f.get('email'),otp:f.get('otp'),password:f.get('password')})});alert('Пароль изменен.');location.reload();}catch(ex){err.textContent=ex.message;}});

document.querySelector('#logout').onclick=async()=>{await fetch('/api/logout',{method:'POST'});location.reload();};
checkSession();
