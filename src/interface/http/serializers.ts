import { quantityToString } from '../../domain/money.js';
import type { GoodsReceipt, GoodsReceiptLine } from '../../domain/repositories.js';
import type { BillLine, PurchaseBill } from '../../domain/purchase-bill.js';
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
  overReceiptToleranceBp: s.overReceiptToleranceBp,
  priceToleranceBp: s.priceToleranceBp,
  qtyToleranceBp: s.qtyToleranceBp,
  updatedAt: s.updatedAt.toISOString(),
});

const toReceiptLineJSON = (l: GoodsReceiptLine) => ({
  id: l.id,
  orderLineId: l.orderLineId,
  productId: l.productId,
  quantity: quantityToString(l.quantityMicros),
  unitCostCents: l.unitCostCents,
  currencyCode: l.currencyCode,
});

export const toReceiptJSON = (r: GoodsReceipt & { lines?: GoodsReceiptLine[] }) => ({
  id: r.id,
  number: r.number,
  purchaseOrderId: r.purchaseOrderId,
  supplierId: r.supplierId,
  warehouseId: r.warehouseId,
  receiptDate: r.receiptDate,
  supplierDeliveryRef: r.supplierDeliveryRef,
  notes: r.notes,
  lineCount: r.lines?.length ?? 0,
  lines: r.lines?.map(toReceiptLineJSON) ?? [],
  createdBy: r.createdBy,
  createdAt: r.createdAt.toISOString(),
});

const toBillLineJSON = (l: BillLine) => ({
  id: l.id,
  lineNumber: l.lineNumber,
  orderLineId: l.orderLineId,
  productId: l.productId,
  kind: l.kind,
  description: l.description,
  quantity: quantityToString(l.quantityMicros),
  unitCostCents: l.unitCostCents,
  discountCents: l.discountCents,
  subtotalCents: l.subtotalCents,
  taxCode: l.taxCode,
  taxPercentageCode: l.taxPercentageCode,
  taxRatePct: l.taxRatePct,
  taxCents: l.taxCents,
  iceCents: l.iceCents,
  irbpnrCents: l.irbpnrCents,
  totalCents: l.totalCents,
  expenseAccountHint: l.expenseAccountHint,
  priceVarianceCents: l.priceVarianceCents,
});

export const toBillJSON = (b: PurchaseBill, options: { withLines?: boolean } = {}) => ({
  id: b.id,
  internalNumber: b.internalNumber,
  supplierId: b.supplierId,
  supplier: b.supplier,
  purchaseOrderId: b.purchaseOrderId,
  docType: b.docType,
  establishment: b.establishment,
  emissionPoint: b.emissionPoint,
  sequential: b.sequential,
  authorizationNumber: b.authorizationNumber,
  issueDate: b.issueDate,
  dueDate: b.dueDate,
  currencyCode: b.currencyCode,
  notes: b.notes,
  subtotalCents: b.subtotalCents,
  taxCents: b.taxCents,
  totalCents: b.totalCents,
  supplierTotalCents: b.supplierTotalCents,
  status: b.status,
  matchStatus: b.matchStatus,
  matchReasons: b.matchReasons,
  overrideReason: b.overrideReason,
  overrideBy: b.overrideBy,
  withholdingStatus: b.withholdingStatus,
  voidReason: b.voidReason,
  lineCount: b.lines.length,
  ...(options.withLines === false ? {} : { lines: b.lines.map(toBillLineJSON) }),
  createdBy: b.createdBy,
  createdAt: b.createdAt.toISOString(),
  updatedAt: b.updatedAt.toISOString(),
  version: b.version,
});
