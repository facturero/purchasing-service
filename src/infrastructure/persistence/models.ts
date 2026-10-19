import { DataTypes, Model, type InferAttributes, type InferCreationAttributes } from 'sequelize';
import { sequelize } from './sequelize.js';

// Importes en BIGINT: mysql2 los devuelve como string (o number si caben); los repositorios los pasan por Number()/BigInt().

export class SupplierModel extends Model<InferAttributes<SupplierModel>, InferCreationAttributes<SupplierModel>> {
  declare id: string;
  declare organization_id: string;
  declare identification_type: string;
  declare identification: string;
  declare legal_name: string;
  declare trade_name: string | null;
  declare email: string | null;
  declare phone: string | null;
  declare address: string | null;
  declare payment_term_days: number;
  declare related_party: boolean;
  declare notes: string | null;
  declare status: string;
  declare created_at: Date;
  declare updated_at: Date;
}

SupplierModel.init(
  {
    id: { type: DataTypes.CHAR(36), primaryKey: true },
    organization_id: { type: DataTypes.CHAR(36), allowNull: false },
    identification_type: { type: DataTypes.STRING(12), allowNull: false },
    identification: { type: DataTypes.STRING(20), allowNull: false },
    legal_name: { type: DataTypes.STRING(300), allowNull: false },
    trade_name: { type: DataTypes.STRING(300), allowNull: true },
    email: { type: DataTypes.STRING(300), allowNull: true },
    phone: { type: DataTypes.STRING(40), allowNull: true },
    address: { type: DataTypes.STRING(500), allowNull: true },
    payment_term_days: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
    related_party: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
    notes: { type: DataTypes.TEXT, allowNull: true },
    status: { type: DataTypes.STRING(10), allowNull: false, defaultValue: 'active' },
    created_at: { type: DataTypes.DATE, allowNull: false },
    updated_at: { type: DataTypes.DATE, allowNull: false },
  },
  { sequelize, tableName: 'suppliers', timestamps: false },
);

export class OrderModel extends Model<InferAttributes<OrderModel>, InferCreationAttributes<OrderModel>> {
  declare id: string;
  declare organization_id: string;
  declare number: string | null;
  declare status: string;
  declare supplier_id: string;
  declare supplier_identification_type: string;
  declare supplier_identification: string;
  declare supplier_name: string;
  declare warehouse_id: string;
  declare establishment_id: string | null;
  declare currency_code: string;
  declare order_date: string;
  declare expected_date: string | null;
  declare payment_term_days: number;
  declare notes: string | null;
  declare subtotal_cents: string | number;
  declare tax_cents: string | number;
  declare total_cents: string | number;
  declare created_by: string;
  declare submitted_at: Date | null;
  declare approved_by: string | null;
  declare approved_at: Date | null;
  declare rejection_reason: string | null;
  declare cancel_reason: string | null;
  declare cancelled_by: string | null;
  declare cancelled_at: Date | null;
  declare version: number;
  declare created_at: Date;
  declare updated_at: Date;
}

OrderModel.init(
  {
    id: { type: DataTypes.CHAR(36), primaryKey: true },
    organization_id: { type: DataTypes.CHAR(36), allowNull: false },
    number: { type: DataTypes.STRING(20), allowNull: true },
    status: { type: DataTypes.STRING(20), allowNull: false },
    supplier_id: { type: DataTypes.CHAR(36), allowNull: false },
    supplier_identification_type: { type: DataTypes.STRING(12), allowNull: false },
    supplier_identification: { type: DataTypes.STRING(20), allowNull: false },
    supplier_name: { type: DataTypes.STRING(300), allowNull: false },
    warehouse_id: { type: DataTypes.CHAR(36), allowNull: false },
    establishment_id: { type: DataTypes.CHAR(36), allowNull: true },
    currency_code: { type: DataTypes.CHAR(3), allowNull: false },
    order_date: { type: DataTypes.DATEONLY, allowNull: false },
    expected_date: { type: DataTypes.DATEONLY, allowNull: true },
    payment_term_days: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
    notes: { type: DataTypes.TEXT, allowNull: true },
    subtotal_cents: { type: DataTypes.BIGINT, allowNull: false },
    tax_cents: { type: DataTypes.BIGINT, allowNull: false },
    total_cents: { type: DataTypes.BIGINT, allowNull: false },
    created_by: { type: DataTypes.CHAR(36), allowNull: false },
    submitted_at: { type: DataTypes.DATE, allowNull: true },
    approved_by: { type: DataTypes.CHAR(36), allowNull: true },
    approved_at: { type: DataTypes.DATE, allowNull: true },
    rejection_reason: { type: DataTypes.STRING(300), allowNull: true },
    cancel_reason: { type: DataTypes.STRING(300), allowNull: true },
    cancelled_by: { type: DataTypes.CHAR(36), allowNull: true },
    cancelled_at: { type: DataTypes.DATE, allowNull: true },
    version: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 1 },
    created_at: { type: DataTypes.DATE, allowNull: false },
    updated_at: { type: DataTypes.DATE, allowNull: false },
  },
  { sequelize, tableName: 'purchase_orders', timestamps: false },
);

