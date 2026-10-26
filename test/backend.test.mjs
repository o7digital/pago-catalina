import { test } from 'node:test';
import assert from 'node:assert/strict';
import Stripe from 'stripe';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../server/app.mjs';

const origin = 'http://localhost:3000';
const token = 'private-test-activation-token';
const password = 'a-strong-private-password';
async function fixture(t, config = {}) {
  const { app, db } = createApp({ origin, setupToken: token, database: ':memory:', production: false, ...config });
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  let closed = false;
  async function close() { if (closed) return; closed = true; server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); db.close(); }
  t.after(close);
  let cookie = '', csrf = '';
  async function request(path, method = 'GET', body, options = {}) {
    const headers = { origin, 'Content-Type': 'application/json', cookie, 'x-csrf-token': csrf, ...options.headers };
    const res = await fetch(`http://127.0.0.1:${server.address().port}/api${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    const data = await res.json();
    if (res.headers.get('set-cookie')) cookie = res.headers.get('set-cookie').split(';')[0];
    if (data.csrf) csrf = data.csrf;
    return { status: res.status, data };
  }
  async function setup() { assert.equal((await request('/admin/setup', 'POST', { token, email: 'catalina@example.com', password })).status, 201); }
  return { request, setup, db, server, close, get csrf() { return csrf; } };
}
const pkg = { name: 'Sesión personal', description: 'Un espacio para ti.', price: 950.5, active: true };

test('private setup, login, CSRF, logout and credential rotation', async t => {
  const f = await fixture(t), r = f.request;
  assert.equal((await r('/admin/packages')).status, 401);
  assert.equal((await r('/admin/setup', 'POST', { token: 'wrong', email: 'catalina@example.com', password })).status, 403);
  await f.setup();
  assert.equal((await r('/admin/setup', 'POST', { token, email: 'other@example.com', password })).status, 409);
  assert.equal((await r('/admin/packages', 'POST', pkg, { headers: { origin: 'https://evil.example' } })).status, 403);
  assert.equal((await r('/admin/packages', 'POST', pkg, { headers: { 'x-csrf-token': 'wrong' } })).status, 403);
  assert.equal((await r('/admin/password', 'PUT', { currentPassword: password, password: 'new-password-12345' })).status, 200);
  assert.equal((await r('/admin/logout', 'POST')).status, 200);
  assert.equal((await r('/admin/me')).status, 401);
  assert.equal((await r('/admin/login', 'POST', { email: 'catalina@example.com', password })).status, 401);
  assert.equal((await r('/admin/login', 'POST', { email: 'catalina@example.com', password: 'new-password-12345' })).status, 200);
});

test('shared catalog CRUD validates prices, hides inactive packages, preserves order snapshots', async t => {
  const f = await fixture(t), r = f.request; await f.setup();
  assert.deepEqual((await r('/packages')).data, []);
  assert.equal((await r('/admin/packages', 'POST', { ...pkg, price: 1.001 })).status, 400);
  const created = await r('/admin/packages', 'POST', pkg); assert.equal(created.status, 201);
  const id = created.data.id;
  assert.equal((await r('/packages')).data[0].price, 950.5);
  assert.equal((await r('/admin/packages/' + id, 'PUT', { ...pkg, active: false })).status, 200);
  assert.deepEqual((await r('/packages')).data, []);
  assert.equal((await r('/admin/packages')).data.length, 1);
  assert.equal((await r('/admin/packages/' + id, 'DELETE')).status, 200);
  assert.deepEqual((await r('/admin/packages')).data, []);
  assert.equal((await r('/checkout', 'POST', { amount: 100 })).status, 503);
});

test('checkout uses stored prices, signed webhooks confirm once, refunds survive duplicate payments', async t => {
  const sdk = new Stripe('sk_test_placeholder'), webhookSecret = 'whsec_test_secret';
  let checkoutArgs, currentSession;
  const stripe = { webhooks: sdk.webhooks, checkout: { sessions: {
    create: async args => { checkoutArgs = args; return { id: 'cs_test_one', url: 'https://checkout.stripe.com/test' }; },
    retrieve: async () => currentSession
  } } };
  const f = await fixture(t, { stripe, stripeSecret: 'sk_test_placeholder', webhookSecret }); const r = f.request; await f.setup();
  const id = (await r('/admin/packages', 'POST', pkg)).data.id;
  assert.equal((await r('/checkout', 'POST', { packageId: id, quantity: 0 })).status, 400);
  assert.equal((await r('/checkout', 'POST', { packageId: id, quantity: 2, price: 1 })).status, 200);
  assert.equal(checkoutArgs.line_items[0].price_data.unit_amount, 95050);
  const order = f.db.prepare('SELECT * FROM orders').get(); assert.equal(order.cents, 190100); assert.equal(order.status, 'pending');
  const deliver = async (event, signature = true) => {
    const payload = JSON.stringify(event);
    const response = await fetch(`http://127.0.0.1:${f.server.address().port}/api/stripe/webhook`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'stripe-signature': signature ? sdk.webhooks.generateTestHeaderString({ payload, secret: webhookSecret }) : 'bad' }, body: payload });
    return response.status;
  };
  currentSession = { id: 'cs_test_one', amount_total: 190100, currency: 'mxn', payment_status: 'paid', status: 'complete', payment_intent: 'pi_test', metadata: { order_id: order.id }, customer_details: { name: 'Ana', email: 'ana@example.com' } };
  const event = { id: 'evt_paid', type: 'checkout.session.completed', data: { object: { id: 'cs_test_one' } } };
  assert.equal(await deliver(event, false), 400);
  assert.equal(f.db.prepare('SELECT status FROM orders').get().status, 'pending');
  assert.equal(await deliver(event), 200); assert.equal(await deliver(event), 200);
  assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM events').get().n, 1);
  assert.equal((await r('/admin/orders')).data[0].name, 'Ana');
  assert.equal(await deliver({ id: 'evt_refund', type: 'charge.refunded', data: { object: { payment_intent: 'pi_test', amount_refunded: 50000 } } }), 200);
  assert.equal(f.db.prepare('SELECT status FROM orders').get().status, 'partially_refunded');
  await deliver({ ...event, id: 'evt_delayed_paid' });
  assert.equal(f.db.prepare('SELECT status FROM orders').get().status, 'partially_refunded');
  await r('/admin/packages/' + id, 'DELETE');
  assert.equal((await r('/admin/orders')).data[0].package, pkg.name);
});


