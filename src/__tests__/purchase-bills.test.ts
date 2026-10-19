import { beforeEach, describe, expect, it } from 'vitest';
import {
  BillNotEditableError,
  BillNotFoundError,
  BillNotOverridableError,
  BillNotPostedError,
  BillNotPostableError,
  BillNotVoidableError,
  ConcurrentUpdateError,
  DuplicateSupplierDocumentError,
  FiscalServiceUnavailableError,
  SelfOverrideError,
  TotalsMismatchError,
  ValidationError,
  WithholdingAlreadyIssuedError,
} from '../domain/errors.js';
import {
  computeBillLine,
  markBillWithholdingIssued,
  newBillDraft,
  overrideBill,
  postBill,
  runThreeWayMatch,
  validateSupplierTotals,
  voidBill,
  type BillHeaderInput,
  type BillLineInput,
} from '../domain/purchase-bill.js';
import type { CreateBillInput } from '../application/use-cases/bill-use-cases.js';
import {
  InMemoryStore,
  ORG_A,
  ORG_B,
  PRODUCT_1,
  USER_1,
  USER_2,
  buildPurchasing,
  lineRequest,
  orderRequest,
  supplierInput,
} from './helpers.js';

const NOW = new Date('2026-10-20T15:00:00Z');

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

async function approvedOrder(org = ORG_A, lineOver: Record<string, unknown> = {}) {
  const s = await supplier(org);
  const order = await p.uc.createOrder.execute({
    organizationId: org,
    userId: USER_1,
    countryCode: 'EC',
    request: orderRequest(s.id, { lines: [lineRequest(lineOver)] }),
  });
  const approved = await p.uc.submitOrder.execute({ organizationId: org, orderId: order.id });
  return { supplier: s, order: approved };
}

async function receivedOrder(org = ORG_A, receivedQty = '10') {
  const { supplier: s, order } = await approvedOrder(org);
  await p.uc.receiveOrder.execute({
    organizationId: org,
    input: { orderId: order.id, userId: USER_1, receiptDate: '2026-10-20', lines: [{ orderLineId: order.lines[0]!.id, quantity: receivedQty }] },
  });
  return { supplier: s, order, orderLineId: order.lines[0]!.id };
}

/** Línea de factura por defecto: 10 x 250 con IVA 15% → subtotal 2500, impuesto 375, total 2875. */
const billLine = (over: Partial<BillLineInput> = {}): BillLineInput => ({
  description: 'Papel bond A4',
  quantityMicros: 10_000_000n,
  unitCostCents: 250,
  discountCents: 0,
  taxRatePct: '15.00',
  iceCents: 0,
  irbpnrCents: 0,
  ...over,
});

const header = (supplierId: string, orderId: string | null, over: Partial<BillHeaderInput> = {}): BillHeaderInput => ({
  supplierId,
  supplier: { identificationType: 'RUC', identification: nextIdent(), legalName: 'Proveedor' },
  purchaseOrderId: orderId,
  docType: '01',
  establishment: '001',
  emissionPoint: '002',
  sequential: '000000123',
  authorizationNumber: null,
  issueDate: '2026-10-20',
  dueDate: '2026-11-20',
  currencyCode: 'USD',
  notes: null,
  ...over,
});

const billInput = (supplierId: string, over: Partial<CreateBillInput> = {}): CreateBillInput => ({
  supplierId,
  docType: '01',
  establishment: '001',
  emissionPoint: '002',
  sequential: '000000123',
  issueDate: '2026-10-20',
  dueDate: '2026-11-20',
  currencyCode: 'USD',
  lines: [billLine()],
  ...over,
});

/** Borrador ya armado por el dominio, con la línea apuntando a la orden `ol-1`. */
const billWith = (lineOver: Partial<BillLineInput> = {}, headerOver: Partial<BillHeaderInput> = {}) =>
  newBillDraft({
    organizationId: ORG_A,
    createdBy: USER_1,
    header: header('s-1', 'order-1', headerOver),
    lines: [billLine({ orderLineId: 'ol-1', productId: PRODUCT_1, ...lineOver })],
    now: NOW,
  });