export class OrderLineModel extends Model<InferAttributes<OrderLineModel>, InferCreationAttributes<OrderLineModel>> {
  declare id: string;
  declare order_id: string;
  declare organization_id: string;
  declare line_number: number;
  declare product_id: string;
  declare sku: string | null;
  declare description: string;
  declare quantity_micros: string | number;
  declare unit_cost_cents: string | number;
  declare discount_cents: string | number;
  declare tax_rate_id: string | null;
  declare tax_percent: string | number;
  declare subtotal_cents: string | number;
  declare tax_cents: string | number;
  declare total_cents: string | number;
  declare received_micros: string | number;
}

OrderLineModel.init(
  {
    id: { type: DataTypes.CHAR(36), primaryKey: true },
    order_id: { type: DataTypes.CHAR(36), allowNull: false },
    organization_id: { type: DataTypes.CHAR(36), allowNull: false },
    line_number: { type: DataTypes.INTEGER, allowNull: false },
    product_id: { type: DataTypes.CHAR(36), allowNull: false },
    sku: { type: DataTypes.STRING(60), allowNull: true },
    description: { type: DataTypes.STRING(300), allowNull: false },
    quantity_micros: { type: DataTypes.BIGINT, allowNull: false },
    unit_cost_cents: { type: DataTypes.BIGINT, allowNull: false },
    discount_cents: { type: DataTypes.BIGINT, allowNull: false, defaultValue: 0 },
    tax_rate_id: { type: DataTypes.CHAR(36), allowNull: true },
    tax_percent: { type: DataTypes.DECIMAL(5, 2), allowNull: false, defaultValue: 0 },
    subtotal_cents: { type: DataTypes.BIGINT, allowNull: false },
    tax_cents: { type: DataTypes.BIGINT, allowNull: false },
    total_cents: { type: DataTypes.BIGINT, allowNull: false },
    received_micros: { type: DataTypes.BIGINT, allowNull: false, defaultValue: 0 },
  },
  { sequelize, tableName: 'purchase_order_lines', timestamps: false },
);

export class SettingsModel extends Model<InferAttributes<SettingsModel>, InferCreationAttributes<SettingsModel>> {
  declare organization_id: string;
  declare approval_threshold_cents: string | number | null;
  declare default_warehouse_id: string | null;
  declare over_receipt_tolerance_bp: number;
  declare price_tolerance_bp: number;
  declare qty_tolerance_bp: number;
  declare updated_at: Date;
}

SettingsModel.init(
  {
    organization_id: { type: DataTypes.CHAR(36), primaryKey: true },
    approval_threshold_cents: { type: DataTypes.BIGINT, allowNull: true },
    default_warehouse_id: { type: DataTypes.CHAR(36), allowNull: true },
    over_receipt_tolerance_bp: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
    price_tolerance_bp: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
    qty_tolerance_bp: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
    updated_at: { type: DataTypes.DATE, allowNull: false },
  },
  { sequelize, tableName: 'purchasing_settings', timestamps: false },
);

export class GoodsReceiptModel extends Model<InferAttributes<GoodsReceiptModel>, InferCreationAttributes<GoodsReceiptModel>> {
  declare id: string;
  declare organization_id: string;
  declare number: string;
  declare purchase_order_id: string;
  declare supplier_id: string;
  declare warehouse_id: string;
  declare receipt_date: string;
  declare supplier_delivery_ref: string | null;
  declare notes: string | null;
  declare created_by: string;
  declare created_at: Date;
}

GoodsReceiptModel.init(
  {
    id: { type: DataTypes.CHAR(36), primaryKey: true },
    organization_id: { type: DataTypes.CHAR(36), allowNull: false },
    number: { type: DataTypes.STRING(20), allowNull: false },
    purchase_order_id: { type: DataTypes.CHAR(36), allowNull: false },
    supplier_id: { type: DataTypes.CHAR(36), allowNull: false },
    warehouse_id: { type: DataTypes.CHAR(36), allowNull: false },
    receipt_date: { type: DataTypes.DATEONLY, allowNull: false },
    supplier_delivery_ref: { type: DataTypes.STRING(60), allowNull: true },
    notes: { type: DataTypes.TEXT, allowNull: true },
    created_by: { type: DataTypes.CHAR(36), allowNull: false },
    created_at: { type: DataTypes.DATE, allowNull: false },
  },
  { sequelize, tableName: 'goods_receipts', timestamps: false },
);

export class GoodsReceiptLineModel extends Model<InferAttributes<GoodsReceiptLineModel>, InferCreationAttributes<GoodsReceiptLineModel>> {
  declare id: string;
  declare receipt_id: string;
  declare order_line_id: string;
  declare product_id: string;
  declare quantity_micros: string | number;
  declare unit_cost_cents: string | number;
  declare currency_code: string;
}

GoodsReceiptLineModel.init(
  {
    id: { type: DataTypes.CHAR(36), primaryKey: true },
    receipt_id: { type: DataTypes.CHAR(36), allowNull: false },
    order_line_id: { type: DataTypes.CHAR(36), allowNull: false },
    product_id: { type: DataTypes.CHAR(36), allowNull: false },
    quantity_micros: { type: DataTypes.BIGINT, allowNull: false },
    unit_cost_cents: { type: DataTypes.BIGINT, allowNull: false },
    currency_code: { type: DataTypes.CHAR(3), allowNull: false },
  },
  { sequelize, tableName: 'goods_receipt_lines', timestamps: false },
);

export class PurchaseBillModel extends Model<InferAttributes<PurchaseBillModel>, InferCreationAttributes<PurchaseBillModel>> {
  declare id: string;
  declare organization_id: string;
  declare internal_number: string | null;
  declare supplier_id: string;
  declare supplier_identification_type: string;
  declare supplier_identification: string;
  declare supplier_name: string;
  declare purchase_order_id: string | null;
  declare doc_type: string;
  declare establishment: string;
  declare emission_point: string;
  declare sequential: string;
  declare authorization_number: string | null;
  declare issue_date: string;
  declare due_date: string;
  declare currency_code: string;
  declare subtotal_cents: string | number;
  declare tax_cents: string | number;
  declare total_cents: string | number;
  declare supplier_total_cents: string | number;
  declare status: string;
  declare match_status: string;
  declare match_reasons: unknown;
  declare override_reason: string | null;
  declare override_by: string | null;
  declare withholding_status: string;
  declare void_reason: string | null;
  declare created_by: string;
  declare version: number;
  declare created_at: Date;
  declare updated_at: Date;
}

PurchaseBillModel.init(
  {
    id: { type: DataTypes.CHAR(36), primaryKey: true },
    organization_id: { type: DataTypes.CHAR(36), allowNull: false },
    internal_number: { type: DataTypes.STRING(20), allowNull: true },
    supplier_id: { type: DataTypes.CHAR(36), allowNull: false },
    supplier_identification_type: { type: DataTypes.STRING(12), allowNull: false },
    supplier_identification: { type: DataTypes.STRING(20), allowNull: false },
    supplier_name: { type: DataTypes.STRING(300), allowNull: false },
    purchase_order_id: { type: DataTypes.CHAR(36), allowNull: true },
    doc_type: { type: DataTypes.STRING(2), allowNull: false },
    establishment: { type: DataTypes.STRING(3), allowNull: false },
    emission_point: { type: DataTypes.STRING(3), allowNull: false },
    sequential: { type: DataTypes.STRING(9), allowNull: false },
    authorization_number: { type: DataTypes.STRING(49), allowNull: true },
    issue_date: { type: DataTypes.DATEONLY, allowNull: false },
    due_date: { type: DataTypes.DATEONLY, allowNull: false },
    currency_code: { type: DataTypes.CHAR(3), allowNull: false },
    subtotal_cents: { type: DataTypes.BIGINT, allowNull: false },
    tax_cents: { type: DataTypes.BIGINT, allowNull: false },
    total_cents: { type: DataTypes.BIGINT, allowNull: false },
    supplier_total_cents: { type: DataTypes.BIGINT, allowNull: false },
    status: { type: DataTypes.STRING(20), allowNull: false },
    match_status: { type: DataTypes.STRING(20), allowNull: false },
    match_reasons: { type: DataTypes.JSON, allowNull: false, defaultValue: [] },
    override_reason: { type: DataTypes.STRING(300), allowNull: true },
    override_by: { type: DataTypes.CHAR(36), allowNull: true },
    withholding_status: { type: DataTypes.STRING(20), allowNull: false, defaultValue: 'none' },
    void_reason: { type: DataTypes.STRING(300), allowNull: true },
    created_by: { type: DataTypes.CHAR(36), allowNull: false },
    version: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 1 },
    created_at: { type: DataTypes.DATE, allowNull: false },
    updated_at: { type: DataTypes.DATE, allowNull: false },
  },
  { sequelize, tableName: 'purchase_bills', timestamps: false },
);