test('catalog and owner account persist across a backend restart', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'catalina-'));
  const database = join(directory, 'state.sqlite');
  const first = await fixture(t, { database });
  await first.setup();
  const id = (await first.request('/admin/packages', 'POST', pkg)).data.id;
  await first.close();
  const restarted = await fixture(t, { database });
  assert.equal((await restarted.request('/admin/status')).data.setupRequired, false);
  assert.equal((await restarted.request('/packages')).data[0].id, id);
  assert.equal((await restarted.request('/admin/packages')).status, 401);
  assert.equal((await restarted.request('/admin/login', 'POST', { email: 'catalina@example.com', password })).status, 200);
  assert.equal((await restarted.request('/admin/packages')).data[0].name, pkg.name);
  await restarted.close();
  await rm(directory, { recursive: true });
});

function newClient(server) {
  let cookie = '', csrf = '';
  return async (path, method = 'GET', body) => {
    const res = await fetch(`http://127.0.0.1:${server.address().port}/api${path}`, { method, headers: { origin, 'Content-Type': 'application/json', cookie, 'x-csrf-token': csrf }, body: body === undefined ? undefined : JSON.stringify(body) });
    const data = await res.json();
    if (res.headers.get('set-cookie')) cookie = res.headers.get('set-cookie').split(';')[0];
    if (data.csrf) csrf = data.csrf;
    return { status: res.status, data, cookie: res.headers.get('set-cookie') };
  };
}