describe('factura de compra: cálculo de líneas', () => {
  it('calcula el IVA desde el porcentaje y respeta el importe que traiga el proveedor', () => {
    expect(computeBillLine(billLine(), 1)).toMatchObject({ subtotalCents: 2500, taxCents: 375, totalCents: 2875, priceVarianceCents: 0 });
    // Si el documento del proveedor trae su importe de impuesto, manda ese (aunque difiera del cálculo).
    expect(computeBillLine(billLine({ taxCents: 400 }), 1)).toMatchObject({ taxCents: 400, totalCents: 2900 });
    // Con descuento, el impuesto se calcula sobre la base neta.
    expect(computeBillLine(billLine({ discountCents: 500 }), 1)).toMatchObject({ subtotalCents: 2000, taxCents: 300, totalCents: 2300 });
  });

  it('rechaza un descuento mayor que la base de la línea', () => {
    expect(() => computeBillLine(billLine({ discountCents: 9999 }), 1)).toThrow(ValidationError);
  });

  it('valida los totales del proveedor con un céntimo de tolerancia (redondeo)', () => {
    expect(() => validateSupplierTotals(2875, 2876)).not.toThrow();
    expect(() => validateSupplierTotals(2875, 2877)).toThrow(TotalsMismatchError);
  });
});

describe('conciliación a tres vías', () => {
  const orderLines = (receivedMicros: bigint, unitCostCents = 250) =>
    new Map([['ol-1', { quantityMicros: 10_000_000n, receivedMicros, unitCostCents }]]);

  it('cuadra cuando cantidad y precio están dentro de lo recibido y de la orden', () => {
    const result = runThreeWayMatch({ bill: billWith(), orderLines: orderLines(10_000_000n), priceToleranceBp: 0, qtyToleranceBp: 0 });
    expect(result).toMatchObject({ matchStatus: 'matched', matchReasons: [] });
  });

  it('marca la cantidad que supera lo recibido (con tolerancia en puntos básicos)', () => {
    const exceed = runThreeWayMatch({ bill: billWith({ quantityMicros: 11_000_000n }), orderLines: orderLines(10_000_000n), priceToleranceBp: 0, qtyToleranceBp: 0 });
    expect(exceed.matchReasons.map((r) => r.code)).toContain('QTY_EXCEEDS_RECEIVED');
    // 5% sobre 10 = 10.5: 11 sigue pasándose, 10.5 no.
    const tolerant = runThreeWayMatch({ bill: billWith({ quantityMicros: 10_500_000n }), orderLines: orderLines(10_000_000n), priceToleranceBp: 0, qtyToleranceBp: 500 });
    expect(tolerant.matchStatus).toBe('matched');
  });

  it('la invariante es acumulada: sumar lo ya facturado puede pasarse de lo recibido', () => {
    // 6 + 6 = 12 > 10 → aunque la línea sola quepa, el acumulado no.
    const accumulated = runThreeWayMatch({
      bill: billWith({ quantityMicros: 6_000_000n }),
      orderLines: orderLines(10_000_000n),
      billedSoFarByLine: new Map([['ol-1', 6_000_000n]]),
      priceToleranceBp: 0,
      qtyToleranceBp: 0,
    });
    expect(accumulated.matchReasons.map((r) => r.code)).toContain('QTY_EXCEEDS_RECEIVED');
    // 5 + 5 = 10 → cabe.
    const fits = runThreeWayMatch({
      bill: billWith({ quantityMicros: 5_000_000n }),
      orderLines: orderLines(10_000_000n),
      billedSoFarByLine: new Map([['ol-1', 5_000_000n]]),
      priceToleranceBp: 0,
      qtyToleranceBp: 0,
    });
    expect(fits.matchStatus).toBe('matched');
  });

  it('una línea sin recepción previa no se puede facturar', () => {
    const result = runThreeWayMatch({ bill: billWith(), orderLines: orderLines(0n), priceToleranceBp: 0, qtyToleranceBp: 0 });
    expect(result.matchReasons.map((r) => r.code)).toEqual(expect.arrayContaining(['NO_RECEIPT', 'QTY_EXCEEDS_RECEIVED']));
  });

  it('marca la variación de precio y la devuelve para guardarla en la línea', () => {
    const bill = billWith({ unitCostCents: 300 });
    const result = runThreeWayMatch({ bill, orderLines: orderLines(10_000_000n, 250), priceToleranceBp: 0, qtyToleranceBp: 0 });
    expect(result.matchStatus).toBe('blocked');
    expect(result.matchReasons.map((r) => r.code)).toContain('PRICE_VARIANCE');
    // 300 − 250 = 50 por unidad × 10 unidades = 500 centavos en total (lo que espera contabilidad).
    expect(result.linesWithVariance).toEqual([{ lineId: bill.lines[0]!.id, priceVarianceCents: 500 }]);
  });

  it('dentro de la tolerancia de precio no marca nada', () => {
    // 300 vs 250 = 20%; con tolerancia 20% (2000 bp) el margen es 50 centavos exactos → no supera.
    const result = runThreeWayMatch({ bill: billWith({ unitCostCents: 300 }), orderLines: orderLines(10_000_000n, 250), priceToleranceBp: 2000, qtyToleranceBp: 0 });
    expect(result.matchStatus).toBe('matched');
  });

  it('avisa si la línea no pertenece a la orden', () => {
    const result = runThreeWayMatch({ bill: billWith({ orderLineId: 'ol-x' }), orderLines: orderLines(10_000_000n), priceToleranceBp: 0, qtyToleranceBp: 0 });
    expect(result.matchReasons.map((r) => r.code)).toEqual(['LINE_NOT_IN_ORDER']);
  });
});

