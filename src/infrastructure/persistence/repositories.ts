import { Op, QueryTypes, Transaction, type WhereOptions } from 'sequelize';
import { withActor } from '@facturero/outbox-relay';
import { sequelize } from './sequelize.js';
import { GoodsReceiptLineModel, GoodsReceiptModel, OrderLineModel, OrderModel, OutboxModel, PurchaseBillLineModel, PurchaseBillModel, SettingsModel, SupplierModel } from './models.js';
import type { WriteUnitOfWork } from '../../application/ports.js';
import { ConcurrentUpdateError } from '../../domain/errors.js';
import type { OrderLine, OrderStatus, PurchaseOrder } from '../../domain/purchase-order.js';
import type { BillLine, BillStatus, MatchStatus, MatchReason, PurchaseBill, SupplierDocType } from '../../domain/purchase-bill.js';
import type {
  BillRepository,
  DomainEvent,
  GoodsReceipt,
  GoodsReceiptLine,
  OrderFilters,
  OrderRepository,
  OutboxRepository,
  Page,
  PurchasingSettings,
  ReceiptFilters,
  ReceiptRepository,
  SettingsRepository,
  SupplierFilters,
  SupplierRepository,
  UnitOfWork,
} from '../../domain/repositories.js';
import type { IdentificationType, Supplier, SupplierStatus } from '../../domain/supplier.js';

// ── Proveedores ─────────────────────────────────────────────────────────────

const toSupplier = (m: SupplierModel): Supplier => ({
  id: m.id,
  organizationId: m.organization_id,
  identificationType: m.identification_type as IdentificationType,
  identification: m.identification,
  legalName: m.legal_name,
  tradeName: m.trade_name,
  email: m.email,
  phone: m.phone,
  address: m.address,
  paymentTermDays: m.payment_term_days,
  relatedParty: Boolean(m.related_party),
  notes: m.notes,
  status: m.status as SupplierStatus,
  createdAt: m.created_at,
  updatedAt: m.updated_at,
});

const supplierFields = (s: Supplier) => ({
  organization_id: s.organizationId,
  identification_type: s.identificationType,
  identification: s.identification,
  legal_name: s.legalName,
  trade_name: s.tradeName,
  email: s.email,
  phone: s.phone,
  address: s.address,
  payment_term_days: s.paymentTermDays,
  related_party: s.relatedParty,
  notes: s.notes,
  status: s.status,
  updated_at: s.updatedAt,
});

