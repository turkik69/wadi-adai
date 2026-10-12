import test from 'node:test';
import assert from 'node:assert/strict';
import worker from './worker.js';
import { webcrypto } from 'node:crypto';
if (!globalThis.crypto) globalThis.crypto = webcrypto;

class MockDB {
  users = []; sessions = []; records = []; meta = [];
  prepare(sql) {
    const db = this;
    return { bind(...args) { this.args = args; return this; },
      async first() {
        const a = this.args || [];
        if (sql.includes('count(*) AS n FROM users')) return { n: db.users.length };
        if (sql.includes('FROM users LIMIT 1')) return db.users[0] || null;
        if (sql.includes('FROM users WHERE username=?')) return db.users.find(u => u.username === a[0]) || null;
        if (sql.includes('FROM login_limits')) return null;
        if (sql.includes('FROM sessions s JOIN users u')) {
          const session = db.sessions.find(s => s.token_hash === a[0] && s.expires_at > a[1]);
          const user = db.users.find(u => u.id === session?.user_id && u.active);
          return user ? { ...user, token_hash: session.token_hash } : null;
        }
        if (sql.includes('FROM app_meta')) return db.meta[0] || null;
        if (sql.includes('FROM records WHERE collection')) return db.records.find(r => r.collection === a[0] && r.id === a[1]) || null;
        return null;
      },
      async all() {
        if (sql.includes('FROM users ORDER BY')) return { results: db.users };
        if (sql.includes('FROM records ORDER BY')) return { results: db.records };
        return { results: [] };
      },
      async run() {
        const a = this.args || [];
        if (sql.startsWith('INSERT INTO users')) db.users.push({ id:a[0], username:a[1], display_name:a[2], pin_hash:a[3], salt:a[4], role:a[5], permissions:a[6], active:1, must_change_pin:1, failed_attempts:0, locked_until:0 });
        if (sql.startsWith('INSERT INTO sessions')) db.sessions.push({ token_hash:a[0], user_id:a[1], expires_at:a[2] });
        if (sql.startsWith('UPDATE users SET failed_attempts=0')) { const u=db.users.find(x=>x.id===a[0]); u.failed_attempts=0; u.locked_until=0; }
        if (sql.startsWith('UPDATE users SET pin_hash=')) { const u=db.users.find(x=>x.id===a[2]);u.pin_hash=a[0];u.salt=a[1];u.must_change_pin=0; }
        if (sql.startsWith('UPDATE users SET role=')) { const u=db.users.find(x=>x.id===a[3]);u.role=a[0];u.permissions=a[1];u.active=a[2]; }
        if (sql.startsWith('INSERT INTO app_meta')) db.meta.push({value:'1'});
        if (sql.startsWith('INSERT INTO records')) db.records.push({collection:a[0],id:a[1],data:a[2]});
        return { success:true };
      }
    };
  }
  async batch(statements) { for (const stmt of statements) await stmt.run(); }
}
const origin = 'https://wadi.example';
const env = { DB:new MockDB(), ADMIN_BOOTSTRAP_TOKEN:'a-very-long-one-time-secret', AUTH_PEPPER:'separate-long-secret', ASSETS:{fetch:()=>new Response('ok')} };
const call = async (path, method='GET', data, extra={}) => {
  const headers = { ...(method !== 'GET' ? { origin, 'content-type':'application/json' } : {}), ...(extra.headers || {}) };
  const request = new Request(origin + path, { method, headers, body:data && JSON.stringify(data) });
  const response = await worker.fetch(request, env);
  return { response, data:await response.json() };
};

test('visitor reads but cannot write or manage users', async () => {
  assert.equal((await call('/api/records')).response.status, 200);
  assert.equal((await call('/api/records/proposals/test', 'PUT', { title:'x' })).response.status, 403);
  assert.equal((await call('/api/members')).response.status, 403);
});
test('bootstrap requires private token; Samia must change first PIN before editing', async () => {
  assert.equal((await call('/api/bootstrap','POST',{}, {headers:{'x-bootstrap-token':'wrong'}})).response.status,403);
  assert.equal((await call('/api/bootstrap','POST',{}, {headers:{'x-bootstrap-token':env.ADMIN_BOOTSTRAP_TOKEN}})).response.status,201);
  assert.equal(env.DB.users[0].username,'ساميه الرواحي');
  const login = await call('/api/login','POST',{username:'ساميه الرواحي',pin:'1234'});
  assert.equal(login.response.status,200);
  assert.equal(login.data.user.mustChangePin,true);
  const session = login.response.headers.get('set-cookie').split(';')[0];
  const headers = { headers:{ cookie:session } };
  assert.equal((await call('/api/records/proposals/test','PUT',{title:'x'},headers)).response.status,403);
  assert.equal((await call('/api/change-pin','POST',{oldPin:'1234',newPin:'long-new-pin-2026'},headers)).response.status,200);
  assert.equal((await call('/api/records/proposals/test','PUT',{title:'x'},headers)).response.status,200);
  assert.equal((await call('/api/members','POST',{username:'عضو',displayName:'عضو',pin:'1234',role:'member',permissions:{create:true,edit:false,delete:false,upload:false}},headers)).response.status,201);
  assert.equal(env.DB.users.length,2);
});
test('scoped member can create but cannot edit, delete, upload, or manage users', async () => {
  const login = await call('/api/login','POST',{username:'عضو',pin:'1234'});
  const session = login.response.headers.get('set-cookie').split(';')[0];
  const headers = { headers:{cookie:session} };
  assert.equal((await call('/api/change-pin','POST',{oldPin:'1234',newPin:'member-secret-2026'},headers)).response.status,200);
  assert.equal((await call('/api/records/proposals/new','PUT',{title:'new'},headers)).response.status,200);
  assert.equal((await call('/api/records/proposals/new','PUT',{title:'changed'},headers)).response.status,403);
  assert.equal((await call('/api/records/proposals/new','DELETE',null,headers)).response.status,403);
  assert.equal((await call('/api/members','GET',null,headers)).response.status,403);
  assert.equal((await call('/api/uploads','POST',{title:'fake'},headers)).response.status,403);
});
