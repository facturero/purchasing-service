// Verificación de purchasing-service contra MySQL REAL y los catálogos REALES (product, tax e inventory del stack local).
//
//   1. docker compose up -d mysql rabbitmq product-service tax-service inventory-service organization-service auth-service gateway
//   2. crear purchasing_db y migrar: DB_HOST=127.0.0.1 DB_PORT=3307 DB_NAME=purchasing_db npx sequelize-cli db:migrate
//   3. levantar el servicio en :3017 con esas variables (npx tsx src/main.ts)
//   4. node scripts/verify-purchasing.mjs
//
// Variables: GATEWAY (por defecto http://127.0.0.1:8080: solo para sacar un producto y una tarifa reales), INVENTORY
// (http://127.0.0.1:3013: la bodega) y PURCHASING (http://127.0.0.1:3017). Usa la cuenta de desarrollo admin@admin.com.
import { randomUUID } from 'node:crypto';

const GATEWAY = process.env.GATEWAY ?? 'http://127.0.0.1:8080';
const PURCHASING = process.env.PURCHASING ?? 'http://127.0.0.1:3017';
let failures = 0;
const check = (name, ok, detail = '') => {
  if (!ok) failures += 1;
  console.log(`${ok ? 'OK   ' : 'FALLO'} ${name}${detail ? ' — ' + detail : ''}`);
};

