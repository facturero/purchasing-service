import { beforeEach, describe, expect, it } from 'vitest';
import { HandleWithholdingIssuedUseCase } from '../application/use-cases/withholding-use-cases.js';
import type { CreateBillInput } from '../application/use-cases/bill-use-cases.js';
import { InMemoryStore, ORG_A, ORG_B, PRODUCT_1, USER_1, USER_2, WAREHOUSE, buildPurchasing, lineRequest, orderRequest, supplierInput } from './helpers.js';

/**
 * El consumidor de `fiscal.ec.withholding.issued`. Regresión: se escribió esperando `billId`, `documentId` y
 * `authorizationNumber`, que fiscal NO manda (su payload trae `withholdingId`, el proveedor y el documento sustento por número).
 * Con `billId` indefinido Sequelize lanza «WHERE parameter "id" has invalid "undefined" value» y cada retención autorizada
 * habría acabado en reintentos y cola de errores. Aquí el payload es el REAL (copiado de `withholdingIssuedPayload`).
 */
const NOW = new Date('2026-10-21T15:00:00Z');
let store: InMemoryStore;
let p: ReturnType<typeof buildPurchasing>;
let handler: HandleWithholdingIssuedUseCase;
beforeEach(() => {
  store = new InMemoryStore();
  p = buildPurchasing(store);
  handler = new HandleWithholdingIssuedUseCase(store, () => NOW);
});

const RUC = '1790012345001';

/** Una factura de compra CONTABILIZADA, conciliada contra una orden recibida: 001-002-000000123 del proveedor `RUC`. */
async function postedBill(over: Partial<CreateBillInput> = {}, org = ORG_A) {
  const supplier = await p.uc.createSupplier.execute({ organizationId: org, input: supplierInput({ identification: RUC }) as never });
  const draft = await p.uc.createOrder.execute({
    organizationId: org, userId: USER_1, countryCode: 'EC',
    request: orderRequest(supplier.id, { warehouseId: WAREHOUSE, lines: [lineRequest()] }),
  });
  const order = await p.uc.submitOrder.execute({ organizationId: org, orderId: draft.id });
  await p.uc.receiveOrder.execute({
    organizationId: org,
    input: { orderId: order.id, userId: USER_1, receiptDate: '2026-10-20', lines: [{ orderLineId: order.lines[0]!.id, quantity: '10' }] },
  });
  const bill = await p.uc.createBill.execute({
    organizationId: org, userId: USER_1,
    input: {
      supplierId: supplier.id, purchaseOrderId: order.id, docType: '01', establishment: '001', emissionPoint: '002', sequential: '000000123',
      issueDate: '2026-10-20', dueDate: '2026-11-20', currencyCode: 'USD',
      lines: [{ orderLineId: order.lines[0]!.id, productId: PRODUCT_1, description: 'Papel', quantityMicros: 10_000_000n, unitCostCents: 250, discountCents: 0, taxRatePct: '15.00', iceCents: 0, irbpnrCents: 0 }],
      ...over,
    },
  });
  return p.uc.postBill.execute({ organizationId: org, billId: bill.id });
}

/** Lo que publica fiscal-ecuador al autorizar una retención (forma real del payload). */
const fiscalEvent = (over: Record<string, unknown> = {}) => ({
  withholdingId: 'w-0001',
  fiscalInvoiceId: 'f-0001',
  organizationId: ORG_A,
  number: '001-001-000000007',
  issueDate: '2026-10-21',
  authorizationNumber: '2110202607179001234500110010010000000071234567813',
  userId: USER_1,
  currencyCode: 'USD',
  supplier: { identification: RUC, businessName: 'Proveedor Andino' },
  support: { documentCode: '01', number: '001-002-000000123', issueDate: '2026-10-20' },
  incomeTaxWithheldCents: 100,
  vatWithheldCents: 450,
  isdWithheldCents: 0,
  totalWithheldCents: 550,
  ...over,
});

const eventsOfType = (type: string) => store.outboxEvents.filter((e) => e.type === type);