test('invited admin verifies her email, uses MFA and cannot replace or invite as the owner', async t => {
  const messages = [];
  const f = await fixture(t, { mailer: { sendCode: async (email, code) => messages.push({ email, code }) } });
  await f.setup(); const owner = f.request, guest = newClient(f.server);
  const original = f.db.prepare('SELECT * FROM users').get();
  const invited = await owner('/admin/invitations', 'POST', { email: 'Catalina.New@example.com' }); assert.equal(invited.status, 201);
  const invitation = new URL(invited.data.url).hash.split('=')[1];
  assert.equal((await guest('/admin/invitation?token=' + invitation)).data.email, 'catalina.new@example.com');
  const registration = await guest('/admin/register', 'POST', { token: invitation, password });
  assert.equal(registration.data.codeRequired, true); assert.equal(registration.cookie, null);
  assert.equal((await guest('/admin/register', 'POST', { token: invitation, password: 'another-password-123' })).status, 429);
  assert.equal((await guest('/admin/me')).status, 401);
  assert.equal(messages[0].email, 'catalina.new@example.com');
  const rawChallenge = registration.data.challenge;
  assert.notEqual(f.db.prepare('SELECT token FROM challenges').get().token, rawChallenge);
  assert.equal((await guest('/admin/verify-code', 'POST', { challenge: rawChallenge, code: '000000' })).status, 400);
  const verified = await guest('/admin/verify-code', 'POST', { challenge: rawChallenge, code: messages[0].code });
  assert.equal(verified.status, 200); assert.equal(verified.data.mfaEnabled, true); assert.equal(verified.data.role, 'admin');
  assert.equal((await guest('/admin/verify-code', 'POST', { challenge: rawChallenge, code: messages[0].code })).status, 400);
  assert.equal((await guest('/admin/invitation?token=' + invitation)).status, 400);
  assert.equal((await guest('/admin/invitations', 'POST', { email: 'outsider@example.com' })).status, 403);
  assert.equal((await guest('/admin/packages', 'POST', { ...pkg, active: false })).status, 201);
  assert.equal((await owner('/admin/me')).data.email, original.email);
  assert.equal(f.db.prepare('SELECT password FROM users WHERE id=?').get(original.id).password, original.password);
  await guest('/admin/logout', 'POST');
  const login = await guest('/admin/login', 'POST', { email: 'catalina.new@example.com', password });
  assert.equal(login.data.codeRequired, true); assert.equal(login.cookie, null);
  assert.equal((await guest('/admin/packages')).status, 401);
  assert.equal((await guest('/admin/verify-code', 'POST', { challenge: login.data.challenge, code: messages.at(-1).code })).status, 200);
  assert.equal((await guest('/admin/password', 'PUT', { currentPassword: password, password: 'new-catalina-password' })).status, 200);
  assert.equal((await owner('/admin/me')).status, 200);
});

test('email MFA enrollment needs current password, code, expiry and a single-use challenge', async t => {
  const messages = [];
  const f = await fixture(t, { mailer: { sendCode: async (email, code) => messages.push({ email, code }) } }); await f.setup(); const r = f.request;
  assert.equal((await r('/admin/mfa/start', 'POST', { password: 'wrong' })).status, 400);
  const enrollment = await r('/admin/mfa/start', 'POST', { password });
  assert.equal((await r('/admin/me')).data.mfaEnabled, false);
  assert.equal((await r('/admin/verify-code', 'POST', { challenge: enrollment.data.challenge, code: messages[0].code })).data.mfaEnabled, true);
  await r('/admin/logout', 'POST');
  const login = await r('/admin/login', 'POST', { email: 'catalina@example.com', password });
  assert.equal(login.data.codeRequired, true);
  assert.equal((await r('/admin/resend-code', 'POST', { challenge: login.data.challenge })).status, 429);
  for (let i = 0; i < 5; i++) assert.equal((await r('/admin/verify-code', 'POST', { challenge: login.data.challenge, code: '000000' })).status, 400);
  assert.equal((await r('/admin/verify-code', 'POST', { challenge: login.data.challenge, code: messages.at(-1).code })).status, 400);
  f.db.prepare('DELETE FROM challenges').run();
  const next = await r('/admin/login', 'POST', { email: 'catalina@example.com', password });
  f.db.prepare('UPDATE challenges SET expires=0').run();
  assert.equal((await r('/admin/verify-code', 'POST', { challenge: next.data.challenge, code: messages.at(-1).code })).status, 400);
});