// ── Datos reales del stack ──────────────────────────────────────────────────
const login = await (await fetch(`${GATEWAY}/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: 'admin@admin.com', password: 'admin' }) })).json();
const gw = (path) => fetch(`${GATEWAY}${path}`, { headers: { Authorization: `Bearer ${login.accessToken}` } }).then((r) => r.json());
const claims = JSON.parse(Buffer.from(login.accessToken.split('.')[1], 'base64url').toString());
const ORG = claims.org_id;
const product = (await gw('/products?pageSize=5')).items.find((p) => p.taxes?.length);
// La bodega se pide directo a inventory-service (el gateway la cierra si el módulo de bodegas no está activo en la organización de desarrollo).
const INVENTORY = process.env.INVENTORY ?? 'http://127.0.0.1:3013';
const warehouse = (await fetch(`${INVENTORY}/warehouses`, { headers: { 'X-Organization-Id': ORG, 'X-Permissions': 'inventory:read' } }).then((r) => r.json()))[0];
const rates = await gw('/countries/EC/tax-rates');
const iva15 = rates.find((r) => r.code === 'IVA15');
check('datos reales: producto, bodega y tarifa', Boolean(product && warehouse && iva15), `${product?.name} | ${warehouse?.name} | ${iva15?.code}`);

const MAKER = randomUUID();
const BOSS = randomUUID();
const ALL = 'supplier:read,supplier:manage,purchase:read,purchase:create,purchase:approve,purchase:cancel';
async function call(method, path, { user = MAKER, org = ORG, perms = ALL, body } = {}) {
  const res = await fetch(`${PURCHASING}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', 'X-Organization-Id': org, 'X-User-Id': user, 'X-Permissions': perms, 'X-Country-Code': 'EC' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, json: text ? JSON.parse(text) : null };
}

const ruc = () => `17${String(Math.floor(Math.random() * 1e8)).padStart(8, "0")}001`;
const orderBody = (supplierId, extra = {}) => ({
  supplierId, warehouseId: warehouse.id,
  lines: [{ productId: product.id, quantity: '10.5', unitCostCents: 250, taxRateId: iva15.id }],
  ...extra,
});

// ── Proveedor y orden ───────────────────────────────────────────────────────
const supplier = await call('POST', '/purchasing/suppliers', { body: { identificationType: 'RUC', identification: ruc(), legalName: 'Distribuidora e2e', paymentTermDays: 30 } });
check('crear proveedor', supplier.status === 201, supplier.json?.id);
const sid = supplier.json.id;

const order = await call('POST', '/purchasing/orders', { body: orderBody(sid) });
// 10,5 × 2,50 = 26,25 → 2625 (exacto); IVA 15 % = 393,75 → 394; total 3019
check('crear orden con catálogos reales', order.status === 201 && order.json.subtotalCents === 2625 && order.json.taxCents === 394 && order.json.totalCents === 3019,
  JSON.stringify({ sub: order.json.subtotalCents, iva: order.json.taxCents, tot: order.json.totalCents }));
check('la línea toma nombre del producto', order.json.lines?.[0]?.description === product.name, order.json.lines?.[0]?.description);

// ── Aprobación con umbral y separación de funciones ─────────────────────────
check('política de aprobación (umbral 0)', (await call('PUT', '/purchasing/settings', { body: { approvalThresholdCents: 0, defaultWarehouseId: warehouse.id } })).status === 200);
const sent = await call('POST', `/purchasing/orders/${order.json.id}/submit`);
check('enviar → pendiente de aprobación con número', sent.json.status === 'pending_approval' && /^OC-\d{4}-\d{6}$/.test(sent.json.number), sent.json.number);
const self = await call('POST', `/purchasing/orders/${order.json.id}/approve`);
check('quien la preparó no la aprueba', self.status === 403 && self.json.code === 'SELF_APPROVAL_NOT_ALLOWED');
// Dos aprobaciones SIMULTÁNEAS por dos jefes: una gana, la otra ve el estado nuevo (bloqueo de la fila).
const [a, b] = await Promise.all([
  call('POST', `/purchasing/orders/${order.json.id}/approve`, { user: BOSS }),
  call('POST', `/purchasing/orders/${order.json.id}/approve`, { user: randomUUID() }),
]);
const codes = [a.status, b.status].sort();
check('dos aprobaciones a la vez: una gana, la otra 409', codes[0] === 200 && codes[1] === 409, codes.join(','));

// ── Numeración concurrente ──────────────────────────────────────────────────
check('sin umbral: se aprueban solas', (await call('PUT', '/purchasing/settings', { body: { approvalThresholdCents: null } })).status === 200);
const drafts = await Promise.all(Array.from({ length: 30 }, () => call('POST', '/purchasing/orders', { body: orderBody(sid) })));
check('30 borradores creados', drafts.every((d) => d.status === 201));
const submits = await Promise.all(drafts.map((d) => call('POST', `/purchasing/orders/${d.json.id}/submit`)));
const numbers = submits.map((s) => s.json.number).sort();
const unique = new Set(numbers);
check('30 envíos simultáneos: 30 números distintos y SEGUIDOS, sin interbloqueos', submits.every((s) => s.status === 200) && unique.size === 30 && Number(numbers.at(-1).slice(-6)) - Number(numbers[0].slice(-6)) === 29,
  `${numbers[0]} … ${numbers.at(-1)} (estados ${[...new Set(submits.map((s) => s.status))]})`);

// ── Dos ediciones a la vez ──────────────────────────────────────────────────
const draft = (await call('POST', '/purchasing/orders', { body: orderBody(sid) })).json;
const edits = await Promise.all([1, 2, 3, 4].map((n) => call('PUT', `/purchasing/orders/${draft.id}`, { body: orderBody(sid, { notes: `edición ${n}` }) })));
const ok = edits.filter((e) => e.status === 200).length;
const finalDraft = (await call('GET', `/purchasing/orders/${draft.id}`)).json;
check('4 ediciones simultáneas: la versión avanza una por una sin pisarse', ok >= 1 && edits.every((e) => [200, 409].includes(e.status)) && finalDraft.version === 1 + ok, `éxitos=${ok}, versión=${finalDraft.version}`);

// ── Cancelación, aislamiento y permisos ─────────────────────────────────────
const approvedOne = submits[0].json;
check('cancelar lo aprobado sin purchase:cancel → 403', (await call('POST', `/purchasing/orders/${approvedOne.id}/cancel`, { perms: 'purchase:create,purchase:read', body: { reason: 'Ya no se necesita' } })).status === 403);
const cancelled = await call('POST', `/purchasing/orders/${approvedOne.id}/cancel`, { body: { reason: 'Ya no se necesita' } });
check('cancelar con permiso', cancelled.json?.status === 'cancelled');
const otherOrg = randomUUID();
check('otra organización no ve la orden (404)', (await call('GET', `/purchasing/orders/${approvedOne.id}`, { org: otherOrg })).status === 404);
check('otra organización ve 0 órdenes', (await call('GET', '/purchasing/orders', { org: otherOrg })).json.total === 0);
check('proveedor duplicado → 409', (await call('POST', '/purchasing/suppliers', { body: { identificationType: 'RUC', identification: supplier.json.identification, legalName: 'Repetido' } })).status === 409);
check('sin permiso → 403', (await call('GET', '/purchasing/orders', { perms: 'supplier:read' })).status === 403);

// ── Listado con filtros ─────────────────────────────────────────────────────
const list = await call('GET', `/purchasing/orders?supplierId=${sid}&status=approved&pageSize=100`);
check('listado filtrado por proveedor y estado', list.status === 200 && list.json.total >= 29 && list.json.items.every((o) => o.status === 'approved' && o.lines === undefined), `total=${list.json.total}`);
const search = await call('GET', `/purchasing/orders?q=${encodeURIComponent(numbers[3])}`);
check('búsqueda por número', search.json.total === 1);

// ── Eventos en el outbox ────────────────────────────────────────────────────
console.log(failures === 0 ? '\nTODO OK' : `\n${failures} verificaciones FALLARON`);
process.exit(failures === 0 ? 0 : 1);
