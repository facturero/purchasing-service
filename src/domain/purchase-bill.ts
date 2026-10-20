import { randomUUID } from 'node:crypto';
import {
  BillNotEditableError,
  BillNotOverridableError,
  BillNotPostableError,
  BillNotVoidableError,
  SelfOverrideError,
  TotalsMismatchError,
  ValidationError,
  WithholdingAlreadyIssuedError,
  type ErrorDetail,
} from './errors.js';
import { assertCents, lineGrossCents, parsePercentHundredths, quantityToString, taxCentsOf } from './money.js';
import type { IdentificationType } from './supplier.js';

/** Estados de la factura de compra (D.2.4). */
export type BillStatus =
  | 'draft'
  | 'posted'
  | 'blocked'
  | 'voided';

export const BILL_STATUSES: readonly BillStatus[] = ['draft', 'posted', 'blocked', 'voided'] as const;

/** Estados de conciliación (D.2.2). */
export type MatchStatus =
  | 'matched'
  | 'blocked'
  | 'overridden'
  | 'not_applicable';

/** Tipos de documento válidos en Ecuador para facturas de compra. */
export const SUPPLIER_DOC_TYPES = ['01', '03', '41'] as const;
export type SupplierDocType = (typeof SUPPLIER_DOC_TYPES)[number];

/** A dónde va la compra de la línea: inventario (mercadería que lleva stock) o gasto (servicios y suministros). */
export type BillLineKind = 'stock' | 'expense';

export interface BillLine {
  id: string;
  lineNumber: number;
  orderLineId: string | null;
  productId: string | null;
  /** Lo decide el servidor al guardar (catálogo de producto); contabilidad asienta a inventario solo las `stock`. */
  kind: BillLineKind;
  description: string;
  quantityMicros: bigint;
  unitCostCents: number;
  discountCents: number;
  subtotalCents: number;
  taxCode: string | null;
  taxPercentageCode: string | null;
  taxRatePct: string;
  taxCents: number;
  iceCents: number;
  irbpnrCents: number;
  totalCents: number;
  expenseAccountHint: string | null;
  priceVarianceCents: number;
}

export interface BillLineInput {
  orderLineId?: string | null;
  productId?: string | null;
  description: string;
  quantityMicros: bigint;
  unitCostCents: number;
  discountCents: number;
  taxCode?: string | null;
  taxPercentageCode?: string | null;
  taxRatePct: string;
  /** Si no viene, el dominio lo calcula de `taxRatePct` (igual que en las líneas de orden). */
  taxCents?: number;
  iceCents: number;
  irbpnrCents: number;
  expenseAccountHint?: string | null;
  /**
   * Si el producto de la línea lleva stock. Lo pone el caso de uso desde el catálogo, nunca el cliente. Sin dato (pruebas de dominio)
   * una línea con producto se trata como mercadería.
   */
  tracksStock?: boolean;
}

export interface SupplierSnapshot {
  identificationType: IdentificationType;
  identification: string;
  legalName: string;
}

export interface PurchaseBill {
  id: string;
  organizationId: string;
  internalNumber: string | null;
  supplierId: string;
  supplier: SupplierSnapshot;
  purchaseOrderId: string | null;
  docType: SupplierDocType;
  establishment: string;
  emissionPoint: string;
  sequential: string;
  authorizationNumber: string | null;
  issueDate: string;
  dueDate: string;
  currencyCode: string;
  notes: string | null;
  subtotalCents: number;
  taxCents: number;
  totalCents: number;
  supplierTotalCents: number;
  status: BillStatus;
  matchStatus: MatchStatus;
  matchReasons: MatchReason[];
  overrideReason: string | null;
  overrideBy: string | null;
  withholdingStatus: 'none' | 'issued';
  voidReason: string | null;
  createdBy: string;
  version: number;
  createdAt: Date;
  updatedAt: Date;
  /** Detalle de la factura. En listados puede venir vacío; en detalle se carga. */
  lines: BillLine[];
}

export interface MatchReason {
  code: string;
  lineId?: string;
  detail: string;
}

export interface BillHeaderInput {
  supplierId: string;
  supplier: SupplierSnapshot;
  purchaseOrderId: string | null;
  docType: SupplierDocType;
  establishment: string;
  emissionPoint: string;
  sequential: string;
  authorizationNumber: string | null;
  issueDate: string;
  dueDate: string;
  currencyCode: string;
  notes: string | null;
}

/** `FC-2026-000001`. */
export function formatBillNumber(year: number, sequence: number): string {
  return `FC-${year}-${String(sequence).padStart(6, '0')}`;
}

