import { randomUUID } from 'node:crypto';
import type { PurchaseOrder } from '../domain/purchase-order.js';
import type { PurchaseBill } from '../domain/purchase-bill.js';
import { quantityToString } from '../domain/money.js';
import type { DomainEvent, PurchasingSettings } from '../domain/repositories.js';
import type { Supplier } from '../domain/supplier.js';

/** Construye un DomainEvent con el envelope de bitácora (eventId/type/occurredAt). */
export function domainEvent(params: {
  type: string;
  aggregateType: string;
  aggregateId: string;
  organizationId: string;
  payload: Record<string, unknown>;
}): DomainEvent {
  return {
    eventId: randomUUID(),
    aggregateType: params.aggregateType,
    aggregateId: params.aggregateId,
    type: params.type,
    // La bitácora exige organizationId en el payload de todo mensaje.
    payload: { ...params.payload, organizationId: params.organizationId },
    occurredAt: new Date(),
  };
}

function supplierPayload(s: Supplier): Record<string, unknown> {
  return {
    supplierId: s.id,
    identificationType: s.identificationType,
    identification: s.identification,
    legalName: s.legalName,
    tradeName: s.tradeName,
    paymentTermDays: s.paymentTermDays,
    relatedParty: s.relatedParty,
    status: s.status,
  };
}

/** Alta o cambio de un proveedor (un solo tipo: quien lo consume guarda el último estado). */
export function supplierUpsertedEvent(s: Supplier, previousStatus?: string): DomainEvent {
  return domainEvent({
    type: 'purchasing.supplier.upserted',
    aggregateType: 'supplier',
    aggregateId: s.id,
    organizationId: s.organizationId,
    payload: { ...supplierPayload(s), ...(previousStatus ? { previousStatus } : {}) },
  });
}

/** Lo que cualquier evento de una orden lleva: sin datos de contacto del proveedor ni textos libres largos. */
export function orderPayload(o: PurchaseOrder): Record<string, unknown> {
  return {
    orderId: o.id,
    number: o.number,
    status: o.status,
    supplierId: o.supplierId,
    supplierName: o.supplier.legalName,
    warehouseId: o.warehouseId,
    establishmentId: o.establishmentId,
    currencyCode: o.currencyCode,
    orderDate: o.orderDate,
    subtotalCents: o.subtotalCents,
    taxCents: o.taxCents,
    totalCents: o.totalCents,
    lineCount: o.lines.length,
    createdBy: o.createdBy,
  };
}

function orderEvent(type: string, o: PurchaseOrder, extra: Record<string, unknown> = {}): DomainEvent {
  return domainEvent({ type, aggregateType: 'purchase_order', aggregateId: o.id, organizationId: o.organizationId, payload: { ...orderPayload(o), ...extra } });
}

export const orderCreatedEvent = (o: PurchaseOrder) => orderEvent('purchasing.order.created', o);
export const orderUpdatedEvent = (o: PurchaseOrder) => orderEvent('purchasing.order.updated', o);
export const orderSubmittedEvent = (o: PurchaseOrder, needsApproval: boolean) => orderEvent('purchasing.order.submitted', o, { needsApproval });
export const orderRejectedEvent = (o: PurchaseOrder) => orderEvent('purchasing.order.rejected', o, { rejectionReason: o.rejectionReason });
export const orderCancelledEvent = (o: PurchaseOrder) => orderEvent('purchasing.order.cancelled', o, { cancelReason: o.cancelReason, cancelledBy: o.cancelledBy });
export const orderReopenedEvent = (o: PurchaseOrder) => orderEvent('purchasing.order.reopened', o);

/**
 * Orden aprobada: el compromiso con el proveedor. Lleva las líneas (cantidades como texto, sin perder decimales) para quien deba
 * prever la entrada de mercadería o el compromiso de gasto.
 */
export function orderApprovedEvent(o: PurchaseOrder): DomainEvent {
  return orderEvent('purchasing.order.approved', o, {
    approvedBy: o.approvedBy,
    approvedAt: o.approvedAt?.toISOString() ?? null,
    approvedByPolicy: o.approvedBy === null,
    expectedDate: o.expectedDate,
    lines: o.lines.map((l) => ({
      productId: l.productId,
      quantity: quantityToString(l.quantityMicros),
      unitCostCents: l.unitCostCents,
      subtotalCents: l.subtotalCents,
      taxCents: l.taxCents,
    })),
  });
}

