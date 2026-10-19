// Verificación de punta a punta de recepción de mercadería y factura de compra (Fase 2.2) contra el stack Docker LOCAL.
//
// Llama por HTTP a purchasing-service (:3017) e inventory-service (:3013) reales, y mira el outbox, los asientos y la bitácora en
// MySQL con `docker exec cmr-mysql`. Sustituye a los antiguos verify-receiving.mjs / verify-bills.mjs, que reescribían la
// transacción en SQL a mano y por eso no vieron que el evento a inventario llevaba lo pedido en vez de lo recibido, que el costo
// salía ×1.000.000 ni que 30 facturas simultáneas pasaban 19 en vez de 10.
//
//   1. docker compose -f docker-compose.yml -f <override mysql 3307> up -d --build   (ver la nota del 3306 en AGENTS.md)
//   2. el producto debe llevar stock en inventory: INSERT en inventory_db.products con track_stock=1 para el producto que use.
//   3. node scripts/verify-receiving-billing.mjs
//
// Variables: GATEWAY (http://127.0.0.1:8080), PURCH (:3017), INV (:3013). Usa la cuenta de desarrollo admin@admin.com.
import { randomUUID } from 'node:crypto';
import { execSync } from 'node:child_process';

const GATEWAY = process.env.GATEWAY ?? 'http://127.0.0.1:8080';
const PURCH = process.env.PURCH ?? 'http://127.0.0.1:3017';
const INV = process.env.INV ?? 'http://127.0.0.1:3013';
let failures = 0;
const check = (name, ok, detail = '') => {
  if (!ok) failures += 1;
  console.log(`${ok ? 'OK   ' : 'FALLO'} ${name}${detail ? ' — ' + detail : ''}`);
};
const sql = (db, q) => execSync(`docker exec cmr-mysql mysql -uroot -proot123 -N -B ${db} -e "${q.replace(/"/g, '\\"')}"`, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const login = await (await fetch(`${GATEWAY}/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: 'admin@admin.com', password: 'admin' }) })).json();
const gw = (p) => fetch(`${GATEWAY}${p}`, { headers: { Authorization: `Bearer ${login.accessToken}` } }).then((r) => r.json());
const ORG = JSON.parse(Buffer.from(login.accessToken.split('.')[1], 'base64url').toString()).org_id;
const products = (await gw('/products?pageSize=50')).items;
const rates = await gw('/countries/EC/tax-rates');
const iva15 = rates.find((r) => r.code === 'IVA15');
const warehouse = (await fetch(`${INV}/warehouses`, { headers: { 'X-Organization-Id': ORG, 'X-Permissions': 'inventory:read' } }).then((r) => r.json()))[0];
const inv = (path) => fetch(`${INV}${path}`, { headers: { 'X-Organization-Id': ORG, 'X-Permissions': 'inventory:read' } }).then((r) => r.json());

// Elegimos un producto que lleve stock (el que acepte un movimiento de inventario).
let product = null;
for (const p of products) {
  if (!p.taxes?.length) continue;
  const s = await inv(`/stock/products/${p.id}`);
  if (s && !s.code) { product = p; break; }
}
product ??= products.find((p) => p.taxes?.length);
check('datos reales', Boolean(product && warehouse && iva15), `${product?.name} | ${warehouse?.name}`);

const MAKER = randomUUID();
const BOSS = randomUUID();
const PERMS = 'supplier:read,supplier:manage,purchase:read,purchase:create,purchase:approve,purchase:cancel,receipt:create,purchase:close,purchase_bill:read,purchase_bill:create,purchase_bill:override,purchase_bill:void,withholding:issue';
async function call(method, path, { user = MAKER, perms = PERMS, body, org = ORG } = {}) {
  const res = await fetch(`${PURCH}${path}`, { method, headers: { 'Content-Type': 'application/json', 'X-Organization-Id': org, 'X-User-Id': user, 'X-Permissions': perms, 'X-Country-Code': 'EC' }, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  let json = null; try { json = text ? JSON.parse(text) : null; } catch { json = { raw: text }; }
  return { status: res.status, json };
}
const ruc = () => `17${String(Math.floor(Math.random() * 1e8)).padStart(8, '0')}001`;
const today = new Date().toISOString().slice(0, 10);

// ── Preparación ────────────────────────────────────────────────────────────
await call('PUT', '/purchasing/settings', { body: { approvalThresholdCents: null, defaultWarehouseId: warehouse.id } });
const supplier = (await call('POST', '/purchasing/suppliers', { body: { identificationType: 'RUC', identification: ruc(), legalName: 'Proveedor e2e fase 2.2', paymentTermDays: 30 } })).json;
async function newOrder(qty, cost = 250) {
  const o = (await call('POST', '/purchasing/orders', { body: { supplierId: supplier.id, warehouseId: warehouse.id, lines: [{ productId: product.id, quantity: qty, unitCostCents: cost, taxRateId: iva15.id }] } })).json;
  const sub = await call('POST', `/purchasing/orders/${o.id}/submit`);
  return sub.json;
}

// ── 1. Recepción parcial y el evento que recibe inventario ─────────────────
const before = await inv(`/stock/products/${product.id}`);
const order = await newOrder('100');
check('orden aprobada sola (sin umbral)', order.status === 'approved', order.status);
const lineId = order.lines[0].id;
const r1 = await call('POST', `/purchasing/orders/${order.id}/receipts`, { body: { receiptDate: today, lines: [{ orderLineId: lineId, quantity: '10' }] } });
check('recibir 10 de 100', r1.status === 201 || r1.status === 200, `${r1.status} ${JSON.stringify(r1.json).slice(0, 160)}`);
const o1 = (await call('GET', `/purchasing/orders/${order.id}`)).json;
check('orden pasa a partially_received', o1.status === 'partially_received', o1.status);
check('número RM-AAAA-NNNNNN', /^RM-\d{4}-\d{6}$/.test(r1.json?.receiptNumber ?? r1.json?.number ?? ''), r1.json?.receiptNumber ?? r1.json?.number);

const ev = sql('purchasing_db', `SELECT type, payload FROM outbox_messages WHERE payload LIKE '%${order.id}%' ORDER BY occurred_at`).split('\n');
const evReceived = ev.find((l) => l.startsWith('purchase.purchase_order.received'));
let payload = null; try { payload = JSON.parse(evReceived.split('\t').slice(1).join('\t')); } catch { /* */ }
console.log('   evento a inventario:', JSON.stringify(payload?.lines));
check('EVENTO A INVENTARIO lleva SOLO lo recibido (10), no lo pedido (100)', payload?.lines?.length === 1 && Number(payload.lines[0].quantity) === 10, `cantidad=${payload?.lines?.[0]?.quantity}`);
const posted = ev.find((l) => l.startsWith('purchasing.receipt.posted'));
let pp = null; try { pp = JSON.parse(posted.split('\t').slice(1).join('\t')); } catch { /* */ }
check('receipt.posted: totalCostCents = 10 × 2,50 = 2500 centavos', pp?.totalCostCents === 2500, `totalCostCents=${pp?.totalCostCents}`);

await sleep(4000);
const after = await inv(`/stock/products/${product.id}`);
console.log('   stock antes:', JSON.stringify(before).slice(0, 160), '\n   stock después:', JSON.stringify(after).slice(0, 160));
const qty = (s) => Number(s.totalOnHand);
check('stock sube exactamente 10', qty(after) - qty(before) === 10, `delta=${qty(after) - qty(before)}`);

// ── 2. Resto, sobre-recepción, cierre ──────────────────────────────────────
const r2 = await call('POST', `/purchasing/orders/${order.id}/receipts`, { body: { receiptDate: today, lines: [{ orderLineId: lineId, quantity: '90' }] } });
check('recibir los 90 restantes', r2.status === 201 || r2.status === 200, String(r2.status));
check('orden pasa a received', (await call('GET', `/purchasing/orders/${order.id}`)).json.status === 'received');
const r3 = await call('POST', `/purchasing/orders/${order.id}/receipts`, { body: { receiptDate: today, lines: [{ orderLineId: lineId, quantity: '1' }] } });
check('recibir de más en orden completa → rechazado', r3.status >= 400 && r3.status < 500, `${r3.status} ${r3.json?.code}`);
const o4 = await newOrder('20');
const r4 = await call('POST', `/purchasing/orders/${o4.id}/receipts`, { body: { receiptDate: today, lines: [{ orderLineId: o4.lines[0].id, quantity: '21' }] } });
check('sobre-recepción con tolerancia 0 → OVER_RECEIPT', r4.status >= 400 && r4.json?.code === 'OVER_RECEIPT', `${r4.status} ${r4.json?.code}`);
const r5 = await call('POST', `/purchasing/orders/${o4.id}/receipts`, { body: { receiptDate: today, lines: [{ orderLineId: o4.lines[0].id, quantity: '5.5' }] } });
check('recepción con decimales (5.5)', r5.status < 300, String(r5.status));
const cl = await call('POST', `/purchasing/orders/${o4.id}/close`, { body: { reason: 'El proveedor no enviará el resto' } });
check('cierre manual con motivo → closed', cl.status < 300 && (await call('GET', `/purchasing/orders/${o4.id}`)).json.status === 'closed', String(cl.status));
check('cerrar sin permiso → 403', (await call('POST', `/purchasing/orders/${o4.id}/close`, { perms: 'purchase:read', body: { reason: 'xxxxx' } })).status === 403);
check('recibir sin permiso receipt:create → 403', (await call('POST', `/purchasing/orders/${order.id}/receipts`, { perms: 'purchase:read', body: { receiptDate: today, lines: [{ orderLineId: lineId, quantity: '1' }] } })).status === 403);
check('otra organización no ve la recepción (404)', (await call('GET', `/purchasing/orders/${order.id}/receiving`, { org: randomUUID() })).status === 404);

// ── 3. Concurrencia real por HTTP: 30 recepciones de 10 sobre una línea de 100 ─
const oc = await newOrder('100');
const res = await Promise.all(Array.from({ length: 30 }, () => call('POST', `/purchasing/orders/${oc.id}/receipts`, { body: { receiptDate: today, lines: [{ orderLineId: oc.lines[0].id, quantity: '10' }] } })));
const okc = res.filter((r) => r.status < 300);
const nums = okc.map((r) => r.json?.receiptNumber ?? r.json?.number).sort();
const ocAfter = (await call('GET', `/purchasing/orders/${oc.id}/receiving`)).json;
console.log('   estados:', JSON.stringify(res.reduce((a, r) => ({ ...a, [r.status]: (a[r.status] ?? 0) + 1 }), {})), ' recibido:', JSON.stringify(ocAfter).slice(0, 220));
check('30 recepciones simultáneas: exactamente 10 pasan (100/10)', okc.length === 10, `éxitos=${okc.length}`);
check('números RM distintos', new Set(nums).size === okc.length);
const seqs = nums.map((n) => Number(n.slice(-6)));
check('números RM consecutivos entre los exitosos', seqs.length > 0 && seqs.at(-1) - seqs[0] === seqs.length - 1, `${nums[0]} … ${nums.at(-1)}`);
const dbRecv = sql('purchasing_db', `SELECT received_micros FROM purchase_order_lines WHERE order_id='${oc.id}'`);
check('received_micros = 100.000000 y coincide con la suma de recepciones', dbRecv === '100000000' && sql('purchasing_db', `SELECT COALESCE(SUM(l.quantity_micros),0) FROM goods_receipt_lines l JOIN goods_receipts r ON r.id=l.receipt_id WHERE r.purchase_order_id='${oc.id}'`) === '100000000', `received=${dbRecv}`);

// ── 4. Factura de compra y conciliación a tres vías ────────────────────────
const bo = await newOrder('100');
await call('POST', `/purchasing/orders/${bo.id}/receipts`, { body: { receiptDate: today, lines: [{ orderLineId: bo.lines[0].id, quantity: '40' }] } });
let seqNo = Math.floor(Math.random() * 800000) + 1000;
const billBody = (qty, cost = 250, extra = {}) => ({
  supplierId: supplier.id, purchaseOrderId: bo.id, docType: '01', establishment: '001', emissionPoint: '001',
  sequential: String(seqNo++).padStart(9, '0'), authorizationNumber: null, issueDate: today, dueDate: today, currencyCode: 'USD',
  lines: [{ orderLineId: bo.lines[0].id, productId: product.id, description: 'Producto e2e', quantity: String(qty), unitCostCents: cost, taxRatePct: '15.00', taxCode: '2', taxPercentageCode: '4' }],
  ...extra,
});
const b1 = await call('POST', '/purchasing/bills', { body: billBody(40) });
check('crear factura borrador', b1.status === 201, `${b1.status} ${JSON.stringify(b1.json).slice(0, 200)}`);
console.log('   totales:', b1.json?.subtotalCents, b1.json?.taxCents, b1.json?.totalCents);
check('totales exactos: 40×2,50=10000 + IVA 15%=1500 → 11500', b1.json?.subtotalCents === 10000 && b1.json?.taxCents === 1500 && b1.json?.totalCents === 11500);
const p1 = await call('POST', `/purchasing/bills/${b1.json.id}/post`);
check('contabilizar factura conciliada (40 = recibido 40) → posted', p1.json?.status === 'posted' && p1.json?.matchStatus === 'matched', `${p1.status} ${p1.json?.status} ${p1.json?.matchStatus}`);
check('número interno FC-AAAA-NNNNNN', /^FC-\d{4}-\d{6}$/.test(p1.json?.internalNumber ?? ''), p1.json?.internalNumber);
const b2 = await call('POST', '/purchasing/bills', { body: billBody(10) });
const p2 = await call('POST', `/purchasing/bills/${b2.json.id}/post`);
check('facturar 10 más sin recepción (acumulado 50 > recibido 40) → blocked QTY_EXCEEDS_RECEIVED', p2.json?.status === 'blocked' && JSON.stringify(p2.json?.matchReasons).includes('QTY_EXCEEDS_RECEIVED'), `${p2.json?.status} ${JSON.stringify(p2.json?.matchReasons)?.slice(0, 120)}`);
check('override por el MISMO usuario → rechazado', (await call('POST', `/purchasing/bills/${b2.json.id}/override`, { body: { reason: 'Autorizado por gerencia' } })).status === 403);
check('override sin permiso → 403', (await call('POST', `/purchasing/bills/${b2.json.id}/override`, { user: BOSS, perms: 'purchase_bill:read', body: { reason: 'Autorizado por gerencia' } })).status === 403);
const ov = await call('POST', `/purchasing/bills/${b2.json.id}/override`, { user: BOSS, body: { reason: 'Autorizado por gerencia' } });
check('override por OTRA persona → posted/overridden', ov.json?.status === 'posted' && ov.json?.matchStatus === 'overridden', `${ov.status} ${ov.json?.status}`);
const dup = await call('POST', '/purchasing/bills', { body: billBody(1, 250, { sequential: b1.json.sequential }) });
check('documento del proveedor duplicado → 409', dup.status === 409, `${dup.status} ${dup.json?.code}`);
const b3 = await call('POST', '/purchasing/bills', { body: billBody(1, 300) });
const p3 = await call('POST', `/purchasing/bills/${b3.json.id}/post`);
check('precio 3,00 vs orden 2,50 → blocked PRICE_VARIANCE', p3.json?.status === 'blocked' && JSON.stringify(p3.json?.matchReasons).includes('PRICE_VARIANCE'), JSON.stringify(p3.json?.matchReasons)?.slice(0, 140));
const vd = await call('POST', `/purchasing/bills/${b1.json.id}/void`, { body: { reason: 'Factura emitida por error' } });
check('anular factura contabilizada', vd.json?.status === 'voided', `${vd.status} ${vd.json?.status}`);
check('anular sin permiso → 403', (await call('POST', `/purchasing/bills/${b2.json.id}/void`, { perms: 'purchase_bill:read', body: { reason: 'Factura emitida por error' } })).status === 403);

// Concurrencia de facturas: orden con 100 recibidos; 30 facturas de 10 a la vez → como máximo 10 pasan a posted.
const co = await newOrder('100');
await call('POST', `/purchasing/orders/${co.id}/receipts`, { body: { receiptDate: today, lines: [{ orderLineId: co.lines[0].id, quantity: '100' }] } });
const mk = (n) => ({ supplierId: supplier.id, purchaseOrderId: co.id, docType: '01', establishment: '002', emissionPoint: '001', sequential: String(900000000 - n - Math.floor(Math.random() * 1000) * 1000).padStart(9, '0').slice(-9), issueDate: today, dueDate: today, currencyCode: 'USD', lines: [{ orderLineId: co.lines[0].id, productId: product.id, description: 'x', quantity: '10', unitCostCents: 250, taxRatePct: '15.00', taxCode: '2', taxPercentageCode: '4' }] });
const drafts = [];
for (let i = 0; i < 30; i++) { const d = await call('POST', '/purchasing/bills', { body: { ...mk(i), sequential: String(500000 + i).padStart(9, '0') } }); drafts.push(d.json.id); }
const posts = await Promise.all(drafts.map((id) => call('POST', `/purchasing/bills/${id}/post`)));
const posted30 = posts.filter((p) => p.json?.status === 'posted').length;
const blocked30 = posts.filter((p) => p.json?.status === 'blocked').length;
console.log('   estados HTTP:', JSON.stringify(posts.reduce((a, p) => ({ ...a, [p.status]: (a[p.status] ?? 0) + 1 }), {})), `posted=${posted30} blocked=${blocked30}`);
check('30 facturas simultáneas de 10 sobre 100 recibidos: exactamente 10 contabilizadas', posted30 === 10, `posted=${posted30}`);
const fcs = posts.filter((p) => p.json?.internalNumber).map((p) => Number(p.json.internalNumber.slice(-6))).sort((a, b) => a - b);
check('números FC distintos', new Set(fcs).size === fcs.length, `${fcs.length} números`);
const billed = sql('purchasing_db', `SELECT COALESCE(SUM(l.quantity_micros),0) FROM purchase_bill_lines l JOIN purchase_bills b ON b.id=l.bill_id WHERE b.purchase_order_id='${co.id}' AND b.status='posted'`);
check('suma facturada (posted) = 100.000000, nunca más que lo recibido', Number(billed) === 100000000, `facturado=${billed}`);

// ── 5. Contabilidad y bitácora ─────────────────────────────────────────────
await sleep(6000);
const acc = sql('accounting_db', `SELECT source_type, COUNT(*) FROM journal_entries WHERE organization_id='${ORG}' GROUP BY source_type`);
const pend = sql('accounting_db', `SELECT source_type, status, reason_code, COUNT(*) FROM pending_postings WHERE organization_id='${ORG}' AND source_type LIKE 'purchase%' GROUP BY 1,2,3`);
console.log('   asientos por origen:\n' + acc.split('\n').map((l) => '     ' + l).join('\n'));
console.log('   pendientes de compra:\n' + (pend || '(ninguno)').split('\n').map((l) => '     ' + l).join('\n'));
const audit = sql('audit_db', `SELECT event, COUNT(*) FROM audit_logs WHERE organization_id='${ORG}' AND (event LIKE 'purchas%') GROUP BY event ORDER BY 1`);
console.log('   bitácora:\n' + audit.split('\n').map((l) => '     ' + l).join('\n'));
for (const t of ['purchase.purchase_order.received', 'purchasing.receipt.posted', 'purchasing.bill.created', 'purchasing.bill.posted', 'purchasing.bill.blocked', 'purchasing.bill.overridden', 'purchasing.bill.voided', 'purchasing.order.closed']) {
  check(`la bitácora registró ${t}`, audit.includes(t));
}
console.log(failures === 0 ? '\nTODO OK' : `\n${failures} verificaciones FALLARON`);
process.exit(failures === 0 ? 0 : 1);
