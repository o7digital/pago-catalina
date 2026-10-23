const DEFAULT_CATALOG = [
 {name:'Paquete 1',price:500,description:'Un primer paso, a tu ritmo.',active:true},
 {name:'Paquete 2',price:900,description:'Más espacio para lo que necesitas.',active:true},
 {name:'Paquete 3',price:1200,description:'Una opción más completa para ti.',active:true}
];
function readCatalog(){try{const value=JSON.parse(localStorage.getItem('catalina-demo-catalog'));if(Array.isArray(value)&&value.length===3&&value.every(p=>typeof p.name==='string'&&p.name.trim()&&Number.isFinite(p.price)&&p.price>=1&&typeof p.description==='string'&&typeof p.active==='boolean'))return value;}catch{}return structuredClone(DEFAULT_CATALOG);}
function saveCatalog(value){try{localStorage.setItem('catalina-demo-catalog',JSON.stringify(value));return true;}catch{return false;}}
