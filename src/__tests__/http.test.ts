import { beforeEach, describe, expect, it } from 'vitest';
import { InMemoryStore, ORG_A, ORG_B, PRODUCT_1, USER_1, USER_2, WAREHOUSE, buildPurchasing } from './helpers.js';

let store: InMemoryStore;
let p: ReturnType<typeof buildPurchasing>;

beforeEach(() => {
  store = new InMemoryStore();
  p = buildPurchasing(store);
});

const ALL = ['supplier:read', 'supplier:manage', 'purchase:read', 'purchase:create', 'purchase:approve', 'purchase:cancel'];

async function call(method: string, path: string, opts: { org?: string; user?: string; perms?: string[]; body?: unknown } = {}) {
  const headers: Record<string, string> = { 'Content-Type': 'application/json', 'X-Country-Code': 'EC' };
  if (opts.org !== null) headers['X-Organization-Id'] = opts.org ?? ORG_A;
  headers['X-User-Id'] = opts.user ?? USER_1;
  headers['X-Permissions'] = (opts.perms ?? ALL).join(',');
  const res = await p.app.request(path, { method, headers, body: opts.body === undefined || method === 'GET' ? undefined : JSON.stringify(opts.body) });
  const text = await res.text();
  return { status: res.status, json: text ? JSON.parse(text) : null };
}

const supplierBody = { identificationType: 'RUC', identification: '1790012345001', legalName: 'Distribuidora Andina', paymentTermDays: 30 };
const orderBody = (supplierId: string) => ({ supplierId, warehouseId: WAREHOUSE, lines: [{ productId: PRODUCT_1, quantity: '10', unitCostCents: 250 }] });

describe('contexto y permisos', () => {
  it('sin organización responde 401', async () => {
    expect((await call('GET', '/purchasing/suppliers', { org: null as never })).status).toBe(401);
  });

  it.each([
    ['GET', '/purchasing/suppliers', 'supplier:read'],
    ['POST', '/purchasing/suppliers', 'supplier:manage'],
    ['GET', '/purchasing/orders', 'purchase:read'],
    ['POST', '/purchasing/orders', 'purchase:create'],
    ['POST', '/purchasing/orders/00000000-0000-4000-8000-000000000000/approve', 'purchase:approve'],
    ['POST', '/purchasing/orders/00000000-0000-4000-8000-000000000000/reject', 'purchase:approve'],
    ['PUT', '/purchasing/settings', 'purchase:approve'],
    ['GET', '/purchasing/settings', 'purchase:read'],
  ])('%s %s exige %s', async (method, path, perm) => {
    const without = await call(method, path, { perms: ALL.filter((x) => x !== perm), body: {} });
    expect(without.status).toBe(403);
    expect(without.json.code).toBe('FORBIDDEN');
  });

  it('el 404 de una ruta que no existe es de verdad 404', async () => {
    expect((await call('GET', '/purchasing/nada')).status).toBe(404);
  });
});

describe('proveedores por HTTP', () => {
  it('alta, lectura, edición y baja', async () => {
    const created = await call('POST', '/purchasing/suppliers', { body: supplierBody });
    expect(created.status).toBe(201);
    expect(created.json).toMatchObject({ identification: '1790012345001', status: 'active', paymentTermDays: 30 });
    const id = created.json.id;
    expect((await call('GET', `/purchasing/suppliers/${id}`)).json.legalName).toBe('Distribuidora Andina');
    const edited = await call('PUT', `/purchasing/suppliers/${id}`, { body: { legalName: 'Andina S.A.', paymentTermDays: 15 } });
    expect(edited.json).toMatchObject({ legalName: 'Andina S.A.', paymentTermDays: 15, identification: '1790012345001' });
    expect((await call('POST', `/purchasing/suppliers/${id}/deactivate`)).json.status).toBe('inactive');
    expect((await call('GET', '/purchasing/suppliers?status=active')).json.total).toBe(0);
    expect((await call('POST', '/purchasing/suppliers', { body: supplierBody })).status).toBe(409);
  });

  it('valida el cuerpo con 422 y dice qué campo; rechaza campos desconocidos', async () => {
    const bad = await call('POST', '/purchasing/suppliers', { body: { ...supplierBody, identification: '12' } });
    expect(bad.status).toBe(422);
    expect(bad.json.details[0].field).toBe('identification');
    expect((await call('POST', '/purchasing/suppliers', { body: { ...supplierBody, organizationId: ORG_B } })).status).toBe(422);
    // La identificación no se cambia por PUT.
    const created = await call('POST', '/purchasing/suppliers', { body: supplierBody });
    expect((await call('PUT', `/purchasing/suppliers/${created.json.id}`, { body: { legalName: 'x', identification: '1790012345002' } })).status).toBe(422);
  });

  it('el tamaño de página se acota', async () => {
    expect((await call('GET', '/purchasing/suppliers?pageSize=100000')).status).toBe(422);
    expect((await call('GET', '/purchasing/suppliers?page=abc')).status).toBe(422);
  });
});

