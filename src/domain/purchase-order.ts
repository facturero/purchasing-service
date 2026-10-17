import { randomUUID } from 'node:crypto';
import {
  ApprovalRequiredError,
  InvalidOrderStateError,
  SelfApprovalError,
  ValidationError,
  type ErrorDetail,
} from './errors.js';
import { assertCents, lineGrossCents, parsePercentHundredths, taxCentsOf } from './money.js';
import type { IdentificationType } from './supplier.js';

/**
 * Orden de compra. Ciclo de vida:
 *
 *   draft ──enviar──► pending_approval ──aprobar──► approved ──recibir──► partially_received ──► received
 *     │  ▲                  │                          │
 *     │  └──── rechazar ────┘ (vuelve a borrador)      └──cancelar──► cancelled
 *     └────────────── enviar sin aprobación (si la organización no la exige para ese monto) ──► approved
 *
 * - Solo un BORRADOR se edita. Una orden aprobada es un compromiso con el proveedor: se cancela con motivo, no se retoca.
 * - El número (`OC-2026-000001`) se asigna al enviarla (los borradores no gastan secuenciales).
 * - Quien prepara una orden no la aprueba (separación de funciones).
 * La recepción (partially_received / received) y el cierre las gobierna el módulo de recepción (Fase 2.2).
 */
export type OrderStatus =
  | 'draft'
  | 'pending_approval'
  | 'approved'
  | 'partially_received'
  | 'received'
  | 'closed'
  | 'cancelled'
  | 'rejected';

export const ORDER_STATUSES: readonly OrderStatus[] = [
  'draft', 'pending_approval', 'approved', 'partially_received', 'received', 'closed', 'cancelled', 'rejected',
];

export interface OrderLine {
  id: string;
  lineNumber: number;
  productId: string;
  /** SKU y descripción del producto al momento de pedir: la orden no cambia si luego renombran el producto. */
  sku: string | null;
  description: string;
  quantityMicros: bigint;
  unitCostCents: number;
  discountCents: number;
  taxRateId: string | null;
  /** Porcentaje del IVA al momento de pedir (`"15.00"`). */
  taxPercent: string;
  subtotalCents: number;
  taxCents: number;
  totalCents: number;
  /** Lo ya recibido en bodega (Fase 2.2). */
  receivedMicros: bigint;
}

export interface OrderLineInput {
  productId: string;
  sku: string | null;
  description: string;
  quantityMicros: bigint;
  unitCostCents: number;
  discountCents: number;
  taxRateId: string | null;
  taxPercent: string;
}

export interface SupplierSnapshot {
  identificationType: IdentificationType;
  identification: string;
  legalName: string;
}

export interface PurchaseOrder {
  id: string;
  organizationId: string;
  number: string | null;
  status: OrderStatus;
  supplierId: string;
  supplier: SupplierSnapshot;
  warehouseId: string;
  establishmentId: string | null;
  currencyCode: string;
  /** `AAAA-MM-DD`. */
  orderDate: string;
  expectedDate: string | null;
  paymentTermDays: number;
  notes: string | null;
  lines: OrderLine[];
  subtotalCents: number;
  taxCents: number;
  totalCents: number;
  createdBy: string;
  submittedAt: Date | null;
  approvedBy: string | null;
  approvedAt: Date | null;
  rejectionReason: string | null;
  cancelReason: string | null;
  cancelledBy: string | null;
  cancelledAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
  /** Para detectar dos ediciones a la vez. */
  version: number;
}

export interface OrderHeaderInput {
  supplierId: string;
  supplier: SupplierSnapshot;
  warehouseId: string;
  establishmentId: string | null;
  currencyCode: string;
  orderDate: string;
  expectedDate: string | null;
  paymentTermDays: number;
  notes: string | null;
}

export const MAX_LINES = 200;
const LOCAL_DATE = /^\d{4}-\d{2}-\d{2}$/;