/** Documento del proveedor único: (org, supplier, tipo, estab, punto, secuencial). */
export function formatSupplierDocumentKey(docType: string, estab: string, punto: string, seq: string): string {
  return `${docType}-${estab}-${punto}-${seq}`;
}

const LOCAL_DATE = /^\d{4}-\d{2}-\d{2}$/;

export function validateBillHeader(header: BillHeaderInput): void {
  const problems: ErrorDetail[] = [];
  if (!LOCAL_DATE.test(header.issueDate)) problems.push({ field: 'issueDate', message: 'La fecha de emisión debe ser AAAA-MM-DD.' });
  if (!LOCAL_DATE.test(header.dueDate)) problems.push({ field: 'dueDate', message: 'La fecha de vencimiento debe ser AAAA-MM-DD.' });
  if (!SUPPLIER_DOC_TYPES.includes(header.docType)) problems.push({ field: 'docType', message: 'Tipo de documento no válido (01, 03, 41).' });
  if (!/^\d{3}$/.test(header.establishment)) problems.push({ field: 'establishment', message: 'El establecimiento debe ser 3 dígitos.' });
  if (!/^\d{3}$/.test(header.emissionPoint)) problems.push({ field: 'emissionPoint', message: 'El punto de emisión debe ser 3 dígitos.' });
  if (!/^\d{9}$/.test(header.sequential)) problems.push({ field: 'sequential', message: 'El secuencial debe ser 9 dígitos.' });
  if (header.authorizationNumber !== null && header.authorizationNumber !== '' && !/^\d{10,49}$/.test(header.authorizationNumber)) {
    problems.push({ field: 'authorizationNumber', message: 'La autorización debe ser numérica (10 a 49 dígitos).' });
  }
  if (!/^[A-Z]{3}$/.test(header.currencyCode)) problems.push({ field: 'currencyCode', message: 'La moneda es un código de tres letras.' });
  if (problems.length) throw new ValidationError(problems);
}

export function computeBillLine(input: BillLineInput, lineNumber: number, id: string = randomUUID()): BillLine {
  assertCents(input.unitCostCents, `lines[${lineNumber - 1}].unitCostCents`);
  assertCents(input.discountCents, `lines[${lineNumber - 1}].discountCents`);
  const gross = lineGrossCents(input.quantityMicros, input.unitCostCents);
  if (input.discountCents > gross) throw new ValidationError([{ field: `lines[${lineNumber - 1}].discountCents`, message: 'El descuento no puede superar el valor de la línea.' }]);
  const subtotalCents = gross - input.discountCents;
  const taxRate = parsePercentHundredths(input.taxRatePct);
  // El documento del proveedor manda si trae importe de impuesto; si no lo trae, se calcula del porcentaje
  // (misma regla que `computeLine` de las órdenes).
  const taxCents = input.taxCents ?? taxCentsOf(subtotalCents, taxRate);
  const totalCents = subtotalCents + taxCents + input.iceCents + input.irbpnrCents;
  return {
    id,
    lineNumber,
    orderLineId: input.orderLineId ?? null,
    productId: input.productId ?? null,
    kind: input.productId && input.tracksStock !== false ? 'stock' : 'expense',
    description: input.description.trim(),
    quantityMicros: input.quantityMicros,
    unitCostCents: input.unitCostCents,
    discountCents: input.discountCents,
    subtotalCents,
    taxCode: input.taxCode ?? null,
    taxPercentageCode: input.taxPercentageCode ?? null,
    taxRatePct: input.taxRatePct,
    taxCents,
    iceCents: input.iceCents,
    irbpnrCents: input.irbpnrCents,
    totalCents,
    expenseAccountHint: input.expenseAccountHint ?? null,
    priceVarianceCents: 0,
  };
}

export function computeBillTotals(lines: BillLine[]): { subtotalCents: number; taxCents: number; totalCents: number } {
  const subtotalCents = lines.reduce((sum, l) => sum + l.subtotalCents, 0);
  const taxCents = lines.reduce((sum, l) => sum + l.taxCents + l.iceCents + l.irbpnrCents, 0);
  return { subtotalCents, taxCents, totalCents: subtotalCents + taxCents };
}