test('revoked/expired invitations and mail failures fail closed without creating users or sessions', async t => {
  const f = await fixture(t, { mailer: { sendCode: async () => { throw new Error('SMTP unavailable'); } } }); await f.setup();
  const r = f.request, guest = newClient(f.server);
  const i = await r('/admin/invitations', 'POST', { email: 'new@example.com' }); const token = new URL(i.data.url).hash.split('=')[1];
  assert.equal((await guest('/admin/register', 'POST', { token, password })).status, 503);
  assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM users').get().n, 1);
  assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM challenges').get().n, 0);
  const invitationId = (await r('/admin/invitations')).data[0].id;
  await r('/admin/invitations/' + invitationId, 'DELETE');
  assert.equal((await guest('/admin/register', 'POST', { token, password })).status, 400);
  const next = await r('/admin/invitations', 'POST', { email: 'next@example.com' });
  f.db.prepare('UPDATE invitations SET expires=0').run();
  assert.equal((await guest('/admin/register', 'POST', { token: new URL(next.data.url).hash.split('=')[1], password })).status, 400);
});

test('legacy owner password and active session are preserved by migration', async t => {
  const { DatabaseSync } = await import('node:sqlite');
  const { scryptSync, createHash } = await import('node:crypto');
  const directory = await mkdtemp(join(tmpdir(), 'catalina-migration-')), database = join(directory, 'old.sqlite');
  const old = new DatabaseSync(database), salt = 'migration-salt', sessionToken = 'original-session';
  const oldHash = salt + ':' + scryptSync(password, salt, 64).toString('hex');
  old.exec('CREATE TABLE admin (id INTEGER PRIMARY KEY CHECK(id=1), email TEXT NOT NULL,password TEXT NOT NULL); CREATE TABLE sessions(token TEXT PRIMARY KEY,csrf TEXT NOT NULL,expires INTEGER NOT NULL);');
  old.prepare('INSERT INTO admin VALUES (1,?,?)').run('owner@example.com', oldHash);
  old.prepare('INSERT INTO sessions VALUES (?,?,?)').run(createHash('sha256').update(sessionToken).digest('hex'), 'existing-csrf', Date.now() + 100000);
  old.close();
  const f = await fixture(t, { database });
  const me = await f.request('/admin/me', 'GET', undefined, { headers: { cookie: 'catalina_session=' + sessionToken } });
  assert.equal(me.status, 200); assert.equal(me.data.email, 'owner@example.com'); assert.equal(me.data.role, 'owner');
  assert.equal(f.db.prepare('SELECT password FROM users').get().password, oldHash);
  assert.equal((await f.request('/admin/login', 'POST', { email: 'owner@example.com', password })).status, 200);
  await f.close(); await rm(directory, { recursive: true });
});


test('resending replaces the code without resetting attempts or extending expiry', async t => {
  const messages = [];
  const f = await fixture(t, { mailer: { sendCode: async (email, code) => messages.push(code) } }); await f.setup();
  const r = f.request;
  const c = await r('/admin/mfa/start', 'POST', { password });
  const initial = f.db.prepare('SELECT * FROM challenges').get();
  await r('/admin/verify-code', 'POST', { challenge: c.data.challenge, code: '000000' });
  f.db.prepare('UPDATE challenges SET last_sent=0').run();
  assert.equal((await r('/admin/resend-code', 'POST', { challenge: c.data.challenge })).status, 200);
  const after = f.db.prepare('SELECT * FROM challenges').get();
  assert.equal(after.expires, initial.expires); assert.equal(after.attempts, 1); assert.equal(after.sent, 2);
  assert.notEqual(messages[0], messages[1]);
  assert.equal((await r('/admin/verify-code', 'POST', { challenge: c.data.challenge, code: messages[0] })).status, 400);
  assert.equal((await r('/admin/verify-code', 'POST', { challenge: c.data.challenge, code: messages[1] })).status, 200);
});
