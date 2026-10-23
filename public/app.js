const packages = [{name:'Paquete 1',price:500},{name:'Paquete 2',price:900},{name:'Paquete 3',price:1200}];
let selected = 0, quantity = 1, custom = false;
const $ = id => document.getElementById(id);
const money = value => new Intl.NumberFormat('es-MX',{style:'currency',currency:'MXN',maximumFractionDigits:2}).format(value) + ' MXN';
function amount(){ return custom ? Number($('amount').value) : packages[selected].price * quantity; }
function render(){
  document.querySelectorAll('.package').forEach((el,i)=>{const active=!custom&&selected===i;el.classList.toggle('selected',active);el.setAttribute('aria-pressed',String(active));});
  $('order-name').textContent = custom ? 'Monto libre' : packages[selected].name;
  $('unit-price').textContent = custom ? 'Tú eliges el importe' : money(packages[selected].price)+' por paquete';
  $('quantity-row').hidden = custom;
  $('quantity-row').style.display = custom ? 'none' : 'flex';
  $('quantity').textContent = quantity;
  $('minus').disabled = quantity <= 1;
  $('plus').disabled = quantity >= 99;
  $('total').textContent = money(Number.isFinite(amount()) ? amount() : 0);
  $('custom-fields').hidden = !custom;
  $('custom-toggle').setAttribute('aria-expanded',String(custom));
}
document.querySelectorAll('.package').forEach(el=>el.addEventListener('click',()=>{selected=Number(el.dataset.index);custom=false;render();}));
$('minus').addEventListener('click',()=>{quantity=Math.max(1,quantity-1);render();});
$('plus').addEventListener('click',()=>{quantity=Math.min(99,quantity+1);render();});
$('custom-toggle').addEventListener('click',()=>{custom=!custom;render();if(custom)$('amount').focus();});
$('use-packages').addEventListener('click',()=>{custom=false;render();});
$('amount').addEventListener('input',render);
$('pay').addEventListener('click',()=>{
  if(custom&&(!$('amount').value||!$('amount').checkValidity()||!Number.isFinite(amount()))){$('amount').setCustomValidity('Introduce un monto válido de al menos $1 MXN, con hasta dos decimales.');$('amount').reportValidity();$('amount').setCustomValidity('');return;}
  $('checkout-detail').textContent=custom?'Pago de monto libre · '+money(amount()):quantity+' × '+packages[selected].name+' · Total: '+money(amount());
  $('checkout').showModal();
});
$('close-dialog').addEventListener('click',()=>$('checkout').close());
$('back').addEventListener('click',()=>$('checkout').close());
render();