describe('órdenes por HTTP', () => {
  async function supplierId() {
    return (await call('POST', '/purchasing/suppliers', { body: supplierBody })).json.id as string;
  }

  it('el recorrido completo: crear, enviar con aprobación, aprobar por otra persona', async () => {
    await call('PUT', '/purchasing/settings', { body: { approvalThresholdCents: 1000 } });
    const created = await call('POST', '/purchasing/orders', { body: orderBody(await supplierId()) });
    expect(created.status).toBe(201);
    expect(created.json).toMatchObject({ status: 'draft', totalCents: 2875, lines: [{ quantity: '10', description: 'Papel bond A4', taxPercent: '15.00' }] });
    const id = created.json.id;

    const sent = await call('POST', `/purchasing/orders/${id}/submit`);
    expect(sent.json).toMatchObject({ status: 'pending_approval', number: 'OC-2026-000001' });

    const self = await call('POST', `/purchasing/orders/${id}/approve`);
    expect(self.status).toBe(403);
    expect(self.json.code).toBe('SELF_APPROVAL_NOT_ALLOWED');

    const approved = await call('POST', `/purchasing/orders/${id}/approve`, { user: USER_2 });
    expect(approved.json).toMatchObject({ status: 'approved', approvedBy: USER_2, approvedByPolicy: false });
    expect((await call('POST', `/purchasing/orders/${id}/approve`, { user: USER_2 })).status).toBe(409);
  });

  it('el listado trae el resumen sin las líneas; el detalle las trae', async () => {
    const created = await call('POST', '/purchasing/orders', { body: orderBody(await supplierId()) });
    const list = await call('GET', '/purchasing/orders');
    expect(list.json.items[0]).toMatchObject({ id: created.json.id, lineCount: 1 });
    expect(list.json.items[0].lines).toBeUndefined();
    expect((await call('GET', `/purchasing/orders/${created.json.id}`)).json.lines).toHaveLength(1);
  });

  it('rechazar pide motivo; cancelar lo aprobado exige purchase:cancel', async () => {
    await call('PUT', '/purchasing/settings', { body: { approvalThresholdCents: 0 } });
    const created = await call('POST', '/purchasing/orders', { body: orderBody(await supplierId()) });
    const id = created.json.id;
    await call('POST', `/purchasing/orders/${id}/submit`);
    expect((await call('POST', `/purchasing/orders/${id}/reject`, { user: USER_2, body: {} })).status).toBe(422);
    const rejected = await call('POST', `/purchasing/orders/${id}/reject`, { user: USER_2, body: { reason: 'Precio alto' } });
    expect(rejected.json).toMatchObject({ status: 'rejected', rejectionReason: 'Precio alto' });
    expect((await call('POST', `/purchasing/orders/${id}/reopen`)).json.status).toBe('draft');

    await call('PUT', '/purchasing/settings', { body: { approvalThresholdCents: null } });
    await call('POST', `/purchasing/orders/${id}/submit`);
    const noCancel = ALL.filter((x) => x !== 'purchase:cancel');
    expect((await call('POST', `/purchasing/orders/${id}/cancel`, { perms: noCancel, body: { reason: 'Ya no' } })).status).toBe(403);
    expect((await call('POST', `/purchasing/orders/${id}/cancel`, { body: { reason: 'Ya no se necesita' } })).json.status).toBe('cancelled');
  });

  it('valida el cuerpo: sin líneas, cantidad rara, campos de más', async () => {
    const sid = await supplierId();
    expect((await call('POST', '/purchasing/orders', { body: { ...orderBody(sid), lines: [] } })).status).toBe(422);
    expect((await call('POST', '/purchasing/orders', { body: { ...orderBody(sid), lines: [{ productId: PRODUCT_1, quantity: '0', unitCostCents: 250 }] } })).status).toBe(422);
    expect((await call('POST', '/purchasing/orders', { body: { ...orderBody(sid), status: 'approved' } })).status).toBe(422);
    expect((await call('POST', '/purchasing/orders', { body: { ...orderBody(sid), lines: [{ productId: PRODUCT_1, quantity: '1', unitCostCents: 1.5 }] } })).status).toBe(422);
  });

  it('un catálogo caído responde 502 y no crea nada', async () => {
    const sid = await supplierId();
    p.catalogs.down = true;
    const res = await call('POST', '/purchasing/orders', { body: orderBody(sid) });
    expect(res.status).toBe(502);
    expect(res.json.code).toBe('CATALOG_UNAVAILABLE');
    expect(store.orderMap.size).toBe(0);
  });
});

describe('aislamiento entre organizaciones', () => {
  it('una organización no ve ni toca lo de otra', async () => {
    const s = (await call('POST', '/purchasing/suppliers', { body: supplierBody })).json;
    const o = (await call('POST', '/purchasing/orders', { body: orderBody(s.id) })).json;
    for (const [method, path] of [
      ['GET', `/purchasing/suppliers/${s.id}`],
      ['PUT', `/purchasing/suppliers/${s.id}`],
      ['POST', `/purchasing/suppliers/${s.id}/deactivate`],
      ['GET', `/purchasing/orders/${o.id}`],
      ['POST', `/purchasing/orders/${o.id}/submit`],
      ['POST', `/purchasing/orders/${o.id}/cancel`],
    ] as const) {
      const res = await call(method, path, { org: ORG_B, body: method === 'PUT' ? { legalName: 'x' } : { reason: 'intento' } });
      expect(res.status, `${method} ${path}`).toBe(404);
    }
    expect((await call('GET', '/purchasing/orders', { org: ORG_B })).json.total).toBe(0);
    expect((await call('GET', '/purchasing/suppliers', { org: ORG_B })).json.total).toBe(0);
  });

  it('no se crea una orden de otra organización con un proveedor ajeno', async () => {
    const s = (await call('POST', '/purchasing/suppliers', { body: supplierBody })).json;
    const res = await call('POST', '/purchasing/orders', { org: ORG_B, body: orderBody(s.id) });
    expect(res.status).toBe(404);
    expect(res.json.code).toBe('SUPPLIER_NOT_FOUND');
  });
});
