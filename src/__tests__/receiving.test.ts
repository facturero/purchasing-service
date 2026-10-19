import { beforeEach, describe, expect, it } from 'vitest';
import {
  ConcurrentUpdateError,
  DuplicateReceiptLineError,
  LineNotInOrderError,
  OrderNotFoundError,
  OrderNotReceivableError,
  OverReceiptError,
  ValidationError,
} from '../domain/errors.js';
import {
  InMemoryStore,
  ORG_A,
  ORG_B,
  PRODUCT_1,
  USER_1,
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

let seq = 0;
const nextIdent = () => `17900${String(++seq).padStart(8, '0')}`;

async function supplier(org = ORG_A) {
  return p.uc.createSupplier.execute({ organizationId: org, input: supplierInput({ identification: nextIdent() }) as never });
}

/** Orden aprobada lista para recibir: 10 x 250 de un solo producto. */
async function approvedOrder(org = ORG_A, over: Record<string, unknown> = {}) {
  const s = await supplier(org);
  const draft = await p.uc.createOrder.execute({
    organizationId: org,
    userId: USER_1,
    countryCode: 'EC',
    request: orderRequest(s.id, { warehouseId: WAREHOUSE, lines: [lineRequest(over)] }),
  });
  const order = await p.uc.submitOrder.execute({ organizationId: org, orderId: draft.id });
  return { supplier: s, order, orderLineId: order.lines[0]!.id };
}

const receive = (orderId: string, lines: Array<{ orderLineId: string; quantity: string }>, org = ORG_A, receiptDate = '2026-10-20') =>
  p.uc.receiveOrder.execute({ organizationId: org, input: { orderId, userId: USER_1, receiptDate, lines } });

describe('recepción de mercadería', () => {
  it('recibir todo deja la orden en received y numera la recepción RM-AAAA-NNNNNN', async () => {
    const { order, orderLineId } = await approvedOrder();
    const { order: updated, receiptId, receiptNumber } = await receive(order.id, [{ orderLineId, quantity: '10' }]);

    expect(receiptNumber).toBe('RM-2026-000001');
    expect(updated.status).toBe('received');
    expect(updated.lines[0]!.receivedMicros).toBe(10_000_000n);

    const receipt = await p.uc.getReceipt.execute({ organizationId: ORG_A, receiptId });
    expect(receipt).toMatchObject({ number: 'RM-2026-000001', purchaseOrderId: order.id, supplierId: order.supplierId });
    expect(receipt.lines).toHaveLength(1);
    expect(receipt.lines[0]!.quantityMicros).toBe(10_000_000n);

    // Contrato con inventory-service y evento propio de auditoría.
    expect(store.eventTypes()).toContain('purchase.purchase_order.received');
    expect(store.eventTypes()).toContain('purchasing.receipt.posted');
    expect(store.eventTypes()).toContain('purchasing.order.received');
  });

  it('recibir parcial queda partially_received y la segunda recepción completa', async () => {
    const { order, orderLineId } = await approvedOrder();
    const partial = await receive(order.id, [{ orderLineId, quantity: '4' }]);
    expect(partial.order.status).toBe('partially_received');

    const complete = await receive(order.id, [{ orderLineId, quantity: '6' }]);
    expect(complete.order.status).toBe('received');
    expect(complete.order.lines[0]!.receivedMicros).toBe(10_000_000n);
    // El consecutivo avanza por recepción, no se repite.
    expect(partial.receiptNumber).toBe('RM-2026-000001');
    expect(complete.receiptNumber).toBe('RM-2026-000002');
  });

  it('con tolerancia 0 no deja sobre-recibir, y el administrador puede holgarla', async () => {
    const { order, orderLineId } = await approvedOrder();
    await expect(receive(order.id, [{ orderLineId, quantity: '11' }])).rejects.toThrow(OverReceiptError);

    // La tolerancia no está en el código: la fija el administrador por la API de settings.
    await p.uc.updateSettings.execute({ organizationId: ORG_A, changes: { overReceiptToleranceBp: 1000 } });

    // 10 + 10% = 11 es justo el techo: se acepta.
    const t1 = await approvedOrder();
    const { order: holgada } = await receive(t1.order.id, [{ orderLineId: t1.orderLineId, quantity: '11' }]);
    expect(holgada.lines[0]!.receivedMicros).toBe(11_000_000n);

    // Un micro más allá del techo se rechaza (misma tolerancia, otra orden).
    const t2 = await approvedOrder();
    await expect(receive(t2.order.id, [{ orderLineId: t2.orderLineId, quantity: '11.000001' }])).rejects.toThrow(OverReceiptError);
  });

  it('no permite recibir una orden en borrador, ya completa o cerrada', async () => {
    const s = await supplier();
    const draft = await p.uc.createOrder.execute({ organizationId: ORG_A, userId: USER_1, countryCode: 'EC', request: orderRequest(s.id, { lines: [lineRequest()] }) });
    await expect(receive(draft.id, [{ orderLineId: draft.lines[0]!.id, quantity: '1' }])).rejects.toThrow(OrderNotReceivableError);

    const { order, orderLineId } = await approvedOrder();
    await receive(order.id, [{ orderLineId, quantity: '10' }]);
    // Ya está 'received': no admite más.
    await expect(receive(order.id, [{ orderLineId, quantity: '1' }])).rejects.toThrow(OrderNotReceivableError);

    const other = await approvedOrder();
    await p.uc.closeOrder.execute({ organizationId: ORG_A, input: { orderId: other.order.id, userId: USER_1, reason: 'El proveedor no enviará el resto' } });
    await expect(receive(other.order.id, [{ orderLineId: other.orderLineId, quantity: '1' }])).rejects.toThrow(OrderNotReceivableError);
  });

  it('rechaza líneas repetidas, líneas que no son de la orden y cantidades ≤ 0', async () => {
    const { order, orderLineId } = await approvedOrder();
    await expect(receive(order.id, [{ orderLineId, quantity: '1' }, { orderLineId, quantity: '2' }])).rejects.toThrow(DuplicateReceiptLineError);
    await expect(receive(order.id, [{ orderLineId: '00000000-0000-4000-8000-000000000000', quantity: '1' }])).rejects.toThrow(LineNotInOrderError);
    await expect(receive(order.id, [{ orderLineId, quantity: '0' }])).rejects.toThrow(ValidationError);
    await expect(receive(order.id, [{ orderLineId, quantity: '-1' }])).rejects.toThrow(ValidationError);
    await expect(receive(order.id, [{ orderLineId, quantity: 'no-es-numero' }])).rejects.toThrow(ValidationError);
  });

  it('otra organización no puede recibir ni ver la orden', async () => {
    const { order, orderLineId } = await approvedOrder();
    await expect(receive(order.id, [{ orderLineId, quantity: '1' }], ORG_B)).rejects.toThrow(OrderNotFoundError);
    // Nada se guardó ni salió ningún evento.
    expect(store.receiptMap.size).toBe(0);
  });

  it('la recepción queda en el listado y se puede filtrar por orden', async () => {
    const { order, orderLineId } = await approvedOrder();
    await receive(order.id, [{ orderLineId, quantity: '4' }]);
    const own = await p.uc.listReceipts.execute({ organizationId: ORG_A, filters: { purchaseOrderId: order.id, page: 1, pageSize: 10 } });
    expect(own.total).toBe(1);
    expect(own.items[0]).toMatchObject({ number: 'RM-2026-000001', purchaseOrderId: order.id });
    // Otra organización no ve nada.
    expect((await p.uc.listReceipts.execute({ organizationId: ORG_B, filters: { page: 1, pageSize: 10 } })).total).toBe(0);
  });

  it('cerrar una orden aprobada da por terminado lo pendiente', async () => {
    const { order } = await approvedOrder();
    const closed = await p.uc.closeOrder.execute({ organizationId: ORG_A, input: { orderId: order.id, userId: USER_1, reason: 'El proveedor ya no fabrica' } });
    expect(closed.status).toBe('closed');
    expect(store.eventTypes()).toContain('purchasing.order.closed');
  });

  it('no se cierra una orden en borrador', async () => {
    const s = await supplier();
    const draft = await p.uc.createOrder.execute({ organizationId: ORG_A, userId: USER_1, countryCode: 'EC', request: orderRequest(s.id, { lines: [lineRequest()] }) });
    await expect(
      p.uc.closeOrder.execute({ organizationId: ORG_A, input: { orderId: draft.id, userId: USER_1, reason: 'No sigue' } }),
    ).rejects.toThrow(ValidationError);
  });

  it('una orden modificada por otro no se recibe a ciegas (conflicto de versión)', async () => {
    const { order, orderLineId } = await approvedOrder();
    const first = await receive(order.id, [{ orderLineId, quantity: '4' }]);
    // Alguien guardó con la versión vieja: se rechaza en vez de pisar lo recibido.
    await expect(store.orders.save({ ...first.order, notes: 'pisada' }, order.version)).rejects.toThrow(ConcurrentUpdateError);
    expect(store.orderMap.get(order.id)!.lines[0]!.receivedMicros).toBe(4_000_000n);
  });
});

describe('recepción por HTTP', () => {
  const ALL = ['supplier:manage', 'purchase:read', 'purchase:create', 'purchase:approve', 'receipt:create', 'purchase_bill:read'];
  const call = async (method: string, path: string, body?: unknown, perms: string[] = ALL) => {
    const res = await p.app.request(path, {
      method,
      headers: { 'Content-Type': 'application/json', 'X-Organization-Id': ORG_A, 'X-User-Id': USER_1, 'X-Permissions': perms.join(',') },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const text = await res.text();
    return { status: res.status, json: text ? JSON.parse(text) : null };
  };

  it('registra la recepción con la cantidad en texto y responde 201', async () => {
    const { order, orderLineId } = await approvedOrder();
    const res = await call('POST', `/purchasing/orders/${order.id}/receipts`, { receiptDate: '2026-10-20', lines: [{ orderLineId, quantity: '10' }] });
    expect(res.status).toBe(201);
    expect(res.json).toMatchObject({ receiptNumber: 'RM-2026-000001' });

    const detail = await call('GET', `/purchasing/receipts/${res.json.receiptId}`);
    expect(detail.status).toBe(200);
    expect(detail.json).toMatchObject({ number: 'RM-2026-000001', lineCount: 1 });
    expect(detail.json.lines[0]).toMatchObject({ orderLineId, quantity: '10', unitCostCents: 250 });
  });

  it('la sobre-recepción responde 422 con el código del dominio', async () => {
    const { order, orderLineId } = await approvedOrder();
    const res = await call('POST', `/purchasing/orders/${order.id}/receipts`, { receiptDate: '2026-10-20', lines: [{ orderLineId, quantity: '11' }] });
    expect(res.status).toBe(422);
    expect(res.json.code).toBe('OVER_RECEIPT');
  });

  it('exige el permiso de recepción', async () => {
    const { order } = await approvedOrder();
    const res = await call('POST', `/purchasing/orders/${order.id}/receipts`, { receiptDate: '2026-10-20', lines: [] }, ['purchase:read']);
    expect(res.status).toBe(403);
  });
});

describe('evento a inventory-service', () => {
  const receivedEvents = () => store.outboxEvents.filter((e) => e.type === 'purchase.purchase_order.received');
  const postedEvents = () => store.outboxEvents.filter((e) => e.type === 'purchasing.receipt.posted');

  // Regresión: el evento llevaba TODAS las líneas de la orden con la cantidad PEDIDA, y inventory suma cada línea tal cual;
  // recibir 10 de 100 metía 100 al stock y una segunda entrega lo duplicaba otra vez.
  it('una recepción parcial manda SOLO lo recibido en ella, no lo pedido', async () => {
    const { order, orderLineId } = await approvedOrder(ORG_A, { quantity: '100' });

    await receive(order.id, [{ orderLineId, quantity: '10' }]);
    await receive(order.id, [{ orderLineId, quantity: '20.5' }]);

    const events = receivedEvents();
    expect(events).toHaveLength(2);
    const [first, second] = events.map((e) => e.payload as { lines: Array<{ productId: string; quantity: string; unitCostCents: number }>; receiptId: string; receiptNumber: string });
    expect(first!.lines).toEqual([expect.objectContaining({ productId: PRODUCT_1, quantity: '10', unitCostCents: 250 })]);
    expect(second!.lines).toEqual([expect.objectContaining({ productId: PRODUCT_1, quantity: '20.5', unitCostCents: 250 })]);
    // Cada evento identifica su recepción: inventory registra el movimiento contra ella.
    expect(first!.receiptNumber).toBe('RM-2026-000001');
    expect(second!.receiptNumber).toBe('RM-2026-000002');
    expect(first!.receiptId).not.toBe(second!.receiptId);
  });

  it('en una recepción de varias líneas solo viajan las líneas recibidas', async () => {
    const s = await supplier();
    const draft = await p.uc.createOrder.execute({
      organizationId: ORG_A,
      userId: USER_1,
      countryCode: 'EC',
      request: orderRequest(s.id, { warehouseId: WAREHOUSE, lines: [lineRequest({ quantity: '5' }), lineRequest({ quantity: '8', unitCostCents: 400 })] }),
    });
    const order = await p.uc.submitOrder.execute({ organizationId: ORG_A, orderId: draft.id });

    await receive(order.id, [{ orderLineId: order.lines[1]!.id, quantity: '3' }]);

    const lines = (receivedEvents()[0]!.payload as { lines: Array<{ quantity: string; unitCostCents: number }> }).lines;
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ quantity: '3', unitCostCents: 400 });
  });

  // Regresión: el costo se calculaba como centavos × micros (sin dividir entre 1e6): 2 500 000 000 en vez de 2 500.
  it('receipt.posted trae el costo en centavos: 10 × 2,50 = 2500', async () => {
    const { order, orderLineId } = await approvedOrder(ORG_A, { quantity: '100' });
    await receive(order.id, [{ orderLineId, quantity: '10' }]);
    expect((postedEvents()[0]!.payload as { totalCostCents: number }).totalCostCents).toBe(2500);
  });

  it('el costo de la recepción redondea una vez por línea, con decimales', async () => {
    const { order, orderLineId } = await approvedOrder(ORG_A, { quantity: '100' });
    // 5,5 × 250 = 1375 exacto; 0,003 × 250 = 0,75 → 1 (mitad hacia arriba)
    await receive(order.id, [{ orderLineId, quantity: '5.5' }]);
    await receive(order.id, [{ orderLineId, quantity: '0.003' }]);
    const totals = postedEvents().map((e) => (e.payload as { totalCostCents: number }).totalCostCents);
    expect(totals).toEqual([1375, 1]);
  });
});