describe('estados de la factura (dominio)', () => {
  const matched = { matchStatus: 'matched' as const, matchReasons: [], linesWithVariance: [] };

  it('un borrador pasa a posted si cuadra, y no se puede contabilizar dos veces', () => {
    const bill = billWith();
    const posted = postBill(bill, matched, NOW);
    expect(posted).toMatchObject({ status: 'posted', matchStatus: 'matched', version: 2 });
    expect(() => postBill(posted, matched, NOW)).toThrow(BillNotPostableError);
  });

  it('si la conciliación falla queda blocked y guarda la variación de precio en la línea', () => {
    const bill = billWith();
    const blocked = postBill(
      bill,
      { matchStatus: 'blocked', matchReasons: [{ code: 'PRICE_VARIANCE', lineId: bill.lines[0]!.id, detail: 'x' }], linesWithVariance: [{ lineId: bill.lines[0]!.id, priceVarianceCents: 50 }] },
      NOW,
    );
    expect(blocked.status).toBe('blocked');
    expect(blocked.lines[0]!.priceVarianceCents).toBe(50);
  });

  it('sobrescribir exige otra persona y un motivo con sustancia', () => {
    const bill = billWith();
    const blocked = postBill(bill, { matchStatus: 'blocked', matchReasons: [{ code: 'QTY_EXCEEDS_RECEIVED', detail: 'x' }], linesWithVariance: [] }, NOW);
    expect(() => overrideBill(blocked, USER_1, 'Motivo suficiente', NOW)).toThrow(SelfOverrideError);
    expect(() => overrideBill(blocked, USER_2, 'no', NOW)).toThrow(ValidationError);
    const overridden = overrideBill(blocked, USER_2, 'Autorizado por gerencia', NOW);
    expect(overridden).toMatchObject({ status: 'posted', matchStatus: 'overridden', overrideBy: USER_2, overrideReason: 'Autorizado por gerencia' });
    // Ya no está bloqueada: no se puede volver a sobrescribir.
    expect(() => overrideBill(overridden, USER_2, 'Otra vez el motivo', NOW)).toThrow(BillNotOverridableError);
  });

  it('anular pide motivo y solo aplica a contabilizadas (posted/blocked)', () => {
    const bill = billWith();
    expect(() => voidBill(bill, USER_1, 'Error de captura', NOW)).toThrow(BillNotVoidableError);
    const posted = postBill(bill, matched, NOW);
    expect(voidBill(posted, USER_1, 'Error de captura', NOW)).toMatchObject({ status: 'voided', voidReason: 'Error de captura' });
    expect(() => voidBill(posted, USER_1, 'no', NOW)).toThrow(ValidationError);
  });

  it('la retención se marca una sola vez', () => {
    const issued = markBillWithholdingIssued(postBill(billWith(), matched, NOW), 'wd-1', NOW);
    expect(issued.withholdingStatus).toBe('issued');
    expect(() => markBillWithholdingIssued(issued, 'wd-2', NOW)).toThrow(WithholdingAlreadyIssuedError);
  });
});