export function computeLine(input: OrderLineInput, lineNumber: number, id: string = randomUUID()): OrderLine {
  assertCents(input.unitCostCents, `lines[${lineNumber - 1}].unitCostCents`);
  assertCents(input.discountCents, `lines[${lineNumber - 1}].discountCents`);
  const gross = lineGrossCents(input.quantityMicros, input.unitCostCents);
  if (input.discountCents > gross) {
    throw new ValidationError([{ field: `lines[${lineNumber - 1}].discountCents`, message: 'El descuento no puede superar el valor de la línea.' }]);
  }
  const subtotalCents = gross - input.discountCents;
  const taxCents = taxCentsOf(subtotalCents, parsePercentHundredths(input.taxPercent));
  return {
    id,
    lineNumber,
    productId: input.productId,
    sku: input.sku,
    description: input.description.trim(),
    quantityMicros: input.quantityMicros,
    unitCostCents: input.unitCostCents,
    discountCents: input.discountCents,
    taxRateId: input.taxRateId,
    taxPercent: input.taxPercent,
    subtotalCents,
    taxCents,
    totalCents: subtotalCents + taxCents,
    receivedMicros: 0n,
  };
}

export function computeTotals(lines: OrderLine[]): { subtotalCents: number; taxCents: number; totalCents: number } {
  const subtotalCents = lines.reduce((sum, l) => sum + l.subtotalCents, 0);
  const taxCents = lines.reduce((sum, l) => sum + l.taxCents, 0);
  return { subtotalCents, taxCents, totalCents: subtotalCents + taxCents };
}

export function validateHeader(header: OrderHeaderInput): void {
  const problems: ErrorDetail[] = [];
  if (!LOCAL_DATE.test(header.orderDate)) problems.push({ field: 'orderDate', message: 'La fecha de la orden debe ser AAAA-MM-DD.' });
  if (header.expectedDate !== null) {
    if (!LOCAL_DATE.test(header.expectedDate)) problems.push({ field: 'expectedDate', message: 'La fecha esperada debe ser AAAA-MM-DD.' });
    else if (LOCAL_DATE.test(header.orderDate) && header.expectedDate < header.orderDate) {
      problems.push({ field: 'expectedDate', message: 'La entrega esperada no puede ser anterior a la fecha de la orden.' });
    }
  }
  if (!/^[A-Z]{3}$/.test(header.currencyCode)) problems.push({ field: 'currencyCode', message: 'La moneda es un código de tres letras (USD).' });
  if (!Number.isInteger(header.paymentTermDays) || header.paymentTermDays < 0 || header.paymentTermDays > 365) {
    problems.push({ field: 'paymentTermDays', message: 'Los días de crédito van de 0 a 365.' });
  }
  if (problems.length) throw new ValidationError(problems);
}

export function newDraft(params: {
  organizationId: string;
  createdBy: string;
  header: OrderHeaderInput;
  lines: OrderLineInput[];
  now: Date;
}): PurchaseOrder {
  validateHeader(params.header);
  const lines = buildLines(params.lines);
  return {
    id: randomUUID(),
    organizationId: params.organizationId,
    number: null,
    status: 'draft',
    ...params.header,
    lines,
    ...computeTotals(lines),
    createdBy: params.createdBy,
    submittedAt: null,
    approvedBy: null,
    approvedAt: null,
    rejectionReason: null,
    cancelReason: null,
    cancelledBy: null,
    cancelledAt: null,
    createdAt: params.now,
    updatedAt: params.now,
    version: 1,
  };
}

export function buildLines(inputs: OrderLineInput[]): OrderLine[] {
  if (inputs.length === 0) throw new ValidationError([{ field: 'lines', message: 'La orden necesita al menos una línea.' }]);
  if (inputs.length > MAX_LINES) throw new ValidationError([{ field: 'lines', message: `Una orden admite hasta ${MAX_LINES} líneas.` }]);
  const problems: ErrorDetail[] = [];
  inputs.forEach((l, i) => {
    if (!l.description.trim()) problems.push({ field: `lines[${i}].description`, message: 'La descripción es obligatoria.' });
    if (l.description.length > 300) problems.push({ field: `lines[${i}].description`, message: 'La descripción admite hasta 300 caracteres.' });
  });
  if (problems.length) throw new ValidationError(problems);
  return inputs.map((l, i) => computeLine(l, i + 1));
}

function assertStatus(order: PurchaseOrder, allowed: OrderStatus[], action: string): void {
  if (!allowed.includes(order.status)) {
    throw new InvalidOrderStateError(`No se puede ${action} una orden en estado «${order.status}».`);
  }
}

/** Solo un borrador se edita. */
export function replaceDraft(order: PurchaseOrder, header: OrderHeaderInput, lines: OrderLineInput[], now: Date): PurchaseOrder {
  assertStatus(order, ['draft'], 'editar');
  validateHeader(header);
  const built = buildLines(lines);
  return { ...order, ...header, lines: built, ...computeTotals(built), updatedAt: now, version: order.version + 1 };
}

