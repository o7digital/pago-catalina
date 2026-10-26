import express from 'express';
import { rateLimit } from 'express-rate-limit';
import Stripe from 'stripe';
import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { installAuth } from './auth.mjs';
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

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
  // Trust only the explicitly configured private reverse-proxy network.
  app.set('trust proxy', config.trustedProxy || process.env.TRUSTED_PROXY || 'loopback');
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
  const checkoutLimiter = rateLimit({ windowMs: 60 * 1000, limit: 15, standardHeaders: 'draft-8', legacyHeaders: false, message: { error: 'Espera un momento antes de volver a intentar.' } });
  app.get('/api/health', (req, res) => res.json({ ok: true }));
  app.get('/api/config', (req, res) => res.json({ checkoutEnabled: ready, testMode: ready && !secret?.startsWith('sk_live_') }));
  const packageJSON = p => ({ id: p.id, name: p.name, description: p.description, price: p.cents / 100, active: Boolean(p.active) });
  app.get('/api/packages', (req, res) => res.json(db.prepare('SELECT * FROM packages WHERE active=1 ORDER BY created,id').all().map(packageJSON)));
  installAuth(app, db, { production, origin, setupToken, mailer: config.mailer });
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
