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