export function settingsUpdatedEvent(s: PurchasingSettings): DomainEvent {
  return domainEvent({
    type: 'purchasing.settings.updated',
    aggregateType: 'purchasing_settings',
    aggregateId: s.organizationId,
    organizationId: s.organizationId,
    payload: { approvalThresholdCents: s.approvalThresholdCents, defaultWarehouseId: s.defaultWarehouseId, overReceiptToleranceBp: s.overReceiptToleranceBp },
  });
}

/** Recepción de mercadería registrada (contrato con inventory-service).
 *  C.5: payload exacto que espera inventory. Lleva SOLO lo recibido en ESTA recepción: inventory suma cada línea tal cual
 *  llega, así que mandar la orden entera (o lo pedido) duplicaría el stock en cada entrega parcial. */
export function purchaseOrderReceivedEvent(params: {
  order: PurchaseOrder;
  receiptId: string;
  receiptNumber: string;
  warehouseId: string;
  lines: { productId: string; quantityMicros: bigint; unitCostCents: number }[];
}): DomainEvent {
  const { order, receiptId, receiptNumber, warehouseId, lines } = params;
  return domainEvent({
    type: 'purchase.purchase_order.received',
    aggregateType: 'purchase_order',
    aggregateId: order.id,
    organizationId: order.organizationId,
    payload: {
      purchaseOrderId: order.id,
      organizationId: order.organizationId,
      warehouseId,
      receiptId,
      receiptNumber,
      lines: lines.map((l) => ({
        productId: l.productId,
        quantity: quantityToString(l.quantityMicros),
        unitCostCents: l.unitCostCents,
        currencyCode: order.currencyCode,
      })),
    },
  });
}

/** Recepción registrada: evento propio de purchasing para auditoría y terceros (C.5). */
export function receiptPostedEvent(params: {
  receiptId: string;
  receiptNumber: string;
  orderId: string;
  orderNumber: string | null;
  supplierId: string;
  warehouseId: string;
  lineCount: number;
  totalCostCents: number;
  organizationId: string;
}): DomainEvent {
  return domainEvent({
    type: 'purchasing.receipt.posted',
    aggregateType: 'goods_receipt',
    aggregateId: params.receiptId,
    organizationId: params.organizationId,
    payload: {
      receiptId: params.receiptId,
      receiptNumber: params.receiptNumber,
      orderId: params.orderId,
      orderNumber: params.orderNumber,
      supplierId: params.supplierId,
      warehouseId: params.warehouseId,
      lineCount: params.lineCount,
      totalCostCents: params.totalCostCents,
    },
  });
}

/** Orden pasó a 'received' (todas las líneas de producto completadas). C.5. */
export function orderReceivedEvent(o: PurchaseOrder): DomainEvent {
  return orderEvent('purchasing.order.received', o);
}

/** Orden cerrada manualmente (lo pendiente se da por terminado). C.5. */
export function orderClosedEvent(o: PurchaseOrder, reason: string): DomainEvent {
  return orderEvent('purchasing.order.closed', o, { reason });
}

/** Factura de compra creada (borrador). D.5. */
export function billCreatedEvent(b: PurchaseBill): DomainEvent {
  return domainEvent({
    type: 'purchasing.bill.created',
    aggregateType: 'purchase_bill',
    aggregateId: b.id,
    organizationId: b.organizationId,
    payload: billPayload(b),
  });
}

/** Factura de compra actualizada (borrador). D.5. */
export function billUpdatedEvent(b: PurchaseBill): DomainEvent {
  return domainEvent({
    type: 'purchasing.bill.updated',
    aggregateType: 'purchase_bill',
    aggregateId: b.id,
    organizationId: b.organizationId,
    payload: billPayload(b),
  });
}

/** Factura de compra contabilizada (posted o blocked). D.5: evento de negocio que consume accounting. */
export function billPostedEvent(b: PurchaseBill): DomainEvent {
  return domainEvent({
    type: 'purchasing.bill.posted',
    aggregateType: 'purchase_bill',
    aggregateId: b.id,
    organizationId: b.organizationId,
    payload: billPayload(b),
  });
}

