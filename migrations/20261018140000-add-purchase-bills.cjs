'use strict';

/**
 * Compras, Fase 2.2b: factura de compra con conciliación a tres vías (purchase_bills).
 *
 * Decisiones D.2:
 *  - Documento del proveedor único por (org, supplier, tipo, estab, punto, secuencial) y por autorización.
 *  - Conciliación a tres vías por línea: cantidad facturada ≤ recibido + tolerancia; precio factura vs orden + tolerancia.
 *  - Estados: draft → posted | blocked → posted (override) | voided.
 *  - Override por persona distinta al creador.
 *  - Totales del servidor; comparación con total del proveedor (tol. 1 céntimo).
 *  - Numeración FC-AAAA-NNNNNN con contador por (organización, año).
 *  - Moneda distinta a base → CURRENCY_MISMATCH (pendiente en accounting).
 */
/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface, Sequelize) {
    // purchase_bills: cabecera de la factura de compra
    await queryInterface.createTable('purchase_bills', {
      id: { type: Sequelize.CHAR(36), primaryKey: true },
      organization_id: { type: Sequelize.CHAR(36), allowNull: false },
      internal_number: { type: Sequelize.STRING(20), allowNull: true },
      supplier_id: { type: Sequelize.CHAR(36), allowNull: false },
      supplier_identification_type: { type: Sequelize.STRING(12), allowNull: false },
      supplier_identification: { type: Sequelize.STRING(20), allowNull: false },
      supplier_name: { type: Sequelize.STRING(300), allowNull: false },
      purchase_order_id: { type: Sequelize.CHAR(36), allowNull: true },
      doc_type: { type: Sequelize.STRING(2), allowNull: false },
      establishment: { type: Sequelize.STRING(3), allowNull: false },
      emission_point: { type: Sequelize.STRING(3), allowNull: false },
      sequential: { type: Sequelize.STRING(9), allowNull: false },
      authorization_number: { type: Sequelize.STRING(49), allowNull: true },
      issue_date: { type: Sequelize.DATEONLY, allowNull: false },
      due_date: { type: Sequelize.DATEONLY, allowNull: false },
      currency_code: { type: Sequelize.CHAR(3), allowNull: false },
      subtotal_cents: { type: Sequelize.BIGINT, allowNull: false },
      tax_cents: { type: Sequelize.BIGINT, allowNull: false },
      total_cents: { type: Sequelize.BIGINT, allowNull: false },
      supplier_total_cents: { type: Sequelize.BIGINT, allowNull: false },
      status: { type: Sequelize.STRING(20), allowNull: false },
      match_status: { type: Sequelize.STRING(20), allowNull: false },
      match_reasons: { type: Sequelize.JSON, allowNull: false, defaultValue: [] },
      override_reason: { type: Sequelize.STRING(300), allowNull: true },
      override_by: { type: Sequelize.CHAR(36), allowNull: true },
      withholding_status: { type: Sequelize.STRING(20), allowNull: false, defaultValue: 'none' },
      void_reason: { type: Sequelize.STRING(300), allowNull: true },
      created_by: { type: Sequelize.CHAR(36), allowNull: false },
      version: { type: Sequelize.INTEGER, allowNull: false, defaultValue: 1 },
      created_at: { type: Sequelize.DATE, allowNull: false },
      updated_at: { type: Sequelize.DATE, allowNull: false },
    });
    await queryInterface.addIndex('purchase_bills', ['organization_id', 'internal_number'], { unique: true, name: 'purchase_bills_org_internal_uq' });
    await queryInterface.addIndex('purchase_bills', ['organization_id', 'supplier_id', 'doc_type', 'establishment', 'emission_point', 'sequential'], { unique: true, name: 'purchase_bills_org_supplier_doc_uq' });
    await queryInterface.addIndex('purchase_bills', ['organization_id', 'authorization_number'], { unique: true, name: 'purchase_bills_org_auth_uq', where: { authorization_number: { [Sequelize.Op.ne]: null } } });
    await queryInterface.addIndex('purchase_bills', ['organization_id', 'purchase_order_id'], { name: 'purchase_bills_org_order' });
    await queryInterface.addIndex('purchase_bills', ['organization_id', 'issue_date'], { name: 'purchase_bills_org_date' });
    await queryInterface.sequelize.query(
      'ALTER TABLE purchase_bills ADD CONSTRAINT purchase_bills_amounts_chk CHECK (subtotal_cents >= 0 AND tax_cents >= 0 AND total_cents = subtotal_cents + tax_cents)',
    );

    // purchase_bill_lines: líneas de la factura
    await queryInterface.createTable('purchase_bill_lines', {
      id: { type: Sequelize.CHAR(36), primaryKey: true },
      bill_id: { type: Sequelize.CHAR(36), allowNull: false, references: { model: 'purchase_bills', key: 'id' }, onDelete: 'CASCADE' },
      organization_id: { type: Sequelize.CHAR(36), allowNull: false },
      line_number: { type: Sequelize.INTEGER, allowNull: false },
      order_line_id: { type: Sequelize.CHAR(36), allowNull: true },
      product_id: { type: Sequelize.CHAR(36), allowNull: true },
      description: { type: Sequelize.STRING(300), allowNull: false },
      quantity_micros: { type: Sequelize.BIGINT, allowNull: false },
      unit_cost_cents: { type: Sequelize.BIGINT, allowNull: false },
      discount_cents: { type: Sequelize.BIGINT, allowNull: false, defaultValue: 0 },
      subtotal_cents: { type: Sequelize.BIGINT, allowNull: false },
      tax_code: { type: Sequelize.STRING(12), allowNull: true },
      tax_percentage_code: { type: Sequelize.STRING(12), allowNull: true },
      tax_rate_pct: { type: Sequelize.DECIMAL(5, 2), allowNull: false, defaultValue: 0 },
      tax_cents: { type: Sequelize.BIGINT, allowNull: false, defaultValue: 0 },
      ice_cents: { type: Sequelize.BIGINT, allowNull: false, defaultValue: 0 },
      irbpnr_cents: { type: Sequelize.BIGINT, allowNull: false, defaultValue: 0 },
      total_cents: { type: Sequelize.BIGINT, allowNull: false },
      expense_account_hint: { type: Sequelize.STRING(60), allowNull: true },
      price_variance_cents: { type: Sequelize.BIGINT, allowNull: false, defaultValue: 0 },
    });
    await queryInterface.addIndex('purchase_bill_lines', ['bill_id', 'line_number'], { unique: true, name: 'purchase_bill_lines_bill_line_uq' });
    await queryInterface.sequelize.query(
      'ALTER TABLE purchase_bill_lines ADD CONSTRAINT purchase_bill_lines_chk CHECK (quantity_micros > 0 AND unit_cost_cents >= 0 AND discount_cents >= 0 AND total_cents = subtotal_cents + tax_cents + ice_cents + irbpnr_cents)',
    );

    // Contador para numeración FC-AAAA-NNNNNN (organización, año)
    await queryInterface.createTable('bill_sequences', {
      organization_id: { type: Sequelize.CHAR(36), allowNull: false, primaryKey: true },
      year: { type: Sequelize.INTEGER, allowNull: false, primaryKey: true },
      current_value: { type: Sequelize.INTEGER, allowNull: false, defaultValue: 0 },
    });

    // Ampliar purchasing_settings con tolerancias de conciliación (D.2.3)
    await queryInterface.addColumn('purchasing_settings', 'price_tolerance_bp', {
      type: Sequelize.INTEGER,
      allowNull: false,
      defaultValue: 0,
    });
    await queryInterface.addColumn('purchasing_settings', 'qty_tolerance_bp', {
      type: Sequelize.INTEGER,
      allowNull: false,
      defaultValue: 0,
    });

    // Ampliar purchase_order_lines con billed_micros (D.3)
    await queryInterface.addColumn('purchase_order_lines', 'billed_micros', {
      type: Sequelize.BIGINT,
      allowNull: false,
      defaultValue: 0,
    });
    await queryInterface.sequelize.query(
      'ALTER TABLE purchase_order_lines ADD CONSTRAINT purchase_order_lines_billed_chk CHECK (billed_micros >= 0 AND billed_micros <= quantity_micros)',
    );
  },

  async down(queryInterface) {
    for (const table of [
      'purchase_bill_lines', 'purchase_bills', 'bill_sequences',
    ]) {
      await queryInterface.dropTable(table);
    }
    await queryInterface.removeColumn('purchasing_settings', 'price_tolerance_bp');
    await queryInterface.removeColumn('purchasing_settings', 'qty_tolerance_bp');
    await queryInterface.removeColumn('purchase_order_lines', 'billed_micros');
    await queryInterface.sequelize.query('ALTER TABLE purchase_bills DROP CHECK purchase_bills_amounts_chk');
    await queryInterface.sequelize.query('ALTER TABLE purchase_order_lines DROP CHECK purchase_order_lines_billed_chk');
  },
};