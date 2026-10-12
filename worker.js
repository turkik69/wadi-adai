// Cloudflare Worker: same-origin API, D1 records/accounts/chunked uploads.
const collections = new Set(['proposals', 'recommendations', 'stations', 'analyses', 'roadmap', 'observations', 'gallery']);
const permissionNames = ['create', 'edit', 'delete', 'upload', 'manage_members'];
const enc = new TextEncoder();
const json = (data, status = 200, headers = {}) => new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...headers } });
const fail = (message, status = 400) => json({ error: message }, status);
const bytesHex = bytes => [...new Uint8Array(bytes)].map(x => x.toString(16).padStart(2, '0')).join('');
const digest = async text => bytesHex(await crypto.subtle.digest('SHA-256', enc.encode(text)));
const random = (n = 32) => bytesHex(crypto.getRandomValues(new Uint8Array(n)));
const normalized = value => String(value || '').trim().toLocaleLowerCase('ar').replace(/\s+/g, ' ');
async function pinHash(pin, salt, env) {
  if (!env.AUTH_PEPPER) throw new Error('Missing authentication secret');
  const pepper = await crypto.subtle.importKey('raw', enc.encode(env.AUTH_PEPPER), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const protectedPin = await crypto.subtle.sign('HMAC', pepper, enc.encode(pin));
  const key = await crypto.subtle.importKey('raw', protectedPin, 'PBKDF2', false, ['deriveBits']);
  return bytesHex(await crypto.subtle.deriveBits({ name: 'PBKDF2', salt: enc.encode(salt), iterations: 25000, hash: 'SHA-256' }, key, 256));
}
function equal(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0; for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
const cookie = (token, age) => `wadi_session=${token}; HttpOnly; Secure; SameSite=Strict; Path=/api; Max-Age=${age}`;
async function bodyJSON(req) {
  if (Number(req.headers.get('content-length') || 0) > 100000) throw new Error('حجم الطلب كبير.');
  return await req.json();
}
async function currentUser(req, env) {
  const token = /(?:^|;\s*)wadi_session=([a-f0-9]{64})/.exec(req.headers.get('cookie') || '')?.[1];
  if (!token) return null;
  const row = await env.DB.prepare(`SELECT u.*, s.token_hash FROM sessions s JOIN users u ON u.id=s.user_id
    WHERE s.token_hash=? AND s.expires_at>? AND u.active=1`).bind(await digest(token), Date.now()).first();
  return row || null;
}
const can = (user, permission) => !!user && !user.must_change_pin && (user.role === 'admin' || JSON.parse(user.permissions || '{}')[permission] === true);
function publicUser(user) {
  if (!user) return null;
  return { id: user.id, username: user.username, displayName: user.display_name, role: user.role,
    permissions: user.role === 'admin' ? Object.fromEntries(permissionNames.map(p => [p, true])) : JSON.parse(user.permissions || '{}'),
    mustChangePin: !!user.must_change_pin };
}
function checkOrigin(req) {
  const origin = req.headers.get('origin');
  return origin === new URL(req.url).origin;
}
function permissionObject(raw) {
  return Object.fromEntries(permissionNames.map(key => [key, raw?.[key] === true]));
}
async function route(req, env) {
  const url = new URL(req.url), path = url.pathname, method = req.method;
  if (method !== 'GET' && method !== 'HEAD' && !checkOrigin(req)) return fail('طلب من مصدر غير معتمد.', 403);
  if (path === '/api/status' && method === 'GET') {
    const count = await env.DB.prepare('SELECT count(*) AS n FROM users').first();
    return json({ ready: !!count.n, provider: 'Cloudflare Workers + D1' });
  }
  if (path === '/api/bootstrap' && method === 'POST') {
    if (!env.ADMIN_BOOTSTRAP_TOKEN || (await env.DB.prepare('SELECT id FROM users LIMIT 1').first())) return fail('تم تهيئة الأدمن مسبقًا.', 403);
    const supplied = req.headers.get('x-bootstrap-token') || '';
    if (!equal(await digest(supplied), await digest(env.ADMIN_BOOTSTRAP_TOKEN))) return fail('رمز التهيئة غير صحيح.', 403);
    const salt = random(16);
    await env.DB.prepare('INSERT INTO users (id,username,display_name,pin_hash,salt,role,permissions) VALUES (?,?,?,?,?,?,?)')
      .bind(crypto.randomUUID(), normalized('ساميه الرواحي'), 'ساميه الرواحي', await pinHash('1234', salt, env), salt, 'admin', '{}').run();
    return json({ ok: true, message: 'أُنشئ حساب ساميه الرواحي. غيّري الرمز عند أول دخول.' }, 201);
  }
  if (path === '/api/login' && method === 'POST') {
    const { username, pin } = await bodyJSON(req);
    const name = normalized(username), now = Date.now();
    const ip = await digest(req.headers.get('cf-connecting-ip') || 'unknown');
    const limit = await env.DB.prepare('SELECT * FROM login_limits WHERE ip_hash=?').bind(ip).first();
    if (limit && limit.window_until > now && limit.attempts >= 20) return fail('محاولات كثيرة. حاول بعد ساعة.', 429);
    const user = await env.DB.prepare('SELECT * FROM users WHERE username=?').bind(name).first();
    if (user?.locked_until > now) return fail('الحساب مقفل مؤقتًا بعد محاولات غير صحيحة.', 429);
    const valid = user?.active && typeof pin === 'string' && equal(await pinHash(pin, user.salt, env), user.pin_hash);
    if (!valid) {
      await env.DB.prepare(`INSERT INTO login_limits (ip_hash,attempts,window_until) VALUES (?,1,?)
        ON CONFLICT(ip_hash) DO UPDATE SET attempts=CASE WHEN window_until<? THEN 1 ELSE attempts+1 END,
        window_until=CASE WHEN window_until<? THEN excluded.window_until ELSE window_until END`)
        .bind(ip, now + 3600000, now, now).run();
      if (user?.active) await env.DB.prepare('UPDATE users SET failed_attempts=failed_attempts+1,locked_until=CASE WHEN failed_attempts>=4 THEN ? ELSE locked_until END WHERE id=?')
        .bind(now + 15 * 60000, user.id).run();
      return fail('اسم المستخدم أو الرمز غير صحيح.', 401);
    }
    await env.DB.prepare('UPDATE users SET failed_attempts=0,locked_until=0 WHERE id=?').bind(user.id).run();
    const token = random(), expires = now + 7 * 86400000;
    await env.DB.prepare('INSERT INTO sessions (token_hash,user_id,expires_at) VALUES (?,?,?)').bind(await digest(token), user.id, expires).run();
    return json({ user: publicUser(user) }, 200, { 'set-cookie': cookie(token, 7 * 86400) });
  }
  const user = await currentUser(req, env);
  if (path === '/api/me' && method === 'GET') return json({ user: publicUser(user) });
  if (path === '/api/logout' && method === 'POST') {
    if (user) await env.DB.prepare('DELETE FROM sessions WHERE token_hash=?').bind(user.token_hash).run();
    return json({ ok: true }, 200, { 'set-cookie': cookie('', 0) });
  }
  if (path === '/api/change-pin' && method === 'POST') {
    if (!user) return fail('سجل الدخول أولًا.', 401);
    const { oldPin, newPin } = await bodyJSON(req);
    if (typeof oldPin !== 'string' || !equal(await pinHash(oldPin, user.salt, env), user.pin_hash)) return fail('الرمز الحالي غير صحيح.', 403);
    if (typeof newPin !== 'string' || newPin.length < 8 || newPin.length > 128 || newPin === '1234') return fail('اختر رمزًا جديدًا من 8 أحرف أو أرقام على الأقل.');
    const salt = random(16);
    await env.DB.batch([
      env.DB.prepare('UPDATE users SET pin_hash=?,salt=?,must_change_pin=0 WHERE id=?').bind(await pinHash(newPin, salt, env), salt, user.id),
      env.DB.prepare('DELETE FROM sessions WHERE user_id=? AND token_hash<>?').bind(user.id, user.token_hash)
    ]);
    return json({ ok: true });
  }
  if (path === '/api/records' && method === 'GET') {
    const rows = await env.DB.prepare('SELECT collection,id,data FROM records ORDER BY collection,id').all();
    const seeded = await env.DB.prepare("SELECT value FROM app_meta WHERE key='study_seeded'").first();
    const groups = {};
    for (const row of rows.results) (groups[row.collection] ||= []).push(JSON.parse(row.data));
    return json({ records: groups, initialized: !!seeded || rows.results.length > 0 });
  }
  if (path === '/api/seed' && method === 'POST') {
    if (!can(user, 'create')) return fail('لا تملك صلاحية الإضافة.', 403);
    const existing = await env.DB.prepare("SELECT value FROM app_meta WHERE key='study_seeded'").first();
    if (existing || await env.DB.prepare('SELECT id FROM records LIMIT 1').first()) return fail('البيانات موجودة بالفعل.', 409);
    const { records } = await bodyJSON(req), writes = [];
    for (const [collection, entries] of Object.entries(records || {})) {
      if (!collections.has(collection) || !Array.isArray(entries) || entries.length > 150) return fail('بيانات التهيئة غير صالحة.');
      for (const entry of entries) {
        const id = String(entry.id || crypto.randomUUID());
        if (id.length > 120) return fail('معرّف غير صالح.');
        writes.push(env.DB.prepare('INSERT INTO records (collection,id,data,updated_by) VALUES (?,?,?,?)').bind(collection, id, JSON.stringify({ ...entry, id }), user.id));
      }
    }
    if (writes.length > 500) return fail('بيانات كثيرة.');
    writes.push(env.DB.prepare("INSERT INTO app_meta (key,value) VALUES ('study_seeded','1')"));
    await env.DB.batch(writes);
    return json({ ok: true, count: writes.length }, 201);
  }
  const record = /^\/api\/records\/([a-z]+)\/([\w.-]{1,120})$/.exec(path);
  if (record && ['PUT', 'DELETE'].includes(method)) {
    const [, collection, id] = record;
    if (!collections.has(collection)) return fail('القسم غير موجود.', 404);
    if (!can(user, method === 'PUT' ? (await env.DB.prepare('SELECT id FROM records WHERE collection=? AND id=?').bind(collection, id).first() ? 'edit' : 'create') : 'delete')) return fail('لا تملك هذه الصلاحية.', 403);
    if (method === 'DELETE') {
      const stored = await env.DB.prepare('SELECT data FROM records WHERE collection=? AND id=?').bind(collection, id).first();
      await env.DB.prepare('DELETE FROM records WHERE collection=? AND id=?').bind(collection, id).run();
      const attachments = stored ? JSON.parse(stored.data).attachments || [] : [];
      for (const attachment of attachments) {
        const uploadId = /^\/api\/files\/([a-f0-9-]{36})$/.exec(attachment.url || '')?.[1];
        if (uploadId) await env.DB.prepare('DELETE FROM uploads WHERE id=?').bind(uploadId).run();
      }
      return json({ ok: true });
    }
    const item = await bodyJSON(req);
    if (!item || typeof item !== 'object' || Array.isArray(item) || JSON.stringify(item).length > 70000 || !String(item.title || '').trim()) return fail('بيانات السجل غير صالحة.');
    if (item.attachments && (!Array.isArray(item.attachments) || item.attachments.length > 50 ||
      item.attachments.some(file => !file || typeof file.url !== 'string' ||
        !(/^(\/api\/files\/[a-f0-9-]{36}|\.\/assets\/[a-f0-9]{16}\.jpg)$/.test(file.url))))) return fail('روابط المرفقات غير صالحة.');
    await env.DB.prepare(`INSERT INTO records (collection,id,data,updated_by) VALUES (?,?,?,?)
      ON CONFLICT(collection,id) DO UPDATE SET data=excluded.data,updated_by=excluded.updated_by,updated_at=CURRENT_TIMESTAMP`)
      .bind(collection, id, JSON.stringify({ ...item, id }), user.id).run();
    return json({ ok: true, id });
  }
  if (path === '/api/members' && method === 'GET') {
    if (!can(user, 'manage_members')) return fail('غير مصرح.', 403);
    const rows = await env.DB.prepare('SELECT id,username,display_name,role,permissions,active,must_change_pin FROM users ORDER BY created_at').all();
    return json({ members: rows.results.map(row => ({ ...publicUser(row), active: !!row.active })) });
  }
  if (path === '/api/members' && method === 'POST') {
    if (!can(user, 'manage_members')) return fail('غير مصرح.', 403);
    const data = await bodyJSON(req), name = normalized(data.username), displayName = String(data.displayName || '').trim();
    if (!name || name.length > 80 || !displayName || displayName.length > 100 || data.pin !== '1234' || !['admin','member'].includes(data.role)) return fail('بيانات العضو غير صالحة. الرمز الأولي هو 1234.');
    const salt = random(16), id = crypto.randomUUID();
    await env.DB.prepare('INSERT INTO users (id,username,display_name,pin_hash,salt,role,permissions) VALUES (?,?,?,?,?,?,?)')
      .bind(id, name, displayName, await pinHash('1234', salt, env), salt, data.role, JSON.stringify(permissionObject(data.permissions))).run();
    return json({ ok: true, id }, 201);
  }
  const member = /^\/api\/members\/([a-f0-9-]{36})$/.exec(path);
  if (member && method === 'PATCH') {
    if (!can(user, 'manage_members')) return fail('غير مصرح.', 403);
    const data = await bodyJSON(req), id = member[1];
    if (!['admin','member'].includes(data.role) || typeof data.active !== 'boolean') return fail('صلاحيات غير صالحة.');
    if (id === user.id && (data.role !== 'admin' || !data.active)) return fail('لا يمكنك تعطيل صلاحية الأدمن الخاصة بك.');
    await env.DB.prepare('UPDATE users SET role=?,permissions=?,active=? WHERE id=?')
      .bind(data.role, JSON.stringify(permissionObject(data.permissions)), Number(data.active), id).run();
    if (!data.active) await env.DB.prepare('DELETE FROM sessions WHERE user_id=?').bind(id).run();
    return json({ ok: true });
  }
  if (path === '/api/uploads' && method === 'POST') {
    if (!can(user, 'upload')) return fail('لا تملك صلاحية الرفع.', 403);
    const size = Number(req.headers.get('content-length') || 0);
    if (!size || size > 10 * 1024 * 1024) return fail('الحد الأقصى للملف 10 ميجابايت.', 413);
    const mime = (req.headers.get('content-type') || '').split(';')[0].toLowerCase();
    const allowed = /^(image\/(jpeg|png|webp|gif)|application\/(pdf|msword|vnd\.openxmlformats-officedocument\.wordprocessingml\.document|vnd\.ms-excel|vnd\.openxmlformats-officedocument\.spreadsheetml\.sheet|vnd\.ms-powerpoint|vnd\.openxmlformats-officedocument\.presentationml\.presentation))$/;
    if (!allowed.test(mime)) return fail('نوع الملف غير مدعوم.');
    const filename = decodeURIComponent(req.headers.get('x-file-name') || 'مرفق').slice(0, 160).replace(/[<>]/g, '');
    const bytes = await req.arrayBuffer();
    if (bytes.byteLength > 10 * 1024 * 1024) return fail('الحد الأقصى للملف 10 ميجابايت.', 413);
    const id = crypto.randomUUID(), chunks = [env.DB.prepare('INSERT INTO uploads (id,name,mime,size,uploaded_by) VALUES (?,?,?,?,?)')
      .bind(id, filename, mime, bytes.byteLength, user.id)];
    for (let offset = 0, part = 0; offset < bytes.byteLength; offset += 512 * 1024, part++) {
      chunks.push(env.DB.prepare('INSERT INTO upload_chunks (upload_id,part,bytes) VALUES (?,?,?)')
        .bind(id, part, bytes.slice(offset, offset + 512 * 1024)));
    }
    await env.DB.batch(chunks);
    return json({ file: { id, name: filename, type: mime, url: `/api/files/${id}` } }, 201);
  }
  const file = /^\/api\/files\/([a-f0-9-]{36})$/.exec(path);
  if (file && method === 'GET') {
    const row = await env.DB.prepare('SELECT * FROM uploads WHERE id=?').bind(file[1]).first();
    if (!row) return fail('الملف غير موجود.', 404);
    const result = await env.DB.prepare('SELECT bytes FROM upload_chunks WHERE upload_id=? ORDER BY part').bind(file[1]).all();
    const payload = new Uint8Array(row.size); let offset = 0;
    for (const part of result.results) { const bytes = Uint8Array.from(part.bytes); payload.set(bytes, offset); offset += bytes.length; }
    if (offset !== row.size) return fail('الملف غير مكتمل.', 500);
    return new Response(payload, { headers: { 'content-type': row.mime, 'content-disposition': `inline; filename*=UTF-8''${encodeURIComponent(row.name)}`, 'x-content-type-options': 'nosniff', 'cache-control': 'public,max-age=3600' } });
  }
  return fail('المسار غير موجود.', 404);
}
export default {
  async fetch(request, env) {
    if (!new URL(request.url).pathname.startsWith('/api/')) return env.ASSETS.fetch(request);
    try { return await route(request, env); }
    catch (error) { console.error('API error', error?.message); return fail('تعذر تنفيذ الطلب. حاول مجددًا.', 500); }
  }
};
