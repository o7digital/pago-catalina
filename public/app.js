const $ = id => document.getElementById(id);
let packages = [], selected = 0, quantity = 1, custom = false, enabled = false;
function amount() { return custom ? Number($('amount').value) : (packages[selected]?.price || 0) * quantity; }
function render() {
  document.querySelectorAll('.package').forEach((el, i) => { const active = !custom && selected === i; el.classList.toggle('selected', active); el.setAttribute('aria-pressed', String(active)); });
  $('order-name').textContent = custom ? 'Monto libre' : packages[selected]?.name || 'Sin paquetes disponibles';
  $('unit-price').textContent = custom ? 'Tú eliges el importe' : packages[selected] ? money(packages[selected].price) + ' por paquete' : 'Vuelve pronto';
  $('quantity-row').hidden = custom || !packages.length;
  $('quantity-row').style.display = custom || !packages.length ? 'none' : 'flex';
  $('quantity').textContent = quantity;
  $('minus').disabled = quantity <= 1; $('plus').disabled = quantity >= 99;
  $('total').textContent = money(Number.isFinite(amount()) ? amount() : 0);
  $('custom-fields').hidden = !custom;
  $('custom-toggle').setAttribute('aria-expanded', String(custom));
  $('pay').disabled = !enabled || (!custom && !packages.length);
  $('use-packages').hidden = !packages.length;
}
$('minus').addEventListener('click', () => { quantity = Math.max(1, quantity - 1); render(); });
$('plus').addEventListener('click', () => { quantity = Math.min(99, quantity + 1); render(); });
$('custom-toggle').addEventListener('click', () => { custom = !custom; render(); if (custom) $('amount').focus(); });
$('use-packages').addEventListener('click', () => { custom = false; render(); });
$('amount').addEventListener('input', render);
$('pay').addEventListener('click', async () => {
  if (custom && (!$('amount').value || !$('amount').checkValidity() || !Number.isFinite(amount()))) { $('amount').reportValidity(); return; }
  $('pay').disabled = true; $('payment-feedback').textContent = 'Preparando tu pago seguro…';
  try { const data = await api('/checkout', { method: 'POST', body: JSON.stringify(custom ? { amount: amount() } : { packageId: packages[selected].id, quantity }) }); location.assign(data.url); }
  catch (error) { $('payment-feedback').textContent = error.message; render(); }
});
async function init() {
  try {
    const [catalog, config] = await Promise.all([api('/packages'), api('/config')]);
    packages = catalog; enabled = config.checkoutEnabled;
    const container = document.querySelector('.packages'); container.replaceChildren();
    packages.forEach((p, i) => {
      const button = node('button', undefined, 'package'); button.type = 'button'; button.dataset.index = i;
      const top = node('span', undefined, 'package-top'); top.append(node('span', 'PAQUETE ' + String(i + 1).padStart(2, '0')), node('i', '✓'));
      const price = node('div', money(p.price), 'price');
      button.append(top, node('h3', p.name), node('p', p.description), price);
      button.addEventListener('click', () => { selected = i; custom = false; quantity = 1; render(); }); container.append(button);
    });
    if (!packages.length) container.append(node('p', 'Catalina está preparando sus paquetes. Vuelve pronto.', 'empty-state'));
    document.querySelector('.section-heading span').textContent = packages.length + ' opciones';
    $('payment-feedback').textContent = !enabled ? 'Los pagos aún no están disponibles. Contacta con Catalina.' : config.testMode ? 'Modo de prueba: no se realizan cobros reales.' : 'Serás redirigido a Stripe para pagar de forma segura.';
    const banner = document.querySelector('.demo'); banner.replaceChildren(document.createTextNode(config.testMode ? 'MODO DE PRUEBA · Sin cobros reales' : enabled ? 'CATALINA · PAGOS SEGUROS' : 'CATALINA · Próximamente'));
    const payment = new URLSearchParams(location.search).get('payment');
    if (payment === 'success') $('payment-feedback').textContent = 'Gracias. Tu pago será confirmado por Stripe. Si tienes dudas, contacta con Catalina.';
    if (payment === 'cancelled') $('payment-feedback').textContent = 'Pago cancelado. Puedes volver a intentarlo.';
  } catch (error) { $('payment-feedback').textContent = error.message; document.querySelector('.packages').replaceChildren(node('p', 'No se pudieron cargar los paquetes. Actualiza la página.')); }
  render();
}
render(); init();