describe('casos de uso de factura de compra', () => {
  it('se crea contra la orden con número interno y líneas persistidas', async () => {
    const { supplier: s, order, orderLineId } = await receivedOrder();
    const bill = await p.uc.createBill.execute({
      organizationId: ORG_A,
      userId: USER_1,
      input: billInput(s.id, { purchaseOrderId: order.id, lines: [billLine({ orderLineId, productId: PRODUCT_1 })] }),
    });
    expect(bill).toMatchObject({ status: 'draft', internalNumber: 'FC-2026-000001', subtotalCents: 2500, taxCents: 375, totalCents: 2875, matchStatus: 'matched' });
    const loaded = await p.uc.getBill.execute({ organizationId: ORG_A, billId: bill.id });
    expect(loaded.lines).toHaveLength(1);
    expect(loaded.lines[0]).toMatchObject({ quantityMicros: 10_000_000n, orderLineId });
    expect(store.eventTypes()).toContain('purchasing.bill.created');
  });

  it('no acepta dos veces el documento del proveedor ni la misma autorización', async () => {
    const { supplier: s, order } = await receivedOrder();
    const input = billInput(s.id, { purchaseOrderId: order.id, lines: [billLine({ orderLineId: order.lines[0]!.id })] });
    await p.uc.createBill.execute({ organizationId: ORG_A, userId: USER_1, input });
    await expect(p.uc.createBill.execute({ organizationId: ORG_A, userId: USER_1, input })).rejects.toThrow(DuplicateSupplierDocumentError);
    // Mismo documento pero con autorización repetida en otra factura distinta.
    const other = billInput(s.id, { sequential: '000000999', authorizationNumber: '1234567890', lines: [billLine()], purchaseOrderId: null });
    await p.uc.createBill.execute({ organizationId: ORG_A, userId: USER_1, input: other });
    await expect(
      p.uc.createBill.execute({ organizationId: ORG_A, userId: USER_1, input: { ...other, sequential: '000000998' } }),
    ).rejects.toThrow(DuplicateSupplierDocumentError);
  });

  // Regresión: la comprobación solo corría si la factura iba contra una orden; sin orden la base la rechazaba con un 409
  // genérico (CONFLICT) y el servicio no daba DUPLICATE_SUPPLIER_DOCUMENT.
  it('el mismo documento del proveedor tampoco se registra dos veces SIN orden', async () => {
    const s = await supplier();
    const input = billInput(s.id, { purchaseOrderId: null, sequential: '000000777', lines: [billLine()] });
    await p.uc.createBill.execute({ organizationId: ORG_A, userId: USER_1, input });
    await expect(p.uc.createBill.execute({ organizationId: ORG_A, userId: USER_1, input })).rejects.toThrow(DuplicateSupplierDocumentError);
  });

  it('rechaza un total del proveedor que no cuadra y un proveedor inactivo', async () => {
    const { supplier: s, order, orderLineId } = await receivedOrder();
    await expect(
      p.uc.createBill.execute({ organizationId: ORG_A, userId: USER_1, input: billInput(s.id, { purchaseOrderId: order.id, supplierTotalCents: 9999, lines: [billLine({ orderLineId })] }) }),
    ).rejects.toThrow(TotalsMismatchError);
    await p.uc.setSupplierStatus.execute({ organizationId: ORG_A, supplierId: s.id, status: 'inactive' });
    await expect(p.uc.createBill.execute({ organizationId: ORG_A, userId: USER_1, input: billInput(s.id, { purchaseOrderId: order.id, lines: [billLine({ orderLineId })] }) })).rejects.toThrow(ValidationError);
  });

  it('otra organización no la ve', async () => {
    const { supplier: s, order, orderLineId } = await receivedOrder();
    const bill = await p.uc.createBill.execute({ organizationId: ORG_A, userId: USER_1, input: billInput(s.id, { purchaseOrderId: order.id, lines: [billLine({ orderLineId })] }) });
    await expect(p.uc.getBill.execute({ organizationId: ORG_B, billId: bill.id })).rejects.toThrow(BillNotFoundError);
    expect((await p.uc.listBills.execute({ organizationId: ORG_B, filters: { page: 1, pageSize: 10 } })).total).toBe(0);
  });

  it('sin orden va directo a posted con matchStatus not_applicable', async () => {
    const s = await supplier();
    const bill = await p.uc.createBill.execute({ organizationId: ORG_A, userId: USER_1, input: billInput(s.id) });
    const posted = await p.uc.postBill.execute({ organizationId: ORG_A, billId: bill.id });
    expect(posted).toMatchObject({ status: 'posted', matchStatus: 'not_applicable' });
    expect(store.eventTypes()).toContain('purchasing.bill.posted');
  });

  it('contra una orden cuadrada, contabilizar deja posted y publica el evento', async () => {
    const { supplier: s, order, orderLineId } = await receivedOrder();
    const bill = await p.uc.createBill.execute({ organizationId: ORG_A, userId: USER_1, input: billInput(s.id, { purchaseOrderId: order.id, lines: [billLine({ orderLineId })] }) });
    const posted = await p.uc.postBill.execute({ organizationId: ORG_A, billId: bill.id });
    expect(posted).toMatchObject({ status: 'posted', matchStatus: 'matched' });
    expect(store.eventTypes()).toContain('purchasing.bill.posted');
  });

  it('la invariante de facturación es acumulada: lo bloqueado ocupa cupo y anular lo libera', async () => {
    const { supplier: s, order, orderLineId } = await receivedOrder();
    const mk = (sequential: string) =>
      p.uc.createBill.execute({ organizationId: ORG_A, userId: USER_1, input: billInput(s.id, { purchaseOrderId: order.id, sequential, lines: [billLine({ orderLineId })] }) });
    const post = (billId: string) => p.uc.postBill.execute({ organizationId: ORG_A, billId });
    const voidIt = (billId: string, reason: string) => p.uc.voidBill.execute({ organizationId: ORG_A, billId, userId: USER_2, reason });

    const first = await mk('000000001');
    expect((await post(first.id)).status).toBe('posted');

    // El seguimiento muestra lo facturado acumulado como texto (los bigint no viajan en JSON).
    const tracking = await p.uc.getOrderReceiving.execute({ organizationId: ORG_A, orderId: order.id });
    expect(tracking.lines[0]).toMatchObject({ ordered: '10', received: '10', pending: '0', billed: '10' });

    // Una segunda factura de la misma recepción no se contabiliza: supera lo recibido.
    const second = await mk('000000002');
    const blocked = await post(second.id);
    expect(blocked.status).toBe('blocked');
    expect(blocked.matchReasons.map((r) => r.code)).toContain('QTY_EXCEEDS_RECEIVED');
    expect(store.eventTypes()).toContain('purchasing.bill.blocked');

    // La bloqueada sigue ocupando el cupo mientras nadie decida: tampoco deja pasar otra.
    const third = await mk('000000003');
    expect((await post(third.id)).status).toBe('blocked');

    // Anuladas las tres (decididas), el saldo queda libre y la siguiente sí se contabiliza.
    await voidIt(first.id, 'Documento equivocado');
    await voidIt(second.id, 'Duplicada del proveedor');
    await voidIt(third.id, 'Duplicada del proveedor');
    const fourth = await mk('000000004');
    expect((await post(fourth.id)).status).toBe('posted');
  });

  it('una factura bloqueada se aprueba con excepción (otra persona) y queda overridden', async () => {
    const { supplier: s, order, orderLineId } = await receivedOrder();
    // Precio 300 contra 250 de la orden: fuera de tolerancia (0 bp por defecto).
    const bill = await p.uc.createBill.execute({ organizationId: ORG_A, userId: USER_1, input: billInput(s.id, { purchaseOrderId: order.id, lines: [billLine({ orderLineId, unitCostCents: 300 })] }) });
    const blocked = await p.uc.postBill.execute({ organizationId: ORG_A, billId: bill.id });
    expect(blocked.status).toBe('blocked');

    await expect(p.uc.overrideBill.execute({ organizationId: ORG_A, billId: bill.id, userId: USER_1, reason: 'Yo mismo no' })).rejects.toThrow(SelfOverrideError);
    const overridden = await p.uc.overrideBill.execute({ organizationId: ORG_A, billId: bill.id, userId: USER_2, reason: 'Precio acordado con el proveedor' });
    expect(overridden).toMatchObject({ status: 'posted', matchStatus: 'overridden', overrideBy: USER_2 });
    expect(store.eventTypes()).toContain('purchasing.bill.overridden');
  });

  it('se edita mientras es borrador y se guarda con control de versión', async () => {
    const { supplier: s, order, orderLineId } = await receivedOrder();
    const bill = await p.uc.createBill.execute({ organizationId: ORG_A, userId: USER_1, input: billInput(s.id, { purchaseOrderId: order.id, lines: [billLine({ orderLineId })] }) });
    const edited = await p.uc.updateBill.execute({
      organizationId: ORG_A,
      billId: bill.id,
      input: billInput(s.id, { purchaseOrderId: order.id, lines: [billLine({ orderLineId, quantityMicros: 5_000_000n })] }),
    });
    expect(edited).toMatchObject({ version: 2, subtotalCents: 1250, taxCents: 188 });
    expect(edited.lines[0]!.quantityMicros).toBe(5_000_000n);
    // Con la versión vieja, otra persona pisa sin saberlo: se rechaza.
    await expect(store.bills.save({ ...edited, totalCents: 1 }, 1)).rejects.toThrow(ConcurrentUpdateError);
  });

  it('una vez contabilizada ya no se edita', async () => {
    const { supplier: s, order, orderLineId } = await receivedOrder();
    const bill = await p.uc.createBill.execute({ organizationId: ORG_A, userId: USER_1, input: billInput(s.id, { purchaseOrderId: order.id, lines: [billLine({ orderLineId })] }) });
    await p.uc.postBill.execute({ organizationId: ORG_A, billId: bill.id });
    await expect(
      p.uc.updateBill.execute({ organizationId: ORG_A, billId: bill.id, input: billInput(s.id, { purchaseOrderId: order.id, lines: [billLine({ orderLineId })] }) }),
    ).rejects.toThrow(BillNotEditableError);
  });

  it('la retención se emite contra fiscal una sola vez, y si fiscal no responde, no se marca', async () => {
    const { supplier: s, order, orderLineId } = await receivedOrder();
    const bill = await p.uc.createBill.execute({ organizationId: ORG_A, userId: USER_1, input: billInput(s.id, { purchaseOrderId: order.id, lines: [billLine({ orderLineId })] }) });
    // Un borrador no puede llevar retención.
    await expect(
      p.uc.issueBillWithholding.execute({ organizationId: ORG_A, userId: USER_1, input: { billId: bill.id, withholdingLines: [{ taxCode: '725', taxPercentage: '1.75', baseCents: 2500, taxCents: 44 }] } }),
    ).rejects.toThrow(BillNotPostedError);

    await p.uc.postBill.execute({ organizationId: ORG_A, billId: bill.id });
    const issued = await p.uc.issueBillWithholding.execute({ organizationId: ORG_A, userId: USER_1, input: { billId: bill.id, withholdingLines: [{ taxCode: '725', taxPercentage: '1.75', baseCents: 2500, taxCents: 44 }] } });
    expect(issued.withholdingStatus).toBe('issued');
    expect(store.eventTypes()).toContain('purchasing.bill.withholding_issued');
    expect(p.fiscal.issued).toHaveLength(1);

    await expect(
      p.uc.issueBillWithholding.execute({ organizationId: ORG_A, userId: USER_1, input: { billId: bill.id, withholdingLines: [{ taxCode: '725', taxPercentage: '1.75', baseCents: 2500, taxCents: 44 }] } }),
    ).rejects.toThrow(WithholdingAlreadyIssuedError);

    // Si fiscal está caído, la factura no queda marcada. (La otra factura va sin orden para que sí
    // llegue a `posted`: contra la misma orden ya está el cupo ocupado por la primera.)
    const other = await p.uc.createBill.execute({ organizationId: ORG_A, userId: USER_1, input: billInput(s.id, { sequential: '000000777' }) });
    await p.uc.postBill.execute({ organizationId: ORG_A, billId: other.id });
    p.fiscal.down = true;
    await expect(
      p.uc.issueBillWithholding.execute({ organizationId: ORG_A, userId: USER_1, input: { billId: other.id, withholdingLines: [{ taxCode: '725', taxPercentage: '1.75', baseCents: 2500, taxCents: 44 }] } }),
    ).rejects.toThrow(FiscalServiceUnavailableError);
    expect((await p.uc.getBill.execute({ organizationId: ORG_A, billId: other.id })).withholdingStatus).toBe('none');
  });

  it('las tolerancias las fija el administrador por la API de settings', async () => {
    const saved = await p.uc.updateSettings.execute({ organizationId: ORG_A, changes: { priceToleranceBp: 1000, qtyToleranceBp: 200, overReceiptToleranceBp: 100 } });
    expect(saved).toMatchObject({ priceToleranceBp: 1000, qtyToleranceBp: 200, overReceiptToleranceBp: 100 });
    await expect(p.uc.updateSettings.execute({ organizationId: ORG_A, changes: { priceToleranceBp: 9000 } })).rejects.toThrow(ValidationError);
  });
});