/** Escapa los comodines de LIKE: buscar «100%» no debe traer todo. */
const likeTerm = (q: string): string => `%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;

function supplierRepository(tx?: Transaction): SupplierRepository {
  return {
    async findById(organizationId, id) {
      const row = await SupplierModel.findOne({ where: { id, organization_id: organizationId }, transaction: tx });
      return row ? toSupplier(row) : null;
    },
    async findByIdentification(organizationId, identification) {
      const row = await SupplierModel.findOne({ where: { organization_id: organizationId, identification }, transaction: tx });
      return row ? toSupplier(row) : null;
    },
    async list(organizationId, filters: SupplierFilters): Promise<Page<Supplier>> {
      const where: WhereOptions = { organization_id: organizationId };
      const and: WhereOptions[] = [];
      if (filters.status) and.push({ status: filters.status });
      if (filters.q?.trim()) {
        const term = likeTerm(filters.q.trim());
        and.push({ [Op.or]: [{ legal_name: { [Op.like]: term } }, { trade_name: { [Op.like]: term } }, { identification: { [Op.like]: term } }] });
      }
      const { rows, count } = await SupplierModel.findAndCountAll({
        where: and.length ? { [Op.and]: [where, ...and] } : where,
        order: [['legal_name', 'ASC']],
        limit: filters.pageSize,
        offset: (filters.page - 1) * filters.pageSize,
        transaction: tx,
      });
      return { items: rows.map(toSupplier), total: count, page: filters.page, pageSize: filters.pageSize };
    },
    async save(s) {
      // Por clave primaria, nunca `upsert`: en MySQL `ON DUPLICATE KEY` reacciona a CUALQUIER índice único y pisaría al proveedor de otro.
      const [updated] = await SupplierModel.update(supplierFields(s), { where: { id: s.id, organization_id: s.organizationId }, transaction: tx });
      if (updated === 0) {
        const exists = await SupplierModel.count({ where: { id: s.id, organization_id: s.organizationId }, transaction: tx });
        if (!exists) await SupplierModel.create({ id: s.id, created_at: s.createdAt, ...supplierFields(s) }, { transaction: tx });
      }
    },
  };
}

// ── Órdenes ─────────────────────────────────────────────────────────────────

const toLine = (m: OrderLineModel): OrderLine => ({
  id: m.id,
  lineNumber: m.line_number,
  productId: m.product_id,
  sku: m.sku,
  description: m.description,
  quantityMicros: BigInt(m.quantity_micros),
  unitCostCents: Number(m.unit_cost_cents),
  discountCents: Number(m.discount_cents),
  taxRateId: m.tax_rate_id,
  taxPercent: Number(m.tax_percent).toFixed(2),
  subtotalCents: Number(m.subtotal_cents),
  taxCents: Number(m.tax_cents),
  totalCents: Number(m.total_cents),
  receivedMicros: BigInt(m.received_micros),
});

const toOrder = (m: OrderModel, lines: OrderLineModel[]): PurchaseOrder => ({
  id: m.id,
  organizationId: m.organization_id,
  number: m.number,
  status: m.status as OrderStatus,
  supplierId: m.supplier_id,
  supplier: { identificationType: m.supplier_identification_type as IdentificationType, identification: m.supplier_identification, legalName: m.supplier_name },
  warehouseId: m.warehouse_id,
  establishmentId: m.establishment_id,
  currencyCode: m.currency_code,
  orderDate: String(m.order_date),
  expectedDate: m.expected_date ? String(m.expected_date) : null,
  paymentTermDays: m.payment_term_days,
  notes: m.notes,
  lines: lines.sort((a, b) => a.line_number - b.line_number).map(toLine),
  subtotalCents: Number(m.subtotal_cents),
  taxCents: Number(m.tax_cents),
  totalCents: Number(m.total_cents),
  createdBy: m.created_by,
  submittedAt: m.submitted_at,
  approvedBy: m.approved_by,
  approvedAt: m.approved_at,
  rejectionReason: m.rejection_reason,
  cancelReason: m.cancel_reason,
  cancelledBy: m.cancelled_by,
  cancelledAt: m.cancelled_at,
  createdAt: m.created_at,
  updatedAt: m.updated_at,
  version: m.version,
});

const orderFields = (o: PurchaseOrder) => ({
  organization_id: o.organizationId,
  number: o.number,
  status: o.status,
  supplier_id: o.supplierId,
  supplier_identification_type: o.supplier.identificationType,
  supplier_identification: o.supplier.identification,
  supplier_name: o.supplier.legalName,
  warehouse_id: o.warehouseId,
  establishment_id: o.establishmentId,
  currency_code: o.currencyCode,
  order_date: o.orderDate,
  expected_date: o.expectedDate,
  payment_term_days: o.paymentTermDays,
  notes: o.notes,
  subtotal_cents: o.subtotalCents,
  tax_cents: o.taxCents,
  total_cents: o.totalCents,
  created_by: o.createdBy,
  submitted_at: o.submittedAt,
  approved_by: o.approvedBy,
  approved_at: o.approvedAt,
  rejection_reason: o.rejectionReason,
  cancel_reason: o.cancelReason,
  cancelled_by: o.cancelledBy,
  cancelled_at: o.cancelledAt,
  version: o.version,
  updated_at: o.updatedAt,
});

const lineFields = (o: PurchaseOrder, l: OrderLine) => ({
  id: l.id,
  order_id: o.id,
  organization_id: o.organizationId,
  line_number: l.lineNumber,
  product_id: l.productId,
  sku: l.sku,
  description: l.description,
  quantity_micros: l.quantityMicros.toString(),
  unit_cost_cents: l.unitCostCents,
  discount_cents: l.discountCents,
  tax_rate_id: l.taxRateId,
  tax_percent: l.taxPercent,
  subtotal_cents: l.subtotalCents,
  tax_cents: l.taxCents,
  total_cents: l.totalCents,
  received_micros: l.receivedMicros.toString(),
});

function orderRepository(tx?: Transaction): OrderRepository {
  async function linesOf(orderIds: string[], lock: boolean): Promise<Map<string, OrderLineModel[]>> {
    const byOrder = new Map<string, OrderLineModel[]>();
    if (!orderIds.length) return byOrder;
    const rows = await OrderLineModel.findAll({
      where: { order_id: orderIds },
      transaction: tx,
      ...(lock && tx ? { lock: tx.LOCK.UPDATE } : {}),
    });
    for (const row of rows) byOrder.set(row.order_id, [...(byOrder.get(row.order_id) ?? []), row]);
    return byOrder;
  }

  return {
    async findById(organizationId, id, options) {
      const lock = Boolean(options?.lock && tx);
      const row = await OrderModel.findOne({ where: { id, organization_id: organizationId }, transaction: tx, ...(lock ? { lock: tx!.LOCK.UPDATE } : {}) });
      if (!row) return null;
      const lines = await linesOf([row.id], lock);
      return toOrder(row, lines.get(row.id) ?? []);
    },

    async list(organizationId, filters: OrderFilters): Promise<Page<PurchaseOrder>> {
      const and: WhereOptions[] = [{ organization_id: organizationId }];
      if (filters.status) and.push({ status: filters.status });
      if (filters.supplierId) and.push({ supplier_id: filters.supplierId });
      if (filters.from) and.push({ order_date: { [Op.gte]: filters.from } });
      if (filters.to) and.push({ order_date: { [Op.lte]: filters.to } });
      if (filters.q?.trim()) {
        const term = likeTerm(filters.q.trim());
        and.push({ [Op.or]: [{ number: { [Op.like]: term } }, { supplier_name: { [Op.like]: term } }] });
      }
      const { rows, count } = await OrderModel.findAndCountAll({
        where: { [Op.and]: and },
        order: [['order_date', 'DESC'], ['created_at', 'DESC']],
        limit: filters.pageSize,
        offset: (filters.page - 1) * filters.pageSize,
        transaction: tx,
      });
      const lines = await linesOf(rows.map((r) => r.id), false);
      return { items: rows.map((r) => toOrder(r, lines.get(r.id) ?? [])), total: count, page: filters.page, pageSize: filters.pageSize };
    },

    async save(order, expectedVersion) {
      if (expectedVersion === null) {
        await OrderModel.create({ id: order.id, created_at: order.createdAt, ...orderFields(order) }, { transaction: tx });
      } else {
        // Solo si nadie la cambió desde que se leyó: si no, dos personas se pisarían sin saberlo.
        const [updated] = await OrderModel.update(orderFields(order), {
          where: { id: order.id, organization_id: order.organizationId, version: expectedVersion },
          transaction: tx,
        });
        if (updated === 0) throw new ConcurrentUpdateError();
        await OrderLineModel.destroy({ where: { order_id: order.id }, transaction: tx });
      }
      await OrderLineModel.bulkCreate(order.lines.map((l) => lineFields(order, l)), { transaction: tx });
    },

    /**
     * `INSERT … ON DUPLICATE KEY UPDATE` en UNA sentencia y luego lectura con FOR UPDATE: la primera orden del año crea el
     * contador y las siguientes lo suben, sin carrera entre un SELECT y un UPDATE. (Insertar «por si acaso» y actualizar después
     * provocó interbloqueos con 30 operaciones simultáneas; con esta forma no.)
     */
    async nextSequence(organizationId, year) {
      await sequelize.query(
        'INSERT INTO order_sequences (organization_id, year, current_value) VALUES (:organizationId, :year, 1) ON DUPLICATE KEY UPDATE current_value = current_value + 1',
        { replacements: { organizationId, year }, transaction: tx },
      );
      const [row] = await sequelize.query<{ current_value: number }>(
        'SELECT current_value FROM order_sequences WHERE organization_id = :organizationId AND year = :year FOR UPDATE',
        { replacements: { organizationId, year }, transaction: tx, type: QueryTypes.SELECT },
      );
      return Number(row!.current_value);
    },
  };
}

// ── Ajustes y outbox ────────────────────────────────────────────────────────

function settingsRepository(tx?: Transaction): SettingsRepository {
  return {
    async find(organizationId) {
      const row = await SettingsModel.findByPk(organizationId, { transaction: tx });
      if (!row) return null;
      return {
        organizationId: row.organization_id,
        approvalThresholdCents: row.approval_threshold_cents === null ? null : Number(row.approval_threshold_cents),
        defaultWarehouseId: row.default_warehouse_id,
        overReceiptToleranceBp: Number(row.over_receipt_tolerance_bp ?? 0),
        priceToleranceBp: Number(row.price_tolerance_bp ?? 0),
        qtyToleranceBp: Number(row.qty_tolerance_bp ?? 0),
        updatedAt: row.updated_at,
      };
    },
    async save(s: PurchasingSettings) {
      const fields = {
        approval_threshold_cents: s.approvalThresholdCents,
        default_warehouse_id: s.defaultWarehouseId,
        over_receipt_tolerance_bp: s.overReceiptToleranceBp,
        price_tolerance_bp: s.priceToleranceBp,
        qty_tolerance_bp: s.qtyToleranceBp,
        updated_at: s.updatedAt,
      };
      const [updated] = await SettingsModel.update(fields, { where: { organization_id: s.organizationId }, transaction: tx });
      if (updated === 0) {
        const exists = await SettingsModel.count({ where: { organization_id: s.organizationId }, transaction: tx });
        if (!exists) await SettingsModel.create({ organization_id: s.organizationId, ...fields }, { transaction: tx });
      }
    },
  };
}

function receiptRepository(tx?: Transaction): ReceiptRepository {
  const toReceipt = (m: GoodsReceiptModel): GoodsReceipt => ({
    id: m.id,
    organizationId: m.organization_id,
    number: m.number,
    purchaseOrderId: m.purchase_order_id,
    supplierId: m.supplier_id,
    warehouseId: m.warehouse_id,
    receiptDate: String(m.receipt_date),
    supplierDeliveryRef: m.supplier_delivery_ref,
    notes: m.notes,
    createdBy: m.created_by,
    createdAt: m.created_at,
    lines: [],
  });

  const toLine = (m: GoodsReceiptLineModel): GoodsReceiptLine => ({
    id: m.id,
    receiptId: m.receipt_id,
    orderLineId: m.order_line_id,
    productId: m.product_id,
    quantityMicros: BigInt(m.quantity_micros),
    unitCostCents: Number(m.unit_cost_cents),
    currencyCode: m.currency_code,
  });

  // Carga las líneas de un recibo (el detalle lo pide la UI de recepción).
  const linesOf = async (receiptId: string): Promise<GoodsReceiptLine[]> => {
    const rows = await GoodsReceiptLineModel.findAll({ where: { receipt_id: receiptId }, order: [['id', 'ASC']], transaction: tx });
    return rows.map(toLine);
  };

  return {
    async findById(organizationId, id) {
      const row = await GoodsReceiptModel.findOne({ where: { id, organization_id: organizationId }, transaction: tx });
      if (!row) return null;
      const receipt = toReceipt(row);
      return { ...receipt, lines: await linesOf(row.id) };
    },
    async findByNumber(organizationId, number) {
      const row = await GoodsReceiptModel.findOne({ where: { organization_id: organizationId, number }, transaction: tx });
      return row ? toReceipt(row) : null;
    },
    async list(organizationId, filters: ReceiptFilters): Promise<Page<GoodsReceipt>> {
      const and: WhereOptions[] = [{ organization_id: organizationId }];
      if (filters.purchaseOrderId) and.push({ purchase_order_id: filters.purchaseOrderId });
      if (filters.supplierId) and.push({ supplier_id: filters.supplierId });
      if (filters.from) and.push({ receipt_date: { [Op.gte]: filters.from } });
      if (filters.to) and.push({ receipt_date: { [Op.lte]: filters.to } });
      if (filters.q?.trim()) {
        const term = likeTerm(filters.q.trim());
        and.push({ [Op.or]: [{ number: { [Op.like]: term } }] });
      }
      const { rows, count } = await GoodsReceiptModel.findAndCountAll({
        where: { [Op.and]: and },
        order: [['receipt_date', 'DESC'], ['created_at', 'DESC']],
        limit: filters.pageSize,
        offset: (filters.page - 1) * filters.pageSize,
        transaction: tx,
      });
      return { items: rows.map(toReceipt), total: count, page: filters.page, pageSize: filters.pageSize };
    },
    async save(receipt: GoodsReceipt) {
      const fields = {
        id: receipt.id,
        organization_id: receipt.organizationId,
        number: receipt.number,
        purchase_order_id: receipt.purchaseOrderId,
        supplier_id: receipt.supplierId,
        warehouse_id: receipt.warehouseId,
        receipt_date: receipt.receiptDate,
        supplier_delivery_ref: receipt.supplierDeliveryRef,
        notes: receipt.notes,
        created_by: receipt.createdBy,
        created_at: receipt.createdAt,
      };
      await GoodsReceiptModel.create(fields, { transaction: tx });
    },
    async saveLines(lines: GoodsReceiptLine[]) {
      if (!lines.length) return;
      await GoodsReceiptLineModel.bulkCreate(
        lines.map((l) => ({
          id: l.id,
          receipt_id: l.receiptId,
          order_line_id: l.orderLineId,
          product_id: l.productId,
          quantity_micros: l.quantityMicros.toString(),
          unit_cost_cents: l.unitCostCents,
          currency_code: l.currencyCode,
        })),
        { transaction: tx },
      );
    },
    async nextReceiptSequence(organizationId, year) {
      await sequelize.query(
        'INSERT INTO receipt_sequences (organization_id, year, current_value) VALUES (:organizationId, :year, 1) ON DUPLICATE KEY UPDATE current_value = current_value + 1',
        { replacements: { organizationId, year }, transaction: tx },
      );
      const [row] = await sequelize.query<{ current_value: number }>(
        'SELECT current_value FROM receipt_sequences WHERE organization_id = :organizationId AND year = :year FOR UPDATE',
        { replacements: { organizationId, year }, transaction: tx, type: QueryTypes.SELECT },
      );
      return Number(row!.current_value);
    },
  };
}

function billRepository(tx?: Transaction): BillRepository {
  const toBill = (m: PurchaseBillModel): PurchaseBill => ({
    id: m.id,
    organizationId: m.organization_id,
    internalNumber: m.internal_number,
    supplierId: m.supplier_id,
    supplier: { identificationType: m.supplier_identification_type as IdentificationType, identification: m.supplier_identification, legalName: m.supplier_name },
    purchaseOrderId: m.purchase_order_id,
    docType: m.doc_type as SupplierDocType,
    establishment: m.establishment,
    emissionPoint: m.emission_point,
    sequential: m.sequential,
    authorizationNumber: m.authorization_number,
    issueDate: String(m.issue_date),
    dueDate: String(m.due_date),
    currencyCode: m.currency_code,
    subtotalCents: Number(m.subtotal_cents),
    taxCents: Number(m.tax_cents),
    totalCents: Number(m.total_cents),
    supplierTotalCents: Number(m.supplier_total_cents),
    status: m.status as BillStatus,
    matchStatus: m.match_status as MatchStatus,
    matchReasons: (m.match_reasons as MatchReason[]) ?? [],
    overrideReason: m.override_reason,
    overrideBy: m.override_by,
    withholdingStatus: m.withholding_status as 'none' | 'issued',
    voidReason: m.void_reason,
    createdBy: m.created_by,
    version: m.version,
    createdAt: m.created_at,
    updatedAt: m.updated_at,
    lines: [],
  });

  const toLine = (m: PurchaseBillLineModel): BillLine => ({
    id: m.id,
    lineNumber: m.line_number,
    orderLineId: m.order_line_id,
    productId: m.product_id,
    description: m.description,
    quantityMicros: BigInt(m.quantity_micros),
    unitCostCents: Number(m.unit_cost_cents),
    discountCents: Number(m.discount_cents),
    subtotalCents: Number(m.subtotal_cents),
    taxCode: m.tax_code,
    taxPercentageCode: m.tax_percentage_code,
    taxRatePct: Number(m.tax_rate_pct).toFixed(2),
    taxCents: Number(m.tax_cents),
    iceCents: Number(m.ice_cents),
    irbpnrCents: Number(m.irbpnr_cents),
    totalCents: Number(m.total_cents),
    expenseAccountHint: m.expense_account_hint,
    priceVarianceCents: Number(m.price_variance_cents),
  });

  const billFields = (b: PurchaseBill) => ({
    id: b.id,
    organization_id: b.organizationId,
    internal_number: b.internalNumber,
    supplier_id: b.supplierId,
    supplier_identification_type: b.supplier.identificationType,
    supplier_identification: b.supplier.identification,
    supplier_name: b.supplier.legalName,
    purchase_order_id: b.purchaseOrderId,
    doc_type: b.docType,
    establishment: b.establishment,
    emission_point: b.emissionPoint,
    sequential: b.sequential,
    authorization_number: b.authorizationNumber,
    issue_date: b.issueDate,
    due_date: b.dueDate,
    currency_code: b.currencyCode,
    subtotal_cents: b.subtotalCents,
    tax_cents: b.taxCents,
    total_cents: b.totalCents,
    supplier_total_cents: b.supplierTotalCents,
    status: b.status,
    match_status: b.matchStatus,
    match_reasons: b.matchReasons,
    override_reason: b.overrideReason,
    override_by: b.overrideBy,
    withholding_status: b.withholdingStatus,
    void_reason: b.voidReason,
    created_by: b.createdBy,
    version: b.version,
    created_at: b.createdAt,
    updated_at: b.updatedAt,
  });

  return {
    async findById(organizationId, id, options) {
      const lock = Boolean(options?.lock && tx);
      const row = await PurchaseBillModel.findOne({
        where: { id, organization_id: organizationId },
        transaction: tx,
        ...(lock ? { lock: tx!.LOCK.UPDATE } : {}),
      });
      if (!row) return null;
      const lineRows = await PurchaseBillLineModel.findAll({
        where: { bill_id: row.id, organization_id: organizationId },
        order: [['line_number', 'ASC']],
        transaction: tx,
      });
      const bill = toBill(row);
      return { ...bill, lines: lineRows.map(toLine) };
    },
    async findBySupplierDocument(organizationId, supplierId, docType, establishment, emissionPoint, sequential) {
      const row = await PurchaseBillModel.findOne({
        where: { organization_id: organizationId, supplier_id: supplierId, doc_type: docType, establishment, emission_point: emissionPoint, sequential },
        transaction: tx,
      });
      return row ? toBill(row) : null;
    },
    async findByAuthorization(organizationId, authorizationNumber) {
      if (!authorizationNumber) return null;
      const row = await PurchaseBillModel.findOne({
        where: { organization_id: organizationId, authorization_number: authorizationNumber },
        transaction: tx,
      });
      return row ? toBill(row) : null;
    },
    async list(organizationId, filters: import('../../domain/repositories.js').BillFilters): Promise<import('../../domain/repositories.js').Page<PurchaseBill>> {
      const and: WhereOptions[] = [{ organization_id: organizationId }];
      if (filters.supplierId) and.push({ supplier_id: filters.supplierId });
      if (filters.status) and.push({ status: filters.status });
      if (filters.matchStatus) and.push({ match_status: filters.matchStatus });
      if (filters.purchaseOrderId) and.push({ purchase_order_id: filters.purchaseOrderId });
      if (filters.from) and.push({ issue_date: { [Op.gte]: filters.from } });
      if (filters.to) and.push({ issue_date: { [Op.lte]: filters.to } });
      if (filters.q?.trim()) {
        const term = likeTerm(filters.q.trim());
        and.push({ [Op.or]: [{ internal_number: { [Op.like]: term } }, { supplier_name: { [Op.like]: term } }] });
      }
      const { rows, count } = await PurchaseBillModel.findAndCountAll({
        where: { [Op.and]: and },
        order: [['issue_date', 'DESC'], ['created_at', 'DESC']],
        limit: filters.pageSize,
        offset: (filters.page - 1) * filters.pageSize,
        transaction: tx,
      });
      return { items: rows.map(toBill), total: count, page: filters.page, pageSize: filters.pageSize };
    },
    async save(bill: PurchaseBill, expectedVersion?: number | null) {
      const exists = await PurchaseBillModel.findOne({ where: { id: bill.id }, transaction: tx });
      if (!exists) {
        await PurchaseBillModel.create(billFields(bill), { transaction: tx });
        return;
      }
      if (expectedVersion !== undefined && expectedVersion !== null) {
        // Solo si nadie la cambió desde que se leyó: si no, dos personas se pisarían sin saberlo.
        const [updated] = await PurchaseBillModel.update(billFields(bill), {
          where: { id: bill.id, organization_id: bill.organizationId, version: expectedVersion },
          transaction: tx,
        });
        if (updated === 0) throw new ConcurrentUpdateError();
        return;
      }
      await PurchaseBillModel.update(billFields(bill), {
        where: { id: bill.id, organization_id: bill.organizationId },
        transaction: tx,
      });
    },
    async saveLines(billId: string, organizationId: string, lines: BillLine[]) {
      // Reemplazo completo: al editar, las líneas viejas no pueden quedarse (cada línea nueva trae id propio).
      await PurchaseBillLineModel.destroy({ where: { bill_id: billId }, transaction: tx });
      if (!lines.length) return;
      await PurchaseBillLineModel.bulkCreate(
        lines.map((l) => ({
          id: l.id,
          bill_id: billId,
          organization_id: organizationId,
          line_number: l.lineNumber,
          order_line_id: l.orderLineId,
          product_id: l.productId,
          description: l.description,
          quantity_micros: l.quantityMicros.toString(),
          unit_cost_cents: l.unitCostCents,
          discount_cents: l.discountCents,
          subtotal_cents: l.subtotalCents,
          tax_code: l.taxCode,
          tax_percentage_code: l.taxPercentageCode,
          tax_rate_pct: l.taxRatePct,
          tax_cents: l.taxCents,
          ice_cents: l.iceCents,
          irbpnr_cents: l.irbpnrCents,
          total_cents: l.totalCents,
          expense_account_hint: l.expenseAccountHint,
          price_variance_cents: l.priceVarianceCents,
        })),
        { transaction: tx },
      );
    },
    async billedByOrderLine(organizationId: string, purchaseOrderId: string, excludeBillId?: string) {
      // Suma acumulada de lo ya facturado contra la orden (posted/blocked). Las draft no cuentan y las
      // voided se excluyen solas: así la conciliación impide facturar dos veces la misma recepción.
      // Corre en una transacción READ COMMITTED (ver PostBillUseCase): con REPEATABLE READ esta suma saldría de la instantánea
      // tomada al cargar las líneas de la factura, ANTES de esperar el bloqueo de la orden, y no vería la factura que acaba de
      // confirmar quien lo tenía (30 facturas a la vez pasaban 19 en vez de 10). No se usa FOR SHARE porque, al leer las
      // cabeceras de las demás facturas, choca con el bloqueo que cada transacción en espera tiene sobre la suya: interbloqueo.
      const rows = await sequelize.query<{ order_line_id: string; billed: string }>(
        `SELECT l.order_line_id AS order_line_id, SUM(l.quantity_micros) AS billed
           FROM purchase_bill_lines l
           JOIN purchase_bills b ON b.id = l.bill_id
          WHERE b.organization_id = :organizationId
            AND b.purchase_order_id = :purchaseOrderId
            AND b.status IN ('posted', 'blocked')
            AND l.order_line_id IS NOT NULL
            AND (:excludeBillId IS NULL OR b.id <> :excludeBillId)
          GROUP BY l.order_line_id`,
        {
          replacements: { organizationId, purchaseOrderId, excludeBillId: excludeBillId ?? null },
          transaction: tx,
          type: QueryTypes.SELECT,
        },
      );
      const map = new Map<string, bigint>();
      for (const row of rows) map.set(row.order_line_id, BigInt(row.billed));
      return map;
    },
    async nextBillSequence(organizationId, year) {
      await sequelize.query(
        'INSERT INTO bill_sequences (organization_id, year, current_value) VALUES (:organizationId, :year, 1) ON DUPLICATE KEY UPDATE current_value = current_value + 1',
        { replacements: { organizationId, year }, transaction: tx },
      );
      const [row] = await sequelize.query<{ current_value: number }>(
        'SELECT current_value FROM bill_sequences WHERE organization_id = :organizationId AND year = :year FOR UPDATE',
        { replacements: { organizationId, year }, transaction: tx, type: QueryTypes.SELECT },
      );
      return Number(row!.current_value);
    },
  };
}

function outboxRepository(tx?: Transaction): OutboxRepository {
  return {
    async add(event: DomainEvent) {
      await OutboxModel.create(
        {
          id: event.eventId,
          aggregate_type: event.aggregateType,
          aggregate_id: event.aggregateId,
          type: event.type,
          // El actor/IP/request-id viajan en el contexto de la petición para que la bitácora sepa QUIÉN hizo cada cosa.
          payload: withActor(event.payload),
          occurred_at: event.occurredAt,
          processed_at: null,
        },
        { transaction: tx },
      );
    },
  };
}

// ── Ensamblaje ──────────────────────────────────────────────────────────────

export function buildRepositories(tx?: Transaction): UnitOfWork {
  return {
    suppliers: supplierRepository(tx),
    orders: orderRepository(tx),
    receipts: receiptRepository(tx),
    bills: billRepository(tx),
    settings: settingsRepository(tx),
    outbox: outboxRepository(tx),
  };
}

export const readOnlyRepositories: UnitOfWork = buildRepositories(undefined);

export class SequelizeUnitOfWork implements WriteUnitOfWork {
  readonly suppliers;
  readonly orders;
  readonly receipts;
  readonly bills;
  readonly settings;
  readonly outbox;

  constructor(readonly tx: Transaction) {
    const repos = buildRepositories(tx);
    this.suppliers = repos.suppliers;
    this.orders = repos.orders;
    this.receipts = repos.receipts;
    this.bills = repos.bills;
    this.settings = repos.settings;
    this.outbox = repos.outbox;
  }

  async commit(): Promise<void> {
    await this.tx.commit();
  }

  async rollback(): Promise<void> {
    // MySQL deshace por su cuenta la transacción que pierde un interbloqueo; volver a deshacerla lanzaría un error que taparía el verdadero.
    if ((this.tx as unknown as { finished?: string }).finished) return;
    await this.tx.rollback();
  }
}

export class SequelizeUnitOfWorkFactory {
  constructor(private readonly onCommit?: (tx: Transaction) => void) {}

  async begin(options?: { readCommitted?: boolean }): Promise<SequelizeUnitOfWork> {
    const tx = await sequelize.transaction(options?.readCommitted ? { isolationLevel: Transaction.ISOLATION_LEVELS.READ_COMMITTED } : undefined);
    // El relay publica el outbox justo tras el commit; sin este enganche los eventos esperan los 30 s del temporizador de respaldo.
    this.onCommit?.(tx);
    return new SequelizeUnitOfWork(tx);
  }
}
