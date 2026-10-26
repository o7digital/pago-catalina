import { randomBytes, randomUUID, randomInt, scryptSync, timingSafeEqual, createHash } from 'node:crypto';
import { rateLimit } from 'express-rate-limit';
import { createMailer } from './mail.mjs';

const hash = value => createHash('sha256').update(value).digest('hex');
const passwordHash = password => { const salt = randomBytes(16).toString('hex'); return salt + ':' + scryptSync(password, salt, 64).toString('hex'); };
const passwordMatches = (password, stored) => { const [salt, key] = stored.split(':'); return timingSafeEqual(scryptSync(password, salt, 64), Buffer.from(key, 'hex')); };
const safeEqual = (a, b) => typeof a === 'string' && typeof b === 'string' && Buffer.byteLength(a) === Buffer.byteLength(b) && timingSafeEqual(Buffer.from(a), Buffer.from(b));
const fail = (status, message) => Object.assign(new Error(message), { status });
const validPassword = password => typeof password === 'string' && password.length >= 12 && password.length <= 200;
const validEmail = email => typeof email === 'string' && email.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
const validToken = token => typeof token === 'string' && /^[a-f0-9]{64}$/.test(token);
const normalize = email => email.toLowerCase().trim();

export function installAuth(app, db, config) {
  const { production, origin, setupToken } = config;
  const mailer = config.mailer === undefined ? createMailer() : config.mailer;
  // Migrate the original owner and active sessions in one transaction, preserving password hashes.
  db.exec('BEGIN IMMEDIATE');
  try {
    db.exec(`CREATE TABLE IF NOT EXISTS users (id TEXT PRIMARY KEY, email TEXT NOT NULL UNIQUE COLLATE NOCASE, password TEXT NOT NULL, role TEXT NOT NULL, mfa INTEGER NOT NULL DEFAULT 0, verified INTEGER, created INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS invitations (token TEXT PRIMARY KEY, email TEXT NOT NULL COLLATE NOCASE, creator TEXT NOT NULL, expires INTEGER NOT NULL, used INTEGER, created INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS challenges (token TEXT PRIMARY KEY, user_id TEXT, purpose TEXT NOT NULL, code_hash TEXT NOT NULL, payload TEXT, expires INTEGER NOT NULL, attempts INTEGER NOT NULL DEFAULT 0, sent INTEGER NOT NULL DEFAULT 1, last_sent INTEGER NOT NULL);`);
    if (!db.prepare('PRAGMA table_info(sessions)').all().some(c => c.name === 'user_id')) {
      db.exec("ALTER TABLE sessions ADD COLUMN user_id TEXT; UPDATE sessions SET user_id='legacy-1';");
    }
    if (db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='admin'").get()) {
      db.exec("INSERT OR IGNORE INTO users SELECT 'legacy-1',lower(email),password,'owner',0,NULL,0 FROM admin; DROP TABLE admin;");
    }
    db.exec('COMMIT');
  } catch (error) { db.exec('ROLLBACK'); throw error; }
  const limiter = rateLimit({ windowMs: 15 * 60 * 1000, limit: 20, standardHeaders: 'draft-8', legacyHeaders: false, message: { error: 'Demasiados intentos. Inténtalo en 15 minutos.' } });
  const codeLimiter = rateLimit({ windowMs: 15 * 60 * 1000, limit: 40, standardHeaders: 'draft-8', legacyHeaders: false, message: { error: 'Demasiados intentos. Inténtalo en 15 minutos.' } });
  const adminExists = () => Boolean(db.prepare('SELECT id FROM users LIMIT 1').get());
  const cookie = (res, token, maxAge) => res.cookie('catalina_session', token, { httpOnly: true, secure: production, sameSite: 'strict', path: '/api/admin', maxAge });
  function startSession(res, userId) {
    db.prepare('DELETE FROM sessions WHERE expires < ?').run(Date.now());
    const token = randomBytes(32).toString('hex'), csrf = randomBytes(32).toString('hex');
    db.prepare('INSERT INTO sessions (token,csrf,expires,user_id) VALUES (?,?,?,?)').run(hash(token), csrf, Date.now() + 12 * 60 * 60 * 1000, userId);
    cookie(res, token, 12 * 60 * 60 * 1000); return csrf;
  }
  const userJSON = u => ({ id: u.id, email: u.email, role: u.role, mfaEnabled: Boolean(u.mfa), mailReady: Boolean(mailer) });
  function signedIn(res, user) { return { ...userJSON(user), csrf: startSession(res, user.id) }; }
  const authenticated = (req, res, next) => {
    const token = (req.headers.cookie || '').split(';').map(s => s.trim()).find(s => s.startsWith('catalina_session='))?.slice('catalina_session='.length);
    const session = token && db.prepare('SELECT * FROM sessions WHERE token=? AND expires>?').get(hash(token), Date.now());
    const user = session && db.prepare('SELECT * FROM users WHERE id=?').get(session.user_id);
    if (!user) return res.status(401).json({ error: 'Inicia sesión para continuar.' });
    if (!['GET', 'HEAD'].includes(req.method) && !safeEqual(req.get('x-csrf-token'), session.csrf)) return res.status(403).json({ error: 'Sesión inválida. Actualiza la página.' });
    req.session = session; req.user = user; next();
  };
  function invitation(token) {
    if (!validToken(token)) throw fail(400, 'Invitación inválida o caducada.');
    const invite = db.prepare('SELECT * FROM invitations WHERE token=? AND used IS NULL AND expires>?').get(hash(token), Date.now());
    if (!invite || db.prepare('SELECT id FROM users WHERE email=?').get(invite.email)) throw fail(400, 'Invitación inválida o caducada.');
    return invite;
  }
  async function deliver(email, code) {
    if (!mailer) throw fail(503, 'El envío de códigos no está configurado. Contacta con tu administrador.');
    try { await mailer.sendCode(email, code); }
    catch { throw fail(503, 'No se pudo enviar el código. Inténtalo más tarde.'); }
  }
  async function challenge(userId, purpose, email, payload = null) {
    if (!mailer) throw fail(503, 'El envío de códigos no está configurado. Contacta con tu administrador.');
    db.prepare('DELETE FROM challenges WHERE expires<?').run(Date.now());
    const previous = userId
      ? db.prepare('SELECT last_sent FROM challenges WHERE user_id=? AND purpose=? ORDER BY last_sent DESC LIMIT 1').get(userId, purpose)
      : db.prepare("SELECT last_sent FROM challenges WHERE purpose=? AND json_extract(payload,'$.invitation')=? ORDER BY last_sent DESC LIMIT 1").get(purpose, payload.invitation);
    if (previous && previous.last_sent > Date.now() - 60000) throw fail(429, 'Espera un minuto antes de solicitar otro código.');
    const token = randomBytes(32).toString('hex'), code = String(randomInt(100000, 1000000));
    if (userId) db.prepare('DELETE FROM challenges WHERE user_id=? AND purpose=?').run(userId, purpose);
    else db.prepare("DELETE FROM challenges WHERE purpose=? AND json_extract(payload,'$.invitation')=?").run(purpose, payload.invitation);
    // The raw challenge token is never stored: it salts the six-digit code against offline guessing.
    db.prepare('INSERT INTO challenges (token,user_id,purpose,code_hash,payload,expires,last_sent) VALUES (?,?,?,?,?,?,?)').run(hash(token), userId, purpose, hash(token + ':' + code), payload ? JSON.stringify(payload) : null, Date.now() + 10 * 60 * 1000, Date.now());
    try { await deliver(email, code); }
    catch (error) { db.prepare('DELETE FROM challenges WHERE token=?').run(hash(token)); throw error; }
    return { challenge: token, email, codeRequired: true };
  }
  app.get('/api/admin/status', (req, res) => res.json({ setupRequired: !adminExists(), setupAvailable: Boolean(setupToken) }));
  app.post('/api/admin/setup', limiter, (req, res) => {
    if (adminExists()) throw fail(409, 'La cuenta ya está creada. Inicia sesión.');
    if (!setupToken || !safeEqual(req.body.token, setupToken)) throw fail(403, 'Enlace de activación inválido.');
    const { email, password } = req.body;
    if (!validEmail(email) || !validPassword(password)) throw fail(400, 'Indica un correo y una contraseña de entre 12 y 200 caracteres.');
    const id = randomUUID();
    db.prepare('INSERT INTO users (id,email,password,role,created) VALUES (?,?,?,?,?)').run(id, normalize(email), passwordHash(password), 'owner', Date.now());
    res.status(201).json(signedIn(res, db.prepare('SELECT * FROM users WHERE id=?').get(id)));
  });
  app.post('/api/admin/login', limiter, async (req, res) => {
    const { email, password } = req.body;
    const user = validEmail(email) && db.prepare('SELECT * FROM users WHERE email=?').get(normalize(email));
    if (typeof password !== 'string' || password.length > 200 || !user || !passwordMatches(password, user.password)) throw fail(401, 'Correo o contraseña incorrectos.');
    if (user.mfa) return res.json(await challenge(user.id, 'login', user.email));
    res.json(signedIn(res, user));
  });
  app.get('/api/admin/invitation', (req, res) => { const i = invitation(req.query.token); res.json({ email: i.email, expires: i.expires }); });
  app.post('/api/admin/register', limiter, async (req, res) => {
    const i = invitation(req.body.token);
    if (!validPassword(req.body.password)) throw fail(400, 'Elige una contraseña de entre 12 y 200 caracteres.');
    res.json(await challenge(null, 'register', i.email, { invitation: i.token, password: passwordHash(req.body.password) }));
  });
  app.post('/api/admin/verify-code', codeLimiter, (req, res) => {
    const { challenge: token, code } = req.body;
    if (!validToken(token) || typeof code !== 'string' || !/^\d{6}$/.test(code)) throw fail(400, 'Introduce el código de seis cifras.');
    const c = db.prepare('SELECT * FROM challenges WHERE token=?').get(hash(token));
    if (!c || c.expires < Date.now() || c.attempts >= 5) throw fail(400, 'El código ha caducado o está bloqueado. Solicita uno nuevo.');
    db.prepare('UPDATE challenges SET attempts=attempts+1 WHERE token=?').run(c.token);
    if (!safeEqual(c.code_hash, hash(token + ':' + code))) throw fail(400, 'Código incorrecto.');
    let userId = c.user_id;
    db.exec('BEGIN IMMEDIATE');
    try {
      if (c.purpose === 'register') {
        const payload = JSON.parse(c.payload);
        const i = db.prepare('SELECT * FROM invitations WHERE token=? AND used IS NULL AND expires>?').get(payload.invitation, Date.now());
        if (!i || db.prepare('SELECT id FROM users WHERE email=?').get(i.email)) throw fail(400, 'Invitación inválida o caducada.');
        userId = randomUUID();
        db.prepare('INSERT INTO users VALUES (?,?,?,?,?,?,?)').run(userId, i.email, payload.password, 'admin', 1, Date.now(), Date.now());
        db.prepare('UPDATE invitations SET used=? WHERE token=?').run(Date.now(), i.token);
        db.prepare("DELETE FROM challenges WHERE purpose='register' AND json_extract(payload,'$.invitation')=?").run(i.token);
      } else if (c.purpose === 'enroll') {
        db.prepare('UPDATE users SET mfa=1,verified=? WHERE id=?').run(Date.now(), userId);
        db.prepare('DELETE FROM sessions WHERE user_id=?').run(userId);
        db.prepare('DELETE FROM challenges WHERE user_id=?').run(userId);
      }
      db.prepare('DELETE FROM challenges WHERE token=?').run(c.token);
      const user = db.prepare('SELECT * FROM users WHERE id=?').get(userId);
      if (!user) throw fail(400, 'Cuenta no disponible.');
      const data = signedIn(res, user);
      db.exec('COMMIT'); res.json(data);
    } catch (error) { db.exec('ROLLBACK'); throw error; }
  });
  app.post('/api/admin/resend-code', limiter, async (req, res) => {
    const token = req.body.challenge;
    if (!validToken(token)) throw fail(400, 'Solicitud inválida.');
    const c = db.prepare('SELECT * FROM challenges WHERE token=?').get(hash(token));
    if (!c || c.expires < Date.now() || c.attempts >= 5 || c.sent >= 3) throw fail(400, 'Solicita un nuevo acceso.');
    if (c.last_sent > Date.now() - 60000) throw fail(429, 'Espera un minuto antes de reenviar el código.');
    let email;
    if (c.purpose === 'register') {
      const i = db.prepare('SELECT email FROM invitations WHERE token=? AND used IS NULL AND expires>?').get(JSON.parse(c.payload).invitation, Date.now());
      email = i?.email;
    } else email = db.prepare('SELECT email FROM users WHERE id=?').get(c.user_id)?.email;
    if (!email) throw fail(400, 'Solicitud inválida.');
    let code;
    do { code = String(randomInt(100000, 1000000)); } while (safeEqual(c.code_hash, hash(token + ':' + code)));
    db.prepare('UPDATE challenges SET code_hash=?,sent=sent+1,last_sent=? WHERE token=?').run(hash(token + ':' + code), Date.now(), c.token);
    await deliver(email, code); res.json({ ok: true });
  });
  app.use('/api/admin', authenticated);
  app.get('/api/admin/me', (req, res) => res.json({ ...userJSON(req.user), csrf: req.session.csrf }));
  app.post('/api/admin/logout', (req, res) => { db.prepare('DELETE FROM sessions WHERE token=?').run(req.session.token); cookie(res, '', 0); res.json({ ok: true }); });
  app.put('/api/admin/password', limiter, (req, res) => {
    const { currentPassword, password } = req.body;
    if (typeof currentPassword !== 'string' || currentPassword.length > 200 || !passwordMatches(currentPassword, req.user.password)) throw fail(400, 'La contraseña actual no es correcta.');
    if (!validPassword(password)) throw fail(400, 'La nueva contraseña debe tener entre 12 y 200 caracteres.');
    db.prepare('UPDATE users SET password=? WHERE id=?').run(passwordHash(password), req.user.id);
    db.prepare('DELETE FROM sessions WHERE user_id=?').run(req.user.id);
    db.prepare('DELETE FROM challenges WHERE user_id=?').run(req.user.id);
    res.json({ csrf: startSession(res, req.user.id) });
  });
  app.post('/api/admin/mfa/start', limiter, async (req, res) => {
    if (req.user.mfa) throw fail(409, 'La verificación por correo ya está activada.');
    if (typeof req.body.password !== 'string' || req.body.password.length > 200 || !passwordMatches(req.body.password, req.user.password)) throw fail(400, 'Confirma tu contraseña actual.');
    res.json(await challenge(req.user.id, 'enroll', req.user.email));
  });
  const owner = (req, res, next) => req.user.role === 'owner' ? next() : res.status(403).json({ error: 'Solo el propietario puede gestionar las invitaciones.' });
  app.get('/api/admin/users', owner, (req, res) => res.json(db.prepare('SELECT * FROM users ORDER BY created').all().map(userJSON)));
  app.get('/api/admin/invitations', owner, (req, res) => res.json(db.prepare('SELECT token,email,expires,created FROM invitations WHERE used IS NULL AND expires>? ORDER BY created DESC').all(Date.now()).map(i => ({ id: i.token, email: i.email, expires: i.expires }))));
  app.post('/api/admin/invitations', owner, (req, res) => {
    if (!validEmail(req.body.email)) throw fail(400, 'Indica el correo de la persona invitada.');
    const email = normalize(req.body.email);
    if (db.prepare('SELECT id FROM users WHERE email=?').get(email)) throw fail(409, 'Esta persona ya tiene una cuenta.');
    const token = randomBytes(32).toString('hex');
    db.prepare('UPDATE invitations SET used=? WHERE email=? AND used IS NULL').run(Date.now(), email);
    const expires = Date.now() + 48 * 60 * 60 * 1000;
    db.prepare('INSERT INTO invitations VALUES (?,?,?,?,NULL,?)').run(hash(token), email, req.user.id, expires, Date.now());
    res.status(201).json({ url: origin + '/admin#invite=' + token, email, expires });
  });
  app.delete('/api/admin/invitations/:id', owner, (req, res) => {
    db.prepare('UPDATE invitations SET used=? WHERE token=? AND used IS NULL').run(Date.now(), req.params.id); res.json({ ok: true });
  });
}