export function newBillDraft(params: {
  organizationId: string;
  createdBy: string;
  header: BillHeaderInput;
  lines: BillLineInput[];
  now: Date;
}): PurchaseBill {
  validateBillHeader(params.header);
  if (params.lines.length === 0) throw new ValidationError([{ field: 'lines', message: 'La factura necesita al menos una línea.' }]);
  const built = params.lines.map((l, i) => computeBillLine(l, i + 1));
  const totals = computeBillTotals(built);
  return {
    id: randomUUID(),
    organizationId: params.organizationId,
    internalNumber: null,
    supplierId: params.header.supplierId,
    supplier: params.header.supplier,
    purchaseOrderId: params.header.purchaseOrderId,
    docType: params.header.docType,
    establishment: params.header.establishment,
    emissionPoint: params.header.emissionPoint,
    sequential: params.header.sequential,
    authorizationNumber: params.header.authorizationNumber,
    issueDate: params.header.issueDate,
    dueDate: params.header.dueDate,
    currencyCode: params.header.currencyCode,
    notes: params.header.notes,
    subtotalCents: totals.subtotalCents,
    taxCents: totals.taxCents,
    totalCents: totals.totalCents,
    supplierTotalCents: totals.totalCents,
    lines: built,
    status: 'draft',
    matchStatus: params.header.purchaseOrderId ? 'matched' : 'not_applicable',
    matchReasons: [],
    overrideReason: null,
    overrideBy: null,
    withholdingStatus: 'none',
    voidReason: null,
    createdBy: params.createdBy,
    version: 1,
    createdAt: params.now,
    updatedAt: params.now,
  };
}

export function replaceBillDraft(bill: PurchaseBill, header: BillHeaderInput, lines: BillLineInput[], now: Date): PurchaseBill {
  if (bill.status !== 'draft' && bill.status !== 'blocked') throw new BillNotEditableError();
  validateBillHeader(header);
  const built = lines.map((l, i) => computeBillLine(l, i + 1));
  const totals = computeBillTotals(built);
  return {
    ...bill,
    supplierId: header.supplierId,
    supplier: header.supplier,
    purchaseOrderId: header.purchaseOrderId,
    docType: header.docType,
    establishment: header.establishment,
    emissionPoint: header.emissionPoint,
    sequential: header.sequential,
    authorizationNumber: header.authorizationNumber,
    issueDate: header.issueDate,
    dueDate: header.dueDate,
    currencyCode: header.currencyCode,
    notes: header.notes,
    lines: built,
    subtotalCents: totals.subtotalCents,
    taxCents: totals.taxCents,
    totalCents: totals.totalCents,
    supplierTotalCents: totals.totalCents,
    status: 'draft',
    matchStatus: header.purchaseOrderId ? 'matched' : 'not_applicable',
    matchReasons: [],
    updatedAt: now,
    version: bill.version + 1,
  };
}

/** Conciliación a tres vías al contabilizar (D.2.3). Solo si la factura va contra una orden. */
export function runThreeWayMatch(params: {
  bill: PurchaseBill;
  orderLines: Map<string, { quantityMicros: bigint; receivedMicros: bigint; unitCostCents: number }>;
  /**
   * Cantidad ya facturada (micros) por línea de orden, SIN contar esta factura. Debe venir de las
   * facturas `posted`/`blocked` de la misma orden (ver `BillRepository.billedByOrderLine`).
   * Sin esto, dos facturas del 100% de lo recibido pasarían las dos: la invariante es acumulada.
   */
  billedSoFarByLine?: Map<string, bigint>;
  priceToleranceBp: number;
  qtyToleranceBp: number;
}): { matchStatus: MatchStatus; matchReasons: MatchReason[]; linesWithVariance: Array<{ lineId: string; priceVarianceCents: number }> } {
  const { bill, orderLines, priceToleranceBp, qtyToleranceBp } = params;
  const reasons: MatchReason[] = [];
  const linesWithVariance: Array<{ lineId: string; priceVarianceCents: number }> = [];

  for (const line of bill.lines) {
    if (!line.orderLineId) continue; // líneas sin orden no se concilian
    const orderLine = orderLines.get(line.orderLineId);
    if (!orderLine) {
      reasons.push({ code: 'LINE_NOT_IN_ORDER', lineId: line.id, detail: `Línea ${line.description} no está en la orden.` });
      continue;
    }

    // Cantidad: facturado_acumulado + esta ≤ recibido + tolerancia
    const received = orderLine.receivedMicros;
    const billedSoFar = params.billedSoFarByLine?.get(line.orderLineId) ?? 0n;
    const billed = billedSoFar + line.quantityMicros;
    const maxQty = received + (received * BigInt(qtyToleranceBp) / 10000n);
    if (billed > maxQty) {
      reasons.push({ code: 'QTY_EXCEEDS_RECEIVED', lineId: line.id, detail: `Cantidad facturada acumulada ${quantityToString(billed)} supera recibido ${quantityToString(received)} + tol. ${qtyToleranceBp} bp.` });
    }
    if (received === 0n) {
      reasons.push({ code: 'NO_RECEIPT', lineId: line.id, detail: `Producto sin recepción previa.` });
    }

    // Precio: |costo_factura - costo_orden| ≤ costo_orden * priceToleranceBp / 10000
    const priceDiff = Math.abs(line.unitCostCents - orderLine.unitCostCents);
    const allowedDiff = Math.floor((orderLine.unitCostCents * priceToleranceBp) / 10000);
    if (priceDiff > allowedDiff) {
      const diffBp = orderLine.unitCostCents > 0 ? Math.floor((priceDiff * 10000) / orderLine.unitCostCents) : 0;
      reasons.push({ code: 'PRICE_VARIANCE', lineId: line.id, detail: `Variación de precio ${diffBp} bp supera tolerancia ${priceToleranceBp} bp.` });
      // La variación es del TOTAL de la línea (centavos), no por unidad: es lo que necesita
      // contabilidad para dejar el inventario al costo estándar y llevar la diferencia aparte.
      const orderLineCents = Number((BigInt(orderLine.unitCostCents) * line.quantityMicros + 500_000n) / 1_000_000n);
      linesWithVariance.push({ lineId: line.id, priceVarianceCents: line.subtotalCents - orderLineCents });
    }
  }

  const matchStatus = reasons.length === 0 ? 'matched' : 'blocked';
  return { matchStatus, matchReasons: reasons, linesWithVariance };
}

