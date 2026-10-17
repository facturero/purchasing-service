import { beforeEach, describe, expect, it } from 'vitest';
import {
  CatalogUnavailableError,
  ConcurrentUpdateError,
  ForbiddenError,
  InvalidOrderStateError,
  OrderNotFoundError,
  SelfApprovalError,
  SupplierIdentificationExistsError,
  SupplierInactiveError,
  SupplierNotFoundError,
  ValidationError,
} from '../domain/errors.js';
import {
  InMemoryStore,
  IVA0,
  IVA15,
  ORG_A,
  ORG_B,
  PRODUCT_1,
  PRODUCT_2,
  USER_1,
  USER_2,
  WAREHOUSE,
  buildPurchasing,
  lineRequest,
  orderRequest,
  supplierInput,
} from './helpers.js';

let store: InMemoryStore;
let p: ReturnType<typeof buildPurchasing>;

beforeEach(() => {
  store = new InMemoryStore();
  p = buildPurchasing(store);
});

async function supplier(org = ORG_A, over: Record<string, unknown> = {}) {
  return p.uc.createSupplier.execute({ organizationId: org, input: supplierInput(over) as never });
}
async function draft(org = ORG_A, user = USER_1, over = {}) {
  const s = await supplier(org, { identification: `17900${String(Math.floor(Math.random() * 1e8)).padStart(8, '0')}` });
  return p.uc.createOrder.execute({ organizationId: org, userId: user, countryCode: 'EC', request: orderRequest(s.id, over) });
}
const approvalFrom = async (cents: number | null) => p.uc.updateSettings.execute({ organizationId: ORG_A, changes: { approvalThresholdCents: cents } });

describe('proveedores', () => {
  it('se crean, publican su evento y no se repiten por organización', async () => {
    const s = await supplier();
    expect(s).toMatchObject({ status: 'active', identification: '1790012345001', paymentTermDays: 30 });
    expect(store.eventTypes()).toEqual(['purchasing.supplier.upserted']);
    await expect(supplier()).rejects.toThrow(SupplierIdentificationExistsError);
    // Otra organización sí puede tener al mismo proveedor.
    await expect(supplier(ORG_B)).resolves.toMatchObject({ organizationId: ORG_B });
  });

  it('se editan salvo su identificación, y se desactivan y reactivan', async () => {
    const s = await supplier();
    const edited = await p.uc.updateSupplier.execute({ organizationId: ORG_A, supplierId: s.id, input: { legalName: 'Nuevo nombre', email: 'a@b.ec' } });
    expect(edited).toMatchObject({ legalName: 'Nuevo nombre', email: 'a@b.ec', identification: s.identification, identificationType: 'RUC' });
    expect((await p.uc.setSupplierStatus.execute({ organizationId: ORG_A, supplierId: s.id, status: 'inactive' })).status).toBe('inactive');
    expect((await p.uc.setSupplierStatus.execute({ organizationId: ORG_A, supplierId: s.id, status: 'active' })).status).toBe('active');
    expect(store.eventTypes().filter((t) => t === 'purchasing.supplier.upserted')).toHaveLength(4);
  });

  it('no se ven ni se tocan desde otra organización', async () => {
    const s = await supplier();
    await expect(p.uc.getSupplier.execute({ organizationId: ORG_B, supplierId: s.id })).rejects.toThrow(SupplierNotFoundError);
    await expect(p.uc.updateSupplier.execute({ organizationId: ORG_B, supplierId: s.id, input: { legalName: 'x' } })).rejects.toThrow(SupplierNotFoundError);
    expect((await p.uc.listSuppliers.execute({ organizationId: ORG_B, filters: { page: 1, pageSize: 10 } })).total).toBe(0);
  });

  it('busca por nombre o identificación y filtra por estado', async () => {
    await supplier(ORG_A, { legalName: 'Andina', identification: '1790012345001' });
    const b = await supplier(ORG_A, { legalName: 'Bodegas del Sur', identification: '0990012345001' });
    await p.uc.setSupplierStatus.execute({ organizationId: ORG_A, supplierId: b.id, status: 'inactive' });
    const list = (q: object) => p.uc.listSuppliers.execute({ organizationId: ORG_A, filters: { page: 1, pageSize: 10, ...q } });
    expect((await list({ q: 'sur' })).items.map((s) => s.legalName)).toEqual(['Bodegas del Sur']);
    expect((await list({ q: '1790' })).total).toBe(1);
    expect((await list({ status: 'active' })).items.map((s) => s.legalName)).toEqual(['Andina']);
  });
});