/** Factura bloqueada por conciliación. D.5. */
export function billBlockedEvent(b: PurchaseBill): DomainEvent {
  return domainEvent({
    type: 'purchasing.bill.blocked',
    aggregateType: 'purchase_bill',
    aggregateId: b.id,
    organizationId: b.organizationId,
    payload: { ...billPayload(b), matchReasons: b.matchReasons },
  });
}

/** Factura aprobada con excepción (override). D.5. */
export function billOverriddenEvent(b: PurchaseBill): DomainEvent {
  return domainEvent({
    type: 'purchasing.bill.overridden',
    aggregateType: 'purchase_bill',
    aggregateId: b.id,
    organizationId: b.organizationId,
    payload: { ...billPayload(b), overrideReason: b.overrideReason, overrideBy: b.overrideBy },
  });
}

/** Factura anulada. D.5. */
export function billVoidedEvent(b: PurchaseBill): DomainEvent {
  return domainEvent({
    type: 'purchasing.bill.voided',
    aggregateType: 'purchase_bill',
    aggregateId: b.id,
    organizationId: b.organizationId,
    payload: { ...billPayload(b), voidReason: b.voidReason },
  });
}

/**
 * Una retención emitida sobre esta factura quedó AUTORIZADA (la trae fiscal.ec.withholding.issued). El id y el número del
 * comprobante viajan aquí porque la factura no los guarda: es el rastro de auditoría de qué retención le corresponde.
 */
export function billWithholdingIssuedEvent(
  b: PurchaseBill,
  withholding: { withholdingId: string; number: string | null; authorizationNumber: string | null },
): DomainEvent {
  return domainEvent({
    type: 'purchasing.bill.withholding_issued',
    aggregateType: 'purchase_bill',
    aggregateId: b.id,
    organizationId: b.organizationId,
    payload: {
      ...billPayload(b),
      withholdingDocumentId: withholding.withholdingId,
      withholdingNumber: withholding.number,
      withholdingAuthorization: withholding.authorizationNumber,
    },
  });
}

/** Payload común para eventos de factura (D.5). */
function billPayload(b: PurchaseBill): Record<string, unknown> {
  // Agrupar por tarifa para el ATS/compras del SRI: solo se consideran los impuestos de IVA (taxCode '2' por defecto).
  // Los ICE/IRBPNR van en sus propias columnas en el ATS; aquí solo se agrupa lo necesario para el resumen por tarifa.
  const taxBreakdownMap = new Map<string, { taxCode: string; ratePercent: number; baseCents: number; amountCents: number }>();
  for (const l of b.lines) {
    const taxCode = l.taxCode ?? '2';
    const ratePercent = Number(l.taxRatePct);
    if (!Number.isFinite(ratePercent)) continue;
    const key = `${taxCode}-${ratePercent}`;
    const existing = taxBreakdownMap.get(key);
    const baseCents = l.subtotalCents;
    const amountCents = l.taxCents;
    if (existing) {
      existing.baseCents += baseCents;
      existing.amountCents += amountCents;
    } else {
      taxBreakdownMap.set(key, { taxCode, ratePercent, baseCents, amountCents });
    }
  }

  return {
    billId: b.id,
    internalNumber: b.internalNumber,
    supplierId: b.supplierId,
    supplier: {
      identification: b.supplier.identification,
      legalName: b.supplier.legalName,
      identificationType: b.supplier.identificationType,
    },
    docType: b.docType,
    supplierDocument: `${b.establishment}-${b.emissionPoint}-${b.sequential}`,
    issueDate: b.issueDate,
    dueDate: b.dueDate,
    currencyCode: b.currencyCode,
    subtotalCents: b.subtotalCents,
    taxCents: b.taxCents,
    totalCents: b.totalCents,
    // Datos necesarios para los anexos SRI
    authorizationNumber: b.authorizationNumber,
    paymentMethodCode: null,
    supportCode: null,
    taxBreakdown: taxBreakdownMap.size > 0 ? Array.from(taxBreakdownMap.values()) : [],
    establishmentId: null, // se puede añadir si se trae del proveedor
    orderId: b.purchaseOrderId,
    matchStatus: b.matchStatus,
    lines: b.lines.map((l) => ({
      kind: l.kind,
      productId: l.productId,
      expenseAccountHint: l.expenseAccountHint,
      subtotalCents: l.subtotalCents,
      vatCents: l.taxCents,
      iceCents: l.iceCents,
      irbpnrCents: l.irbpnrCents,
      priceVarianceCents: l.priceVarianceCents,
    })),
  };
}