/** ¿Hay que pedir aprobación para este monto? `null` = la organización no exige aprobación nunca. */
export function requiresApproval(totalCents: number, thresholdCents: number | null): boolean {
  return thresholdCents !== null && totalCents >= thresholdCents;
}

/** Envía el borrador: le da número y, según la política, queda pendiente de aprobación o ya aprobada (sin aprobador humano). */
export function submit(order: PurchaseOrder, params: { number: string; needsApproval: boolean; now: Date }): PurchaseOrder {
  assertStatus(order, ['draft'], 'enviar');
  if (order.lines.length === 0) throw new ValidationError([{ field: 'lines', message: 'La orden necesita al menos una línea.' }]);
  if (order.totalCents <= 0) throw new ValidationError([{ field: 'lines', message: 'Una orden de compra no puede ser de valor cero.' }]);
  return {
    ...order,
    number: params.number,
    status: params.needsApproval ? 'pending_approval' : 'approved',
    submittedAt: params.now,
    // Una orden que no exigía aprobación queda aprobada «por política»: sin aprobador, y así se ve en el historial.
    approvedAt: params.needsApproval ? null : params.now,
    approvedBy: null,
    rejectionReason: null,
    updatedAt: params.now,
    version: order.version + 1,
  };
}

export function approve(order: PurchaseOrder, approverId: string, now: Date): PurchaseOrder {
  assertStatus(order, ['pending_approval'], 'aprobar');
  if (approverId === order.createdBy) throw new SelfApprovalError();
  return { ...order, status: 'approved', approvedBy: approverId, approvedAt: now, rejectionReason: null, updatedAt: now, version: order.version + 1 };
}

/** Rechazar devuelve la orden a borrador (con el motivo a la vista) para que se corrija y se vuelva a enviar. */
export function reject(order: PurchaseOrder, approverId: string, reason: string, now: Date): PurchaseOrder {
  assertStatus(order, ['pending_approval'], 'rechazar');
  if (approverId === order.createdBy) throw new SelfApprovalError('Quien preparó la orden no puede rechazarla: lo hace otra persona.');
  const trimmed = reason.trim();
  if (trimmed.length < 3) throw new ValidationError([{ field: 'reason', message: 'Indica el motivo del rechazo.' }]);
  return { ...order, status: 'rejected', rejectionReason: trimmed.slice(0, 300), updatedAt: now, version: order.version + 1 };
}

/** Una orden rechazada vuelve a ser editable. */
export function reopenRejected(order: PurchaseOrder, now: Date): PurchaseOrder {
  assertStatus(order, ['rejected'], 'reabrir');
  return { ...order, status: 'draft', updatedAt: now, version: order.version + 1 };
}

/** Cancelar: antes de recibir nada. Con mercadería recibida, lo pendiente se cierra (Fase 2.2), no se cancela. */
export function cancel(order: PurchaseOrder, userId: string, reason: string, now: Date): PurchaseOrder {
  assertStatus(order, ['draft', 'pending_approval', 'approved', 'rejected'], 'cancelar');
  if (order.lines.some((l) => l.receivedMicros > 0n)) {
    throw new InvalidOrderStateError('La orden ya recibió mercadería: no se cancela, se cierra lo pendiente.');
  }
  const trimmed = reason.trim();
  if (trimmed.length < 3) throw new ValidationError([{ field: 'reason', message: 'Indica el motivo de la cancelación.' }]);
  return { ...order, status: 'cancelled', cancelReason: trimmed.slice(0, 300), cancelledBy: userId, cancelledAt: now, updatedAt: now, version: order.version + 1 };
}

/** Una orden que todavía no se aprobó no puede recibir mercadería ni facturarse. */
export function assertApproved(order: PurchaseOrder): void {
  if (order.status === 'draft' || order.status === 'pending_approval' || order.status === 'rejected') throw new ApprovalRequiredError();
  if (order.status === 'cancelled' || order.status === 'closed') throw new InvalidOrderStateError(`La orden está ${order.status === 'cancelled' ? 'cancelada' : 'cerrada'}.`);
}

/** `OC-2026-000042`. */
export function formatOrderNumber(year: number, sequence: number): string {
  return `OC-${year}-${String(sequence).padStart(6, '0')}`;
}
