const $ = id => document.getElementById(id);
const labels = { paid: 'Pagado', pending: 'Pendiente', refunded: 'Reembolsado', partially_refunded: 'Reembolso parcial', failed: 'Fallido', expired: 'Expirado' };
let orders = [], csrf, setupRequired = false;
const setupToken = new URLSearchParams(location.hash.slice(1)).get('setup');
if (setupToken) history.replaceState(null, '', location.pathname);
async function adminApi(path, options = {}) {
  try { return await api('/admin' + path, { ...options, headers: { 'x-csrf-token': csrf || '', ...options.headers } }); }
  catch (error) { if (error.status === 401) showAuth(); throw error; }
}
function setView(view) {
  if (!['overview', 'orders', 'catalog', 'connection'].includes(view)) view = 'overview';
  document.querySelectorAll('.view').forEach(el => { el.hidden = el.id !== view; });
  document.querySelectorAll('[data-view]').forEach(el => { el.classList.toggle('active', el.dataset.view === view); if (el.dataset.view === view) el.setAttribute('aria-current', 'page'); else el.removeAttribute('aria-current'); });
  $('breadcrumb').textContent = { overview: 'Resumen', orders: 'Pedidos', catalog: 'Paquetes', connection: 'Conexión Stripe' }[view];
  history.replaceState(null, '', '#' + view);
}
function date(value) { return new Date(value).toLocaleString('es-MX', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'America/Mexico_City' }); }
function table(target, data) {
  const wrap = $(target); wrap.replaceChildren();
  const t = node('table'), head = node('thead'), hr = node('tr');
  ['Pedido', 'Cliente', 'Paquete', 'Importe', 'Estado'].forEach(s => hr.append(node('th', s))); head.append(hr); t.append(head);
  const body = node('tbody');
  for (const order of data) {
    const row = node('tr'), id = node('td'), link = node('button', order.id.slice(0, 8).toUpperCase(), 'order-link');
    link.addEventListener('click', () => detail(order)); id.append(link, node('small', date(order.date)));
    const customer = node('td', order.name); customer.append(node('small', order.email));
    const status = node('td'); status.append(node('span', labels[order.status] || order.status, 'status ' + order.status));
    row.append(id, customer, node('td', order.quantity + ' × ' + order.package), node('td', money(order.amount)), status); body.append(row);
  }
  if (!data.length) { const row = node('tr'), cell = node('td', 'No hay pedidos para mostrar.'); cell.colSpan = 5; row.append(cell); body.append(row); }
  t.append(body); wrap.append(t);
}
function filtered() { const q = $('search').value.trim().toLocaleLowerCase('es'), status = $('status-filter').value; return orders.filter(o => (status === 'all' || o.status === status) && [o.name, o.email, o.id, o.package].some(s => s.toLocaleLowerCase('es').includes(q))); }
function updateOrders() { const rows = filtered(); table('orders-table', rows); $('result-count').textContent = rows.length + ' de ' + orders.length + ' pedidos (máximo 1,000 recientes)'; }
function detail(order) {
  $('detail-id').textContent = order.id; $('detail-content').replaceChildren();
  for (const [label, value] of Object.entries({ Cliente: order.name, Correo: order.email, Paquete: order.package, Cantidad: order.quantity, Importe: money(order.amount), Reembolsado: money(order.refunded), Estado: labels[order.status], Fecha: date(order.date) })) $('detail-content').append(node('dt', label), node('dd', String(value)));
  $('order-dialog').showModal();
}
function editor(p = { name: '', price: '', description: '', active: false }) {
  const form = node('form', undefined, 'editor');
  form.append(node('p', p.id ? 'TU OFERTA' : 'NUEVO PAQUETE', 'eyebrow'), node('h2', p.name || 'Crear paquete'));
  for (const [key, label, type] of [['name', 'Nombre', 'text'], ['price', 'Precio (MXN)', 'number'], ['description', 'Descripción', 'textarea']]) {
    const id = 'package-' + (p.id || 'new') + '-' + key, lab = node('label', label), field = node(type === 'textarea' ? 'textarea' : 'input');
    lab.htmlFor = id; field.id = id; field.name = key; field.value = p[key]; field.required = true;
    if (type !== 'textarea') field.type = type;
    if (type === 'number') { field.min = '1'; field.max = '999999.99'; field.step = '0.01'; } else field.maxLength = key === 'name' ? 60 : 180;
    form.append(lab, field);
  }
  const label = node('label', undefined, 'availability'), active = node('input'); active.type = 'checkbox'; active.name = 'active'; active.checked = p.active;
  label.append(active, document.createTextNode('Visible en la página'));
  const save = node('button', p.id ? 'Guardar cambios' : 'Crear paquete', 'pay'); save.type = 'submit';
  const feedback = node('p'); feedback.setAttribute('role', 'status'); form.append(label, save, feedback);
  form.addEventListener('submit', async event => {
    event.preventDefault(); save.disabled = true;
    const data = new FormData(form);
    try {
      await adminApi('/packages' + (p.id ? '/' + p.id : ''), { method: p.id ? 'PUT' : 'POST', body: JSON.stringify({ name: data.get('name').trim(), description: data.get('description').trim(), price: Number(data.get('price')), active: active.checked }) });
      await editors(); $('save-feedback').textContent = 'Guardado. Los cambios ya están disponibles en tu página de pago.';
    } catch (error) { feedback.textContent = error.message; } finally { save.disabled = false; }
  });
  if (p.id) {
    const remove = node('button', 'Eliminar paquete', 'text-button'); remove.type = 'button';
    remove.addEventListener('click', async () => {
      if (!confirm('¿Eliminar «' + p.name + '»? Los pedidos anteriores se conservarán.')) return;
      remove.disabled = true;
      try { await adminApi('/packages/' + p.id, { method: 'DELETE' }); await editors(); $('save-feedback').textContent = 'Paquete eliminado.'; }
      catch (error) { feedback.textContent = error.message; remove.disabled = false; }
    }); form.append(remove);
  } else {
    const cancel = node('button', 'Cancelar', 'text-button'); cancel.type = 'button'; cancel.addEventListener('click', () => { form.remove(); $('new-package').disabled = false; }); form.append(cancel);
  }
  return form;
}
async function editors() {
  const catalog = await adminApi('/packages'); $('editors').replaceChildren(); $('new-package').disabled = false;
  catalog.forEach(p => $('editors').append(editor(p)));
  if (!catalog.length) $('editors').append(node('p', 'Crea tu primer paquete para publicarlo en la página de pago.', 'empty-state'));
}
function metrics() {
  const paid = orders.filter(o => ['paid', 'refunded', 'partially_refunded'].includes(o.status));
  const values = [['Ingresos netos', money(paid.reduce((s, o) => s + o.amount - o.refunded, 0)), 'Pagos confirmados menos reembolsos'], ['Pedidos recibidos', String(orders.length), 'Hasta 1,000 pedidos recientes'], ['Pagos pendientes', String(orders.filter(o => o.status === 'pending').length), 'Esperando confirmación de Stripe']];
  $('metrics').replaceChildren(); values.forEach(([title, value, caption]) => { const card = node('div', undefined, 'metric'); card.append(node('span', title, 'metric-label'), node('strong', value), node('small', caption)); $('metrics').append(card); });
}
async function refresh() {
  const [data, connection] = await Promise.all([adminApi('/orders'), adminApi('/connection')]); orders = data; metrics(); updateOrders(); table('recent-table', orders.slice(0, 4));
  const text = connection.checkoutEnabled ? connection.testMode ? 'Conectado · Modo de prueba' : 'Conectado · Pagos reales' : 'Pendiente de configuración';
  for (const id of ['stripe-status', 'stripe-summary']) { $(id).textContent = text; $(id).className = 'status ' + (connection.checkoutEnabled ? 'paid' : 'pending'); }
  $('stripe-description').textContent = connection.checkoutEnabled ? 'Los pagos se abrirán en Stripe. Las confirmaciones se registran automáticamente en Pedidos.' : 'Los pagos están desactivados hasta completar la configuración del servidor.';
  $('stripe-key-status').textContent = connection.secretConfigured ? 'Configurada en el servidor.' : 'Pendiente: configurar STRIPE_SECRET_KEY en el servidor.';
  $('stripe-webhook-status').textContent = connection.webhookConfigured ? 'Secreto configurado. Comprueba las entregas en Stripe.' : 'Pendiente: crear el webhook y configurar STRIPE_WEBHOOK_SECRET.';
  $('webhook-url').textContent = connection.webhookUrl;
}
function showAuth() {
  $('auth-screen').hidden = false; $('workspace').hidden = true;
  if (!setupRequired) {
    $('auth-title').textContent = 'Bienvenida.';
    $('auth-description').textContent = 'Inicia sesión para gestionar tus paquetes y pedidos.';
    $('auth-submit').textContent = 'Entrar';
    $('auth-password').autocomplete = 'current-password';
    $('auth-password').minLength = 0;
  }
}
async function showWorkspace(email) { $('auth-screen').hidden = true; $('workspace').hidden = false; $('account-email').textContent = email; setView(location.hash.slice(1)); await Promise.all([editors(), refresh()]); }
$('auth-form').addEventListener('submit', async event => {
  event.preventDefault(); $('auth-submit').disabled = true; $('auth-feedback').textContent = '';
  try { const data = await api('/admin/' + (setupRequired ? 'setup' : 'login'), { method: 'POST', body: JSON.stringify({ email: $('auth-email').value, password: $('auth-password').value, token: setupToken }) }); csrf = data.csrf; $('auth-password').value = ''; setupRequired = false; await showWorkspace(data.email); }
  catch (error) { $('auth-feedback').textContent = error.message; } finally { $('auth-submit').disabled = false; }
});
$('logout').addEventListener('click', async () => { try { await adminApi('/logout', { method: 'POST' }); csrf = null; location.reload(); } catch (error) { $('save-feedback').textContent = error.message; } });
$('password-form').addEventListener('submit', async event => {
  event.preventDefault(); const button = event.target.querySelector('button'); button.disabled = true;
  try { const data = await adminApi('/password', { method: 'PUT', body: JSON.stringify({ currentPassword: $('current-password').value, password: $('new-password').value }) }); csrf = data.csrf; event.target.reset(); $('password-feedback').textContent = 'Contraseña actualizada. Las otras sesiones se han cerrado.'; }
  catch (error) { $('password-feedback').textContent = error.message; } finally { button.disabled = false; }
});
$('new-package').addEventListener('click', () => { $('new-package').disabled = true; const form = editor(); $('editors').prepend(form); form.querySelector('input').focus(); });
$('search').addEventListener('input', updateOrders); $('status-filter').addEventListener('change', updateOrders);
$('all-orders').addEventListener('click', () => setView('orders')); $('see-connection').addEventListener('click', () => setView('connection'));
document.querySelectorAll('[data-view]').forEach(el => el.addEventListener('click', () => setView(el.dataset.view)));
$('close-order').addEventListener('click', () => $('order-dialog').close());
$('export').addEventListener('click', () => {
  const quote = s => '"' + String(s).replace(/^[=+@\-\t\r]/, "'$&").replaceAll('"', '""') + '"';
  const rows = [['Pedido', 'Cliente', 'Correo', 'Paquete', 'Cantidad', 'Importe MXN', 'Reembolsado MXN', 'Estado', 'Fecha'], ...filtered().map(o => [o.id, o.name, o.email, o.package, o.quantity, o.amount, o.refunded, labels[o.status], date(o.date)])];
  const url = URL.createObjectURL(new Blob(['\uFEFF' + rows.map(r => r.map(quote).join(',')).join('\r\n')], { type: 'text/csv;charset=utf-8' }));
  const a = node('a'); a.href = url; a.download = 'pedidos-catalina.csv'; a.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
});
window.addEventListener('hashchange', () => { if (!$('workspace').hidden) setView(location.hash.slice(1)); });
document.addEventListener('visibilitychange', () => { if (!document.hidden && !$('workspace').hidden) refresh().catch(error => { $('save-feedback').textContent = error.message; }); });
async function init() {
  showAuth();
  try {
    const status = await api('/admin/status'); setupRequired = status.setupRequired;
    if (setupRequired) {
      $('auth-title').textContent = 'Activa tu espacio.'; $('auth-description').textContent = setupToken ? 'Elige tu correo y una contraseña de al menos 12 caracteres.' : 'Abre el enlace privado de activación facilitado por tu administrador.';
      $('auth-password').minLength = 12; $('auth-password').autocomplete = 'new-password'; $('auth-submit').textContent = 'Crear mi cuenta'; $('auth-submit').disabled = !setupToken || !status.setupAvailable; return;
    }
    try { const me = await adminApi('/me'); csrf = me.csrf; await showWorkspace(me.email); }
    catch (error) { if (error.status !== 401) $('auth-feedback').textContent = error.message; }
  } catch (error) { $('auth-feedback').textContent = error.message; }
}
init();
