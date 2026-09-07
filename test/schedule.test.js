// Run against an isolated, freshly seeded database, never a production server.
const test = require('node:test');
const assert = require('node:assert/strict');
const base = process.env.TEST_BASE_URL;
test('schedule API integration', { skip: !base }, async t => {
  async function call(path, method = 'GET', body, cookie = '') {
    const r = await fetch(base + path, { method, headers: { 'Content-Type': 'application/json', Cookie: cookie }, ...(body ? { body: JSON.stringify(body) } : {}) });
    return { status: r.status, data: await r.json(), cookie: r.headers.get('set-cookie')?.split(';')[0] };
  }
  const login = async (email, password) => (await call('/api/login', 'POST', { email, password })).cookie;
  const admin = await login('admin@edulink.local', 'ChangeMe123!');
  const teacher = await login('anna.krylova@edulink.local', 'TeacherDemo123!');
  const student = await login('elena.smirnova@edulink.local', 'StudentDemo123!');
  const api = (path, method, body) => call(path, method, body, admin);
  const endpoint = '/api/admin/lessons';
  const input = { title: 'Schedule integration <test>', courseId: 1, teacherId: 1, groupId: 1,
    startsAt: '2035-01-10T10:00:00+03:00', endsAt: '2035-01-10T11:00:00+03:00', status: 'Запланировано' };
  const ids = [];
  try {
    await t.test('roles cannot manage the schedule', async () => {
      for (const cookie of ['', teacher, student]) for (const method of ['GET', 'POST', 'PUT', 'DELETE']) {
        const r = await call(endpoint + (['PUT','DELETE'].includes(method) ? '/1' : ''), method, method === 'POST' || method === 'PUT' ? input : null, cookie);
        assert.equal(r.status, 403);
      }
    });
    const created = await api(endpoint, 'POST', input); assert.equal(created.status, 201); const item = created.data; ids.push(item.id);
    await t.test('creation preserves timezone and appears in both dashboards', async () => {
      assert.equal(new Date(item.startsAt).toISOString(), '2035-01-10T07:00:00.000Z');
      for (const [role, cookie] of [['teacher', teacher], ['student', student]]) {
        const r = await call('/api/' + role + '/dashboard', 'GET', null, cookie);
        assert(r.data.lessons.some(l => String(l.id) === String(item.id)));
      }
    });
    await t.test('validation, overlap and boundary', async () => {
      for (const change of [{ title: '' }, { endsAt: input.startsAt }, { status: 'wrong' }, { teacherId: 3 }, { groupId: 999999 }, { startsAt: 'not a date' }]) {
        assert.equal((await api(endpoint, 'POST', { ...input, ...change })).status, 400);
      }
      assert.equal((await api(endpoint, 'POST', input)).status, 409);
      // Group overlap with a different teacher.
      assert.equal((await api(endpoint, 'POST', { ...input, teacherId: 4 })).status, 409);
      const adjacent = await api(endpoint, 'POST', { ...input, startsAt: input.endsAt, endsAt: '2035-01-10T12:00:00+03:00' });
      assert.equal(adjacent.status, 201); ids.push(adjacent.data.id);
    });
    await t.test('update, filters, cancel, restore conflict and delete', async () => {
      assert.equal((await api(endpoint + '/' + item.id, 'PUT', { ...input, title: 'Updated schedule' })).status, 200);
      const list = await api(endpoint + '?q=Updated&teacherId=1&groupId=1&courseId=1&from=2035-01-10T00:00:00Z&to=2035-01-11T00:00:00Z');
      assert.equal(list.data.length, 1);
      assert.equal((await api(endpoint + '/' + item.id, 'PUT', { ...input, status: 'Отменено' })).status, 200);
      const replacement = await api(endpoint, 'POST', input); assert.equal(replacement.status, 201); ids.push(replacement.data.id);
      assert.equal((await api(endpoint + '/' + item.id, 'PUT', input)).status, 409);
      assert.equal((await api(endpoint + '/' + replacement.data.id, 'DELETE')).status, 200);
      assert.equal((await api(endpoint + '/' + replacement.data.id)).status, 404);
      assert.equal((await api(endpoint + '/' + item.id, 'PUT', { ...input, status: 'Проведено' })).status, 200);
    });
    await t.test('concurrent overlap cannot be saved twice', async () => {
      const body = { ...input, startsAt: '2035-02-01T10:00:00Z', endsAt: '2035-02-01T11:00:00Z' };
      const results = await Promise.all([api(endpoint, 'POST', body), api(endpoint, 'POST', body)]);
      assert.deepEqual(results.map(r => r.status).sort(), [201, 409]);
      ids.push(results.find(r => r.status === 201).data.id);
    });
  } finally { for (const id of ids) await api(endpoint + '/' + id, 'DELETE'); }
});