describe('factura de compra por HTTP', () => {
  const ALL = ['supplier:manage', 'supplier:read', 'purchase:read', 'purchase:create', 'purchase:approve', 'purchase:close', 'receipt:create', 'purchase_bill:read', 'purchase_bill:create', 'purchase_bill:update', 'purchase_bill:post', 'purchase_bill:void'];
  const call = async (method: string, path: string, body?: unknown, perms: string[] = ALL) => {
    const res = await p.app.request(path, {
      method,
      headers: { 'Content-Type': 'application/json', 'X-Organization-Id': ORG_A, 'X-User-Id': USER_1, 'X-Permissions': perms.join(',') },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const text = await res.text();
    return { status: res.status, json: text ? JSON.parse(text) : null };
  };

  it('crea una factura con la cantidad en texto (la capa HTTP la convierte a micros)', async () => {
    const { supplier: s, order } = await approvedOrder();
    await p.uc.receiveOrder.execute({ organizationId: ORG_A, input: { orderId: order.id, userId: USER_1, receiptDate: '2026-10-20', lines: [{ orderLineId: order.lines[0]!.id, quantity: '10' }] } });

    const body = {
      supplierId: s.id,
      purchaseOrderId: order.id,
      docType: '01',
      establishment: '001',
      emissionPoint: '002',
      sequential: '000000123',
      issueDate: '2026-10-20',
      dueDate: '2026-11-20',
      currencyCode: 'USD',
      lines: [{ orderLineId: order.lines[0]!.id, description: 'Papel bond A4', quantity: '10', unitCostCents: 250, taxRatePct: '15.00' }],
    };
    const created = await call('POST', '/purchasing/bills', body);
    expect(created.status).toBe(201);
    expect(created.json).toMatchObject({ status: 'draft', subtotalCents: 2500, taxCents: 375, totalCents: 2875, internalNumber: 'FC-2026-000001' });
    expect(created.json.lines[0]).toMatchObject({ quantity: '10', taxCents: 375 });

    const posted = await call('POST', `/purchasing/bills/${created.json.id}/post`, {});
    expect(posted.status).toBe(200);
    expect(posted.json).toMatchObject({ status: 'posted', matchStatus: 'matched' });
  });

  it('rechaza una cantidad que no es número con 422, no con un 500', async () => {
    const { supplier: s } = await approvedOrder();
    const body = {
      supplierId: s.id,
      docType: '01',
      establishment: '001',
      emissionPoint: '002',
      sequential: '000000123',
      issueDate: '2026-10-20',
      dueDate: '2026-11-20',
      currencyCode: 'USD',
      lines: [{ description: 'x', quantity: 'no-es-numero', unitCostCents: 100, taxRatePct: '15.00' }],
    };
    const res = await call('POST', '/purchasing/bills', body);
    expect(res.status).toBe(422);
  });

  it('el seguimiento de recepción responde con cantidades en texto (no rompe con los bigint)', async () => {
    const { order } = await approvedOrder();
    const orderLineId = order.lines[0]!.id;
    await p.uc.receiveOrder.execute({ organizationId: ORG_A, input: { orderId: order.id, userId: USER_1, receiptDate: '2026-10-20', lines: [{ orderLineId, quantity: '4' }] } });
    const res = await call('GET', `/purchasing/orders/${order.id}/receiving`);
    expect(res.status).toBe(200);
    expect(res.json.lines[0]).toEqual({ lineId: orderLineId, ordered: '10', received: '4', pending: '6', billed: '0' });
  });

  it('exige el permiso de factura de compra', async () => {
    const res = await call('GET', '/purchasing/bills', undefined, ['purchase:read']);
    expect(res.status).toBe(403);
  });
});