export class PurchaseBillLineModel extends Model<InferAttributes<PurchaseBillLineModel>, InferCreationAttributes<PurchaseBillLineModel>> {
  declare id: string;
  declare bill_id: string;
  declare organization_id: string;
  declare line_number: number;
  declare order_line_id: string | null;
  declare product_id: string | null;
  declare description: string;
  declare quantity_micros: string | number;
  declare unit_cost_cents: string | number;
  declare discount_cents: string | number;
  declare subtotal_cents: string | number;
  declare tax_code: string | null;
  declare tax_percentage_code: string | null;
  declare tax_rate_pct: string | number;
  declare tax_cents: string | number;
  declare ice_cents: string | number;
  declare irbpnr_cents: string | number;
  declare total_cents: string | number;
  declare expense_account_hint: string | null;
  declare price_variance_cents: string | number;
}

PurchaseBillLineModel.init(
  {
    id: { type: DataTypes.CHAR(36), primaryKey: true },
    bill_id: { type: DataTypes.CHAR(36), allowNull: false },
    organization_id: { type: DataTypes.CHAR(36), allowNull: false },
    line_number: { type: DataTypes.INTEGER, allowNull: false },
    order_line_id: { type: DataTypes.CHAR(36), allowNull: true },
    product_id: { type: DataTypes.CHAR(36), allowNull: true },
    description: { type: DataTypes.STRING(300), allowNull: false },
    quantity_micros: { type: DataTypes.BIGINT, allowNull: false },
    unit_cost_cents: { type: DataTypes.BIGINT, allowNull: false },
    discount_cents: { type: DataTypes.BIGINT, allowNull: false, defaultValue: 0 },
    subtotal_cents: { type: DataTypes.BIGINT, allowNull: false },
    tax_code: { type: DataTypes.STRING(12), allowNull: true },
    tax_percentage_code: { type: DataTypes.STRING(12), allowNull: true },
    tax_rate_pct: { type: DataTypes.DECIMAL(5, 2), allowNull: false, defaultValue: 0 },
    tax_cents: { type: DataTypes.BIGINT, allowNull: false, defaultValue: 0 },
    ice_cents: { type: DataTypes.BIGINT, allowNull: false, defaultValue: 0 },
    irbpnr_cents: { type: DataTypes.BIGINT, allowNull: false, defaultValue: 0 },
    total_cents: { type: DataTypes.BIGINT, allowNull: false },
    expense_account_hint: { type: DataTypes.STRING(60), allowNull: true },
    price_variance_cents: { type: DataTypes.BIGINT, allowNull: false, defaultValue: 0 },
  },
  { sequelize, tableName: 'purchase_bill_lines', timestamps: false },
);

export class OutboxModel extends Model<InferAttributes<OutboxModel>, InferCreationAttributes<OutboxModel>> {
  declare id: string;
  declare aggregate_type: string;
  declare aggregate_id: string;
  declare type: string;
  declare payload: unknown;
  declare occurred_at: Date;
  declare processed_at: Date | null;
}

OutboxModel.init(
  {
    id: { type: DataTypes.CHAR(36), primaryKey: true },
    aggregate_type: { type: DataTypes.STRING(50), allowNull: false },
    aggregate_id: { type: DataTypes.CHAR(36), allowNull: false },
    type: { type: DataTypes.STRING(100), allowNull: false },
    payload: { type: DataTypes.JSON, allowNull: false },
    occurred_at: { type: DataTypes.DATE, allowNull: false },
    processed_at: { type: DataTypes.DATE, allowNull: true },
  },
  { sequelize, tableName: 'outbox_messages', timestamps: false },
);
