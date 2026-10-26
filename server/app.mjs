import express from 'express';
import { rateLimit } from 'express-rate-limit';
import Stripe from 'stripe';
import { DatabaseSync } from 'node:sqlite';
import { randomBytes, randomUUID, scryptSync, timingSafeEqual, createHash } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

const hash = value => createHash('sha256').update(value).digest('hex');
const passwordHash = password => { const salt = randomBytes(16).toString('hex'); return salt + ':' + scryptSync(password, salt, 64).toString('hex'); };
const passwordMatches = (password, stored) => { const [salt, key] = stored.split(':'); return timingSafeEqual(scryptSync(password, salt, 64), Buffer.from(key, 'hex')); };
const safeEqual = (a, b) => typeof a === 'string' && typeof b === 'string' && Buffer.byteLength(a) === Buffer.byteLength(b) && timingSafeEqual(Buffer.from(a), Buffer.from(b));
const fail = (status, message) => Object.assign(new Error(message), { status });
const money = value => Number.isFinite(value) && Math.round(value * 100) >= 100 && Math.round(value * 100) <= 99999999 && Math.abs(value * 100 - Math.round(value * 100)) < 0.00001;

export function createApp(config = {}) {
  const production = config.production ?? process.env.NODE_ENV === 'production';
  const origin = config.origin || process.env.PUBLIC_ORIGIN || 'http://localhost:3000';
  const setupToken = config.setupToken ?? process.env.ADMIN_SETUP_TOKEN;
  const path = config.database || process.env.DATABASE_PATH || './data/catalina.sqlite';
  if (path !== ':memory:') mkdirSync(dirname(resolve(path)), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;
    CREATE TABLE IF NOT EXISTS admin (id INTEGER PRIMARY KEY CHECK(id=1), email TEXT NOT NULL, password TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS sessions (token TEXT PRIMARY KEY, csrf TEXT NOT NULL, expires INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS packages (id TEXT PRIMARY KEY, name TEXT NOT NULL, description TEXT NOT NULL, cents INTEGER NOT NULL, active INTEGER NOT NULL, created INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS orders (id TEXT PRIMARY KEY, session_id TEXT UNIQUE, payment_intent TEXT, package_id TEXT, name TEXT NOT NULL, quantity INTEGER NOT NULL, cents INTEGER NOT NULL, status TEXT NOT NULL, customer TEXT, email TEXT, refunded INTEGER NOT NULL DEFAULT 0, created INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS events (id TEXT PRIMARY KEY, created INTEGER NOT NULL);`);
  const secret = config.stripeSecret ?? process.env.STRIPE_SECRET_KEY;
  const webhookSecret = config.webhookSecret ?? process.env.STRIPE_WEBHOOK_SECRET;
  const stripe = config.stripe || (secret ? new Stripe(secret, { maxNetworkRetries: 2, timeout: 15000 }) : null);
  const ready = Boolean(stripe && webhookSecret);
  const app = express();
  app.disable('x-powered-by');
  // One local reverse proxy; never trust client-supplied forwarding chains.
  app.set('trust proxy', 'loopback');
  app.use((req, res, next) => {
    res.set({ 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer', 'X-Frame-Options': 'DENY', 'Content-Security-Policy': "default-src 'self'; style-src 'self' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com; img-src 'self' data:; frame-ancestors 'none'; base-uri 'self'; form-action 'self'" });
    if (production) res.set('Strict-Transport-Security', 'max-age=31536000');
    next();
  });
  app.post('/api/stripe/webhook', express.raw({ type: 'application/json', limit: '1mb' }), async (req, res, next) => {
    if (!ready) return res.status(503).json({ error: 'Stripe todavía no está configurado.' });
    let event;
    try { event = stripe.webhooks.constructEvent(req.body, req.get('stripe-signature'), webhookSecret); }
    catch { return res.status(400).json({ error: 'Firma de Stripe inválida.' }); }
    try {
      if (db.prepare('SELECT id FROM events WHERE id=?').get(event.id)) return res.json({ received: true });
      const object = event.data.object;
      // Retrieve the current Stripe state so delayed/out-of-order events cannot undo a payment.
      let session;
      if (['checkout.session.completed', 'checkout.session.async_payment_succeeded', 'checkout.session.async_payment_failed', 'checkout.session.expired'].includes(event.type)) {
        session = await stripe.checkout.sessions.retrieve(object.id, { expand: ['payment_intent.latest_charge'] });
      }
      db.exec('BEGIN IMMEDIATE');
      try {
        if (session) {
          const order = db.prepare('SELECT * FROM orders WHERE session_id=?').get(session.id) || db.prepare('SELECT * FROM orders WHERE id=? AND session_id IS NULL').get(session.metadata?.order_id || '');
          if (order && session.amount_total === order.cents && session.currency === 'mxn') {
            const refunded = session.payment_intent?.latest_charge?.amount_refunded || 0;
            const status = refunded >= order.cents ? 'refunded' : refunded > 0 ? 'partially_refunded' : session.payment_status === 'paid' ? 'paid' : session.status === 'expired' ? 'expired' : event.type === 'checkout.session.async_payment_failed' ? 'failed' : 'pending';
            db.prepare(`UPDATE orders SET session_id=?, payment_intent=?, status=CASE WHEN status IN ('paid','refunded','partially_refunded') THEN status ELSE ? END, customer=?, email=?, refunded=MAX(refunded,?) WHERE id=?`).run(session.id, typeof session.payment_intent === 'string' ? session.payment_intent : session.payment_intent?.id || null, status, session.customer_details?.name || null, session.customer_details?.email || null, refunded, order.id);
          }
        }
        if (event.type === 'charge.refunded') {
          const intent = typeof object.payment_intent === 'string' ? object.payment_intent : object.payment_intent?.id;
          if (intent) db.prepare(`UPDATE orders SET refunded=MAX(refunded,?), status=CASE WHEN MAX(refunded,?) >= cents THEN 'refunded' ELSE 'partially_refunded' END WHERE payment_intent=?`).run(object.amount_refunded, object.amount_refunded, intent);
        }
        db.prepare('INSERT INTO events VALUES (?,?)').run(event.id, Date.now());
        db.exec('COMMIT');
      } catch (error) { db.exec('ROLLBACK'); throw error; }
      res.json({ received: true });
    } catch (error) { next(error); }
  });
  app.use(express.json({ limit: '16kb' }));
  app.use('/api', (req, res, next) => {
    if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method) && req.get('origin') !== origin) return res.status(403).json({ error: 'Origen no autorizado.' });
    next();
  });
  const authLimiter = rateLimit({ windowMs: 15 * 60 * 1000, limit: 10, standardHeaders: 'draft-8', legacyHeaders: false, message: { error: 'Demasiados intentos. Inténtalo en 15 minutos.' } });
  const checkoutLimiter = rateLimit({ windowMs: 60 * 1000, limit: 15, standardHeaders: 'draft-8', legacyHeaders: false, message: { error: 'Espera un momento antes de volver a intentar.' } });
  const adminExists = () => Boolean(db.prepare('SELECT id FROM admin WHERE id=1').get());
  const cookie = (res, token, maxAge) => res.cookie('catalina_session', token, { httpOnly: true, secure: production, sameSite: 'strict', path: '/api/admin', maxAge });
  function startSession(res) {
    db.prepare('DELETE FROM sessions WHERE expires < ?').run(Date.now());
    const token = randomBytes(32).toString('hex'), csrf = randomBytes(32).toString('hex');
    db.prepare('INSERT INTO sessions VALUES (?,?,?)').run(hash(token), csrf, Date.now() + 12 * 60 * 60 * 1000);
    cookie(res, token, 12 * 60 * 60 * 1000);
    return csrf;
  }
  const authenticated = (req, res, next) => {
    const token = (req.headers.cookie || '').split(';').map(s => s.trim()).find(s => s.startsWith('catalina_session='))?.slice('catalina_session='.length);
    const session = token && db.prepare('SELECT * FROM sessions WHERE token=? AND expires>?').get(hash(token), Date.now());
    if (!session) return res.status(401).json({ error: 'Inicia sesión para continuar.' });
    if (!['GET', 'HEAD'].includes(req.method) && !safeEqual(req.get('x-csrf-token'), session.csrf)) return res.status(403).json({ error: 'Sesión inválida. Actualiza la página.' });
    req.session = session;
    next();
  };
  app.get('/api/health', (req, res) => res.json({ ok: true }));
  app.get('/api/config', (req, res) => res.json({ checkoutEnabled: ready, testMode: ready && !secret?.startsWith('sk_live_') }));
  const packageJSON = p => ({ id: p.id, name: p.name, description: p.description, price: p.cents / 100, active: Boolean(p.active) });
  app.get('/api/packages', (req, res) => res.json(db.prepare('SELECT * FROM packages WHERE active=1 ORDER BY created,id').all().map(packageJSON)));
  app.get('/api/admin/status', (req, res) => res.json({ setupRequired: !adminExists(), setupAvailable: Boolean(setupToken) }));
  app.post('/api/admin/setup', authLimiter, (req, res) => {
    if (adminExists()) throw fail(409, 'La cuenta ya está creada. Inicia sesión.');
    if (!setupToken || !safeEqual(req.body.token, setupToken)) throw fail(403, 'Enlace de activación inválido.');
    const { email, password } = req.body;
    if (typeof email !== 'string' || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 254 || typeof password !== 'string' || password.length < 12 || password.length > 200) throw fail(400, 'Indica un correo y una contraseña de entre 12 y 200 caracteres.');
    db.prepare('INSERT INTO admin VALUES (1,?,?)').run(email.toLowerCase().trim(), passwordHash(password));
    res.status(201).json({ csrf: startSession(res), email: email.toLowerCase().trim() });
  });
  app.post('/api/admin/login', authLimiter, (req, res) => {
    const { email, password } = req.body;
    const admin = db.prepare('SELECT * FROM admin WHERE id=1').get();
    if (typeof email !== 'string' || typeof password !== 'string' || password.length > 200 || !admin || !passwordMatches(password, admin.password) || email.toLowerCase().trim() !== admin.email) throw fail(401, 'Correo o contraseña incorrectos.');
    res.json({ csrf: startSession(res), email: admin.email });
  });
  app.use('/api/admin', (req, res, next) => authenticated(req, res, next));
  app.get('/api/admin/me', (req, res) => res.json({ email: db.prepare('SELECT email FROM admin WHERE id=1').get().email, csrf: req.session.csrf }));
  app.post('/api/admin/logout', (req, res) => { db.prepare('DELETE FROM sessions WHERE token=?').run(req.session.token); cookie(res, '', 0); res.json({ ok: true }); });
  app.put('/api/admin/password', authLimiter, (req, res) => {
    const admin = db.prepare('SELECT * FROM admin WHERE id=1').get();
    const { currentPassword, password } = req.body;
    if (typeof currentPassword !== 'string' || currentPassword.length > 200 || !passwordMatches(currentPassword, admin.password)) throw fail(400, 'La contraseña actual no es correcta.');
    if (typeof password !== 'string' || password.length < 12 || password.length > 200) throw fail(400, 'La nueva contraseña debe tener entre 12 y 200 caracteres.');
    db.prepare('UPDATE admin SET password=? WHERE id=1').run(passwordHash(password));
    db.prepare('DELETE FROM sessions').run();
    res.json({ csrf: startSession(res) });
  });
  app.get('/api/admin/packages', (req, res) => res.json(db.prepare('SELECT * FROM packages ORDER BY created,id').all().map(packageJSON)));
  function validatePackage(body) {
    const { name, description, price, active } = body;
    if (typeof name !== 'string' || !name.trim() || name.length > 60 || typeof description !== 'string' || !description.trim() || description.length > 180 || !money(price) || typeof active !== 'boolean') throw fail(400, 'Revisa el nombre, descripción y precio (1 a 999,999.99 MXN, máximo dos decimales).');
    return [name.trim(), description.trim(), Math.round(price * 100), Number(active)];
  }
  app.post('/api/admin/packages', (req, res) => {
    const values = validatePackage(req.body), id = randomUUID();
    db.prepare('INSERT INTO packages VALUES (?,?,?,?,?,?)').run(id, ...values, Date.now());
    res.status(201).json({ id });
  });
  app.put('/api/admin/packages/:id', (req, res) => {
    const values = validatePackage(req.body);
    if (!db.prepare('UPDATE packages SET name=?,description=?,cents=?,active=? WHERE id=?').run(...values, req.params.id).changes) throw fail(404, 'Paquete no encontrado.');
    res.json({ ok: true });
  });
  app.delete('/api/admin/packages/:id', (req, res) => {
    if (!db.prepare('DELETE FROM packages WHERE id=?').run(req.params.id).changes) throw fail(404, 'Paquete no encontrado.');
    res.json({ ok: true });
  });
  app.get('/api/admin/orders', (req, res) => res.json(db.prepare('SELECT * FROM orders ORDER BY created DESC LIMIT 1000').all().map(o => ({ id: o.id, name: o.customer || 'Cliente pendiente', email: o.email || '', package: o.name, quantity: o.quantity, amount: o.cents / 100, refunded: o.refunded / 100, status: o.status, date: new Date(o.created).toISOString() }))));
  app.get('/api/admin/connection', (req, res) => res.json({ checkoutEnabled: ready, secretConfigured: Boolean(stripe), webhookConfigured: Boolean(webhookSecret), testMode: ready && !secret?.startsWith('sk_live_'), webhookUrl: origin + '/api/stripe/webhook' }));
  app.post('/api/checkout', checkoutLimiter, async (req, res) => {
    if (!ready) throw fail(503, 'Los pagos aún no están disponibles. Contacta con Catalina.');
    let name, cents, packageId = null, quantity = 1;
    if (req.body.packageId) {
      const p = db.prepare('SELECT * FROM packages WHERE id=? AND active=1').get(String(req.body.packageId));
      if (!p) throw fail(400, 'Este paquete ya no está disponible. Actualiza la página.');
      quantity = req.body.quantity;
      if (!Number.isInteger(quantity) || quantity < 1 || quantity > 99) throw fail(400, 'Cantidad inválida.');
      name = p.name; cents = p.cents; packageId = p.id;
    } else {
      if (!money(req.body.amount)) throw fail(400, 'Monto inválido.');
      name = 'Monto libre'; cents = Math.round(req.body.amount * 100);
    }
    if (cents * quantity > 99999999) throw fail(400, 'El total no puede superar 999,999.99 MXN.');
    const id = randomUUID();
    db.prepare('INSERT INTO orders (id,package_id,name,quantity,cents,status,created) VALUES (?,?,?,?,?,?,?)').run(id, packageId, name, quantity, cents * quantity, 'pending', Date.now());
    try {
      const session = await stripe.checkout.sessions.create({ mode: 'payment', payment_method_types: ['card'], line_items: [{ price_data: { currency: 'mxn', product_data: { name }, unit_amount: cents }, quantity }], metadata: { order_id: id }, payment_intent_data: { metadata: { order_id: id } }, client_reference_id: id, success_url: origin + '/?payment=success', cancel_url: origin + '/?payment=cancelled' }, { idempotencyKey: id });
      db.prepare('UPDATE orders SET session_id=? WHERE id=?').run(session.id, id);
      res.json({ url: session.url });
    } catch (error) { db.prepare("UPDATE orders SET status='failed' WHERE id=? AND status='pending'").run(id); throw error; }
  });
  app.use('/api', (req, res) => res.status(404).json({ error: 'Ruta no encontrada.' }));
  app.get('/admin', (req, res) => res.sendFile(resolve('public/admin.html')));
  app.use(express.static(resolve('public'), { etag: false }));
  app.use((error, req, res, next) => {
    const status = error.status || 500;
    if (status >= 500) console.error('Request failed:', error.type || error.code || error.name);
    res.status(status).json({ error: status >= 500 && !error.status ? 'No se pudo completar la operación. Inténtalo de nuevo.' : error.message });
  });
  return { app, db };
}
