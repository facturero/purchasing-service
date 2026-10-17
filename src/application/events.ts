import { randomUUID } from 'node:crypto';
import type { PurchaseOrder } from '../domain/purchase-order.js';
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
    payload: { approvalThresholdCents: s.approvalThresholdCents, defaultWarehouseId: s.defaultWarehouseId },
  });
}
