import { quantityToString } from '../../domain/money.js';
import type { OrderLine, PurchaseOrder } from '../../domain/purchase-order.js';
import type { PurchasingSettings } from '../../domain/repositories.js';
import type { Supplier } from '../../domain/supplier.js';

export const toSupplierJSON = (s: Supplier) => ({
  id: s.id,
  identificationType: s.identificationType,
  identification: s.identification,
  legalName: s.legalName,
  tradeName: s.tradeName,
  email: s.email,
  phone: s.phone,
  address: s.address,
  paymentTermDays: s.paymentTermDays,
  relatedParty: s.relatedParty,
  notes: s.notes,
  status: s.status,
  createdAt: s.createdAt.toISOString(),
  updatedAt: s.updatedAt.toISOString(),
});

const toLineJSON = (l: OrderLine) => ({
  id: l.id,
  lineNumber: l.lineNumber,
  productId: l.productId,
  sku: l.sku,
  description: l.description,
  // Las cantidades salen como texto: `bigint` no cabe en JSON y un número perdería los decimales.
  quantity: quantityToString(l.quantityMicros),
  unitCostCents: l.unitCostCents,
  discountCents: l.discountCents,
  taxRateId: l.taxRateId,
  taxPercent: l.taxPercent,
  subtotalCents: l.subtotalCents,
  taxCents: l.taxCents,
  totalCents: l.totalCents,
  receivedQuantity: quantityToString(l.receivedMicros),
});

const iso = (d: Date | null) => (d ? d.toISOString() : null);

/** `withLines: false` para los listados: el detalle trae las líneas, la lista solo cuántas hay. */
export const toOrderJSON = (o: PurchaseOrder, options: { withLines?: boolean } = {}) => ({
  id: o.id,
  number: o.number,
  status: o.status,
  supplierId: o.supplierId,
  supplier: o.supplier,
  warehouseId: o.warehouseId,
  establishmentId: o.establishmentId,
  currencyCode: o.currencyCode,
  orderDate: o.orderDate,
  expectedDate: o.expectedDate,
  paymentTermDays: o.paymentTermDays,
  notes: o.notes,
  subtotalCents: o.subtotalCents,
  taxCents: o.taxCents,
  totalCents: o.totalCents,
  lineCount: o.lines.length,
  ...(options.withLines === false ? {} : { lines: o.lines.map(toLineJSON) }),
  createdBy: o.createdBy,
  submittedAt: iso(o.submittedAt),
  approvedBy: o.approvedBy,
  approvedAt: iso(o.approvedAt),
  // Aprobada sin aprobador: la política de la organización no exigía aprobación para ese monto.
  approvedByPolicy: o.approvedAt !== null && o.approvedBy === null,
  rejectionReason: o.rejectionReason,
  cancelReason: o.cancelReason,
  cancelledBy: o.cancelledBy,
  cancelledAt: iso(o.cancelledAt),
  createdAt: o.createdAt.toISOString(),
  updatedAt: o.updatedAt.toISOString(),
  version: o.version,
});

export const toSettingsJSON = (s: PurchasingSettings) => ({
  approvalThresholdCents: s.approvalThresholdCents,
  defaultWarehouseId: s.defaultWarehouseId,
  updatedAt: s.updatedAt.toISOString(),
});