describe('crear y editar una orden', () => {
  it('arma la línea con el catálogo: nombre, SKU e IVA del producto', async () => {
    const o = await draft();
    expect(o).toMatchObject({ status: 'draft', number: null, subtotalCents: 2500, taxCents: 375, totalCents: 2875, paymentTermDays: 30, currencyCode: 'USD', orderDate: '2026-10-20' });
    expect(o.lines[0]).toMatchObject({ description: 'Papel bond A4', sku: 'PAP-A4', taxRateId: IVA15, taxPercent: '15.00', quantityMicros: 10_000_000n });
    expect(store.eventTypes()).toContain('purchasing.order.created');
  });

  it('la fecha de hoy es la de Ecuador, no la de UTC', async () => {
    const late = buildPurchasing(store, () => new Date('2026-10-21T02:00:00Z')); // 21:00 del 20 en Guayaquil
    const s = await late.uc.createSupplier.execute({ organizationId: ORG_A, input: supplierInput() as never });
    const o = await late.uc.createOrder.execute({ organizationId: ORG_A, userId: USER_1, countryCode: 'EC', request: orderRequest(s.id) });
    expect(o.orderDate).toBe('2026-10-20');
  });

  it('el IVA se puede elegir, o quitar con null', async () => {
    const s = await supplier();
    const o = await p.uc.createOrder.execute({
      organizationId: ORG_A, userId: USER_1, countryCode: 'EC',
      request: orderRequest(s.id, { lines: [lineRequest({ taxRateId: IVA0 }), lineRequest({ productId: PRODUCT_2, taxRateId: null, quantity: '1.5', unitCostCents: 1000 })] }),
    });
    expect(o.lines.map((l) => [l.taxPercent, l.taxCents])).toEqual([['0.00', 0], ['0.00', 0]]);
    expect(o.lines[1]!.subtotalCents).toBe(1500);
  });

  it.each([
    ['proveedor inexistente', (id: string) => {
      const last = id[id.length - 1] ?? '0';
      const mutated = id.slice(0, -1) + (last === '0' ? '1' : '0');
      return orderRequest(mutated);
    }],
    ['bodega inexistente', (id: string) => orderRequest(id, { warehouseId: '00000000-0000-4000-8000-000000000000' })],
    ['producto inexistente', (id: string) => orderRequest(id, { lines: [lineRequest({ productId: '00000000-0000-4000-8000-000000000000' })] })],
    ['tarifa inexistente', (id: string) => orderRequest(id, { lines: [lineRequest({ taxRateId: '00000000-0000-4000-8000-000000000000' })] })],
    ['una retención no es IVA', (id: string) => orderRequest(id, { lines: [lineRequest({ taxRateId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' })] })],
    ['cantidad cero', (id: string) => orderRequest(id, { lines: [lineRequest({ quantity: '0' })] })],
  ])('rechaza %s', async (_name, build) => {
    const s = await supplier();
    await expect(p.uc.createOrder.execute({ organizationId: ORG_A, userId: USER_1, countryCode: 'EC', request: build(s.id) })).rejects.toThrow(/no existe|Proveedor no|Solo se admite|mayor que cero/);
    expect(store.orderMap.size).toBe(0);
  });

  it('un proveedor inactivo no recibe pedidos', async () => {
    const s = await supplier();
    await p.uc.setSupplierStatus.execute({ organizationId: ORG_A, supplierId: s.id, status: 'inactive' });
    await expect(p.uc.createOrder.execute({ organizationId: ORG_A, userId: USER_1, countryCode: 'EC', request: orderRequest(s.id) })).rejects.toThrow(SupplierInactiveError);
  });

  it('si un catálogo no responde, no se inventa nada: 502', async () => {
    const s = await supplier();
    p.catalogs.down = true;
    await expect(p.uc.createOrder.execute({ organizationId: ORG_A, userId: USER_1, countryCode: 'EC', request: orderRequest(s.id) })).rejects.toThrow(CatalogUnavailableError);
    expect(store.orderMap.size).toBe(0);
  });

  it('un borrador se edita; dos ediciones a la vez no se pisan', async () => {
    const o = await draft();
    const edited = await p.uc.updateOrder.execute({
      organizationId: ORG_A, orderId: o.id, countryCode: 'EC',
      request: orderRequest(o.supplierId, { lines: [lineRequest({ quantity: '20' })], notes: 'urgente' }),
    });
    expect(edited).toMatchObject({ subtotalCents: 5000, notes: 'urgente', version: 2 });
    // Una escritura con la versión vieja (otra persona guardó antes) se rechaza.
    await expect(store.orders.save({ ...edited, notes: 'pisada' }, 1)).rejects.toThrow(ConcurrentUpdateError);
    expect(store.orderMap.get(o.id)!.notes).toBe('urgente');
  });

  it('otra organización no ve ni edita la orden', async () => {
    const o = await draft();
    await expect(p.uc.getOrder.execute({ organizationId: ORG_B, orderId: o.id })).rejects.toThrow(OrderNotFoundError);
    await expect(p.uc.submitOrder.execute({ organizationId: ORG_B, orderId: o.id })).rejects.toThrow(OrderNotFoundError);
    expect((await p.uc.listOrders.execute({ organizationId: ORG_B, filters: { page: 1, pageSize: 10 } })).total).toBe(0);
  });
});

describe('enviar, aprobar y cancelar', () => {
  it('sin política de aprobación, enviar la deja aprobada, numerada y con su compromiso anunciado', async () => {
    const o = await draft();
    const sent = await p.uc.submitOrder.execute({ organizationId: ORG_A, orderId: o.id });
    expect(sent).toMatchObject({ status: 'approved', number: 'OC-2026-000001', approvedBy: null });
    expect(store.eventTypes()).toEqual(expect.arrayContaining(['purchasing.order.submitted', 'purchasing.order.approved']));
    const approved = store.outboxEvents.find((e) => e.type === 'purchasing.order.approved')!;
    expect(approved.payload).toMatchObject({ approvedByPolicy: true, totalCents: 2875, lines: [{ productId: PRODUCT_1, quantity: '10', unitCostCents: 250 }] });
  });

  it('la numeración sigue por año y organización', async () => {
    const a = await draft();
    const b = await draft();
    const first = await p.uc.submitOrder.execute({ organizationId: ORG_A, orderId: a.id });
    const second = await p.uc.submitOrder.execute({ organizationId: ORG_A, orderId: b.id });
    expect([first.number, second.number]).toEqual(['OC-2026-000001', 'OC-2026-000002']);
    const other = await draft(ORG_B);
    expect((await p.uc.submitOrder.execute({ organizationId: ORG_B, orderId: other.id })).number).toBe('OC-2026-000001');
  });

  it('con umbral, las órdenes grandes esperan a que las apruebe OTRA persona', async () => {
    await approvalFrom(2000);
    const o = await draft();
    const sent = await p.uc.submitOrder.execute({ organizationId: ORG_A, orderId: o.id });
    expect(sent.status).toBe('pending_approval');
    expect(store.eventTypes()).not.toContain('purchasing.order.approved');

    await expect(p.uc.approveOrder.execute({ organizationId: ORG_A, orderId: o.id, userId: USER_1 })).rejects.toThrow(SelfApprovalError);
    const approved = await p.uc.approveOrder.execute({ organizationId: ORG_A, orderId: o.id, userId: USER_2 });
    expect(approved).toMatchObject({ status: 'approved', approvedBy: USER_2 });
    expect(store.eventTypes()).toContain('purchasing.order.approved');
    await expect(p.uc.approveOrder.execute({ organizationId: ORG_A, orderId: o.id, userId: USER_2 })).rejects.toThrow(InvalidOrderStateError);
  });

  it('una orden por debajo del umbral se aprueba sola', async () => {
    await approvalFrom(10_000);
    const o = await draft();
    expect((await p.uc.submitOrder.execute({ organizationId: ORG_A, orderId: o.id })).status).toBe('approved');
  });

  it('rechazada vuelve a borrador para corregirla y reenviarla, con otro número no: conserva el suyo hasta reenviar', async () => {
    await approvalFrom(0);
    const o = await draft();
    await p.uc.submitOrder.execute({ organizationId: ORG_A, orderId: o.id });
    const rejected = await p.uc.rejectOrder.execute({ organizationId: ORG_A, orderId: o.id, userId: USER_2, reason: 'Precio alto' });
    expect(rejected).toMatchObject({ status: 'rejected', rejectionReason: 'Precio alto' });
    const reopened = await p.uc.reopenOrder.execute({ organizationId: ORG_A, orderId: o.id });
    expect(reopened.status).toBe('draft');
    await p.uc.updateOrder.execute({ organizationId: ORG_A, orderId: o.id, countryCode: 'EC', request: orderRequest(o.supplierId, { lines: [lineRequest({ unitCostCents: 200 })] }) });
    const again = await p.uc.submitOrder.execute({ organizationId: ORG_A, orderId: o.id });
    expect(again.status).toBe('pending_approval');
    expect(store.eventTypes()).toEqual(expect.arrayContaining(['purchasing.order.rejected', 'purchasing.order.reopened']));
  });

  it('cancelar lo aprobado pide el permiso de cancelar; cancelar un borrador no', async () => {
    const o = await draft();
    const sent = await p.uc.submitOrder.execute({ organizationId: ORG_A, orderId: o.id });
    await expect(p.uc.cancelOrder.execute({ organizationId: ORG_A, orderId: sent.id, userId: USER_1, reason: 'Ya no', allowApproved: false })).rejects.toThrow(ForbiddenError);
    const cancelled = await p.uc.cancelOrder.execute({ organizationId: ORG_A, orderId: sent.id, userId: USER_1, reason: 'Ya no se necesita', allowApproved: true });
    expect(cancelled.status).toBe('cancelled');
    const d = await draft();
    expect((await p.uc.cancelOrder.execute({ organizationId: ORG_A, orderId: d.id, userId: USER_1, reason: 'Error de captura', allowApproved: false })).status).toBe('cancelled');
    expect(store.eventTypes().filter((t) => t === 'purchasing.order.cancelled')).toHaveLength(2);
  });

  it('un fallo a mitad no deja nada a medias (la numeración no se quema)', async () => {
    const o = await draft();
    store.orders.save = async () => {
      throw new Error('disco lleno');
    };
    await expect(p.uc.submitOrder.execute({ organizationId: ORG_A, orderId: o.id })).rejects.toThrow('disco lleno');
    expect(store.sequences.size).toBe(0);
    expect(store.eventTypes()).not.toContain('purchasing.order.submitted');
  });
});

describe('listado', () => {
  it('filtra por estado, proveedor, fechas y texto, sin mezclar organizaciones', async () => {
    const a = await draft();
    const b = await draft();
    await p.uc.submitOrder.execute({ organizationId: ORG_A, orderId: a.id });
    await draft(ORG_B);
    const list = (f: object) => p.uc.listOrders.execute({ organizationId: ORG_A, filters: { page: 1, pageSize: 10, ...f } });
    expect((await list({})).total).toBe(2);
    expect((await list({ status: 'approved' })).items.map((o) => o.id)).toEqual([a.id]);
    expect((await list({ status: 'draft' })).items.map((o) => o.id)).toEqual([b.id]);
    expect((await list({ supplierId: b.supplierId })).total).toBe(1);
    expect((await list({ q: 'OC-2026-000001' })).total).toBe(1);
    expect((await list({ from: '2026-10-21' })).total).toBe(0);
    expect((await list({ to: '2026-10-20' })).total).toBe(2);
  });
});

describe('ajustes', () => {
  it('por defecto no se exige aprobación', async () => {
    expect(await p.uc.getSettings.execute({ organizationId: ORG_A })).toMatchObject({ approvalThresholdCents: null, defaultWarehouseId: null });
  });

  it('se guardan, validan la bodega y publican su evento', async () => {
    const saved = await p.uc.updateSettings.execute({ organizationId: ORG_A, changes: { approvalThresholdCents: 50_000, defaultWarehouseId: WAREHOUSE } });
    expect(saved).toMatchObject({ approvalThresholdCents: 50_000, defaultWarehouseId: WAREHOUSE });
    expect(store.eventTypes()).toContain('purchasing.settings.updated');
    await expect(p.uc.updateSettings.execute({ organizationId: ORG_A, changes: { defaultWarehouseId: '00000000-0000-4000-8000-000000000000' } })).rejects.toThrow(ValidationError);
    expect((await p.uc.updateSettings.execute({ organizationId: ORG_A, changes: { approvalThresholdCents: null } })).defaultWarehouseId).toBe(WAREHOUSE);
  });
});