describe('consumidor de retenciones emitidas', () => {
  it('marca «con retención» la factura que la retención cita, por proveedor y número de documento', async () => {
    const bill = await postedBill();
    expect(bill.status).toBe('posted');
    expect(bill.withholdingStatus).toBe('none');

    const result = await handler.execute(fiscalEvent());
    expect(result).toEqual({ outcome: 'marked', billId: bill.id });

    const after = await p.uc.getBill.execute({ organizationId: ORG_A, billId: bill.id });
    expect(after.withholdingStatus).toBe('issued');
    expect(after.version).toBe(bill.version + 1);
  });

  it('publica purchasing.bill.withholding_issued con el comprobante (la factura no guarda su id: queda el rastro aquí)', async () => {
    const bill = await postedBill();
    await handler.execute(fiscalEvent());
    const [event] = eventsOfType('purchasing.bill.withholding_issued');
    expect(event).toBeDefined();
    expect(event!.aggregateId).toBe(bill.id);
    expect(event!.payload).toMatchObject({
      organizationId: ORG_A,
      billId: bill.id,
      withholdingDocumentId: 'w-0001',
      withholdingNumber: '001-001-000000007',
      withholdingAuthorization: '2110202607179001234500110010010000000071234567813',
    });
  });

  it('es idempotente: la misma retención dos veces deja una sola marca y un solo evento', async () => {
    await postedBill();
    expect((await handler.execute(fiscalEvent())).outcome).toBe('marked');
    expect(await handler.execute(fiscalEvent())).toMatchObject({ outcome: 'ignored' });
    expect(eventsOfType('purchasing.bill.withholding_issued')).toHaveLength(1);
  });

  it('una retención sobre una compra que no pasó por este módulo se ignora sin lanzar (no es un fallo)', async () => {
    await postedBill();
    const result = await handler.execute(fiscalEvent({ support: { documentCode: '01', number: '009-009-000000999', issueDate: '2026-10-20' } }));
    expect(result).toMatchObject({ outcome: 'ignored', reason: expect.stringContaining('no hay factura') });
    expect(eventsOfType('purchasing.bill.withholding_issued')).toHaveLength(0);
  });

  it('no mezcla proveedores: el mismo número de documento de OTRO proveedor no se marca', async () => {
    const bill = await postedBill();
    const result = await handler.execute(fiscalEvent({ supplier: { identification: '0990000000001', businessName: 'Otro' } }));
    expect(result.outcome).toBe('ignored');
    expect((await p.uc.getBill.execute({ organizationId: ORG_A, billId: bill.id })).withholdingStatus).toBe('none');
  });

  it('aislamiento por organización: la retención de otra organización no toca esta factura', async () => {
    const bill = await postedBill();
    const result = await handler.execute(fiscalEvent({ organizationId: ORG_B }));
    expect(result.outcome).toBe('ignored');
    expect((await p.uc.getBill.execute({ organizationId: ORG_A, billId: bill.id })).withholdingStatus).toBe('none');
  });

  it('una factura anulada no es sustento de una retención válida: no se marca', async () => {
    const bill = await postedBill();
    await p.uc.voidBill.execute({ organizationId: ORG_A, billId: bill.id, userId: USER_2, reason: 'Emitida por error' });
    const result = await handler.execute(fiscalEvent());
    expect(result).toMatchObject({ outcome: 'ignored', reason: expect.stringContaining('voided') });
  });

  it('un documento sustento que no es una factura de compra (p. ej. nota de crédito 04) se ignora', async () => {
    await postedBill();
    const result = await handler.execute(fiscalEvent({ support: { documentCode: '04', number: '001-002-000000123', issueDate: '2026-10-20' } }));
    expect(result.outcome).toBe('ignored');
  });

  it.each([
    ['sin documento sustento', { support: null }],
    ['con un número de documento mal formado', { support: { documentCode: '01', number: '1-2-3', issueDate: '2026-10-20' } }],
    ['sin proveedor', { supplier: null }],
    ['sin id de retención', { withholdingId: '' }],
  ])('un evento %s se ignora sin lanzar', async (_name, over) => {
    await postedBill();
    await expect(handler.execute(fiscalEvent(over as Record<string, unknown>))).resolves.toMatchObject({ outcome: 'ignored' });
  });
});