/** Aplica override: pasa de blocked → posted con motivo y usuario distinto al creador. */
export function overrideBill(bill: PurchaseBill, userId: string, reason: string, now: Date): PurchaseBill {
  if (bill.status !== 'blocked') throw new BillNotOverridableError();
  if (bill.createdBy === userId) throw new SelfOverrideError();
  const trimmed = reason.trim();
  if (trimmed.length < 5) throw new ValidationError([{ field: 'overrideReason', message: 'El motivo de la excepción debe tener al menos 5 caracteres.' }]);
  return { ...bill, status: 'posted', matchStatus: 'overridden', overrideReason: trimmed.slice(0, 300), overrideBy: userId, updatedAt: now, version: bill.version + 1 };
}

/** Contabiliza: draft → posted (si cuadra o no aplica conciliación) o blocked (si hay razones). */
export function postBill(bill: PurchaseBill, matchResult: { matchStatus: MatchStatus; matchReasons: MatchReason[]; linesWithVariance: Array<{ lineId: string; priceVarianceCents: number }> }, now: Date): PurchaseBill {
  if (bill.status !== 'draft') throw new BillNotPostableError();
  // Ojo: 'not_applicable' (factura sin orden) es contabilizable; solo 'blocked' bloquea.
  const newStatus = matchResult.matchStatus === 'blocked' ? 'blocked' : 'posted';
  const updatedLines = bill.lines.map(l => {
    const variance = matchResult.linesWithVariance.find(v => v.lineId === l.id);
    return variance ? { ...l, priceVarianceCents: variance.priceVarianceCents } : l;
  });
  return {
    ...bill,
    status: newStatus,
    matchStatus: matchResult.matchStatus,
    matchReasons: matchResult.matchReasons,
    lines: updatedLines,
    updatedAt: now,
    version: bill.version + 1,
  };
}

/** Anula: posted/blocked → voided con motivo. `userId` no se guarda en la fila: quién anuló queda en el
 *  actor del evento `purchasing.bill.voided` (outbox), igual que en el resto del servicio. */
export function voidBill(bill: PurchaseBill, _userId: string, reason: string, now: Date): PurchaseBill {
  if (!['posted', 'blocked'].includes(bill.status)) throw new BillNotVoidableError();
  const trimmed = reason.trim();
  if (trimmed.length < 5) throw new ValidationError([{ field: 'voidReason', message: 'El motivo de la anulación debe tener al menos 5 caracteres.' }]);
  return { ...bill, status: 'voided', voidReason: trimmed.slice(0, 300), updatedAt: now, version: bill.version + 1 };
}

/** Valida totales del proveedor vs calculados (tolerancia 1 céntimo). */
export function validateSupplierTotals(supplierTotalCents: number, computedTotalCents: number): void {
  if (Math.abs(supplierTotalCents - computedTotalCents) > 1) throw new TotalsMismatchError(supplierTotalCents, computedTotalCents);
}

/** Marca la factura como con retención emitida (E.1). Lo llama el handler del evento fiscal.ec.withholding.issued.
 *  El id del documento no se persiste en la fila (no hay columna): viaja en el payload del evento
 *  `purchasing.bill.withholding_issued`, que es donde queda el rastro para auditoría. */
export function markBillWithholdingIssued(bill: PurchaseBill, _withholdingDocumentId: string, now: Date): PurchaseBill {
  if (bill.withholdingStatus === 'issued') throw new WithholdingAlreadyIssuedError();
  return { ...bill, withholdingStatus: 'issued', updatedAt: now, version: bill.version + 1 };
}