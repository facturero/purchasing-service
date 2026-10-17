'use strict';

/**
 * Compras, Fase 2.1: proveedores, órdenes de compra y sus ajustes.
 *
 * Reglas de esquema que valen para todo el servicio:
 *  - importes en centavos BIGINT (nunca decimales); cantidades en millonésimas BIGINT (6 decimales sin redondeo oculto);
 *  - todo lleva organization_id y toda consulta lo filtra: una organización no ve lo de otra;
 *  - `version` en la orden: detecta dos ediciones a la vez sin bloquear al lector;
 *  - el número de la orden (OC-AAAA-NNNNNN) es único por organización y se asigna al enviarla, no al crear el borrador.
 *  - outbox_messages / processed_events: patrón Outbox, esquema de @facturero/outbox-relay 0.2.x.
 */
/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.createTable('suppliers', {
      id: { type: Sequelize.CHAR(36), primaryKey: true },
      organization_id: { type: Sequelize.CHAR(36), allowNull: false },
      identification_type: { type: Sequelize.STRING(12), allowNull: false },
      identification: { type: Sequelize.STRING(20), allowNull: false },
      legal_name: { type: Sequelize.STRING(300), allowNull: false },
      trade_name: { type: Sequelize.STRING(300), allowNull: true },
      email: { type: Sequelize.STRING(300), allowNull: true },
      phone: { type: Sequelize.STRING(40), allowNull: true },
      address: { type: Sequelize.STRING(500), allowNull: true },
      payment_term_days: { type: Sequelize.INTEGER, allowNull: false, defaultValue: 0 },
      related_party: { type: Sequelize.BOOLEAN, allowNull: false, defaultValue: false },
      notes: { type: Sequelize.TEXT, allowNull: true },
      status: { type: Sequelize.STRING(10), allowNull: false, defaultValue: 'active' },
      created_at: { type: Sequelize.DATE, allowNull: false },
      updated_at: { type: Sequelize.DATE, allowNull: false },
    });
    await queryInterface.addIndex('suppliers', ['organization_id', 'identification'], { unique: true, name: 'suppliers_org_identification_uq' });
    await queryInterface.addIndex('suppliers', ['organization_id', 'status', 'legal_name'], { name: 'suppliers_org_status_name' });

    await queryInterface.createTable('purchase_orders', {
      id: { type: Sequelize.CHAR(36), primaryKey: true },
      organization_id: { type: Sequelize.CHAR(36), allowNull: false },
      number: { type: Sequelize.STRING(20), allowNull: true },
      status: { type: Sequelize.STRING(20), allowNull: false },
      supplier_id: { type: Sequelize.CHAR(36), allowNull: false },
      supplier_identification_type: { type: Sequelize.STRING(12), allowNull: false },
      supplier_identification: { type: Sequelize.STRING(20), allowNull: false },
      supplier_name: { type: Sequelize.STRING(300), allowNull: false },
      warehouse_id: { type: Sequelize.CHAR(36), allowNull: false },
      establishment_id: { type: Sequelize.CHAR(36), allowNull: true },
      currency_code: { type: Sequelize.CHAR(3), allowNull: false },
      order_date: { type: Sequelize.DATEONLY, allowNull: false },
      expected_date: { type: Sequelize.DATEONLY, allowNull: true },
      payment_term_days: { type: Sequelize.INTEGER, allowNull: false, defaultValue: 0 },
      notes: { type: Sequelize.TEXT, allowNull: true },
      subtotal_cents: { type: Sequelize.BIGINT, allowNull: false },
      tax_cents: { type: Sequelize.BIGINT, allowNull: false },
      total_cents: { type: Sequelize.BIGINT, allowNull: false },
      created_by: { type: Sequelize.CHAR(36), allowNull: false },
      submitted_at: { type: Sequelize.DATE, allowNull: true },
      approved_by: { type: Sequelize.CHAR(36), allowNull: true },
      approved_at: { type: Sequelize.DATE, allowNull: true },
      rejection_reason: { type: Sequelize.STRING(300), allowNull: true },
      cancel_reason: { type: Sequelize.STRING(300), allowNull: true },
      cancelled_by: { type: Sequelize.CHAR(36), allowNull: true },
      cancelled_at: { type: Sequelize.DATE, allowNull: true },
      version: { type: Sequelize.INTEGER, allowNull: false, defaultValue: 1 },
      created_at: { type: Sequelize.DATE, allowNull: false },
      updated_at: { type: Sequelize.DATE, allowNull: false },
    });
    await queryInterface.addIndex('purchase_orders', ['organization_id', 'number'], { unique: true, name: 'purchase_orders_org_number_uq' });
    await queryInterface.addIndex('purchase_orders', ['organization_id', 'status', 'order_date'], { name: 'purchase_orders_org_status_date' });
    await queryInterface.addIndex('purchase_orders', ['organization_id', 'supplier_id'], { name: 'purchase_orders_org_supplier' });
    await queryInterface.sequelize.query(
      'ALTER TABLE purchase_orders ADD CONSTRAINT purchase_orders_amounts_chk CHECK (subtotal_cents >= 0 AND tax_cents >= 0 AND total_cents = subtotal_cents + tax_cents)',
    );

    await queryInterface.createTable('purchase_order_lines', {
      id: { type: Sequelize.CHAR(36), primaryKey: true },
      order_id: { type: Sequelize.CHAR(36), allowNull: false, references: { model: 'purchase_orders', key: 'id' }, onDelete: 'CASCADE' },
      organization_id: { type: Sequelize.CHAR(36), allowNull: false },
      line_number: { type: Sequelize.INTEGER, allowNull: false },
      product_id: { type: Sequelize.CHAR(36), allowNull: false },
      sku: { type: Sequelize.STRING(60), allowNull: true },
      description: { type: Sequelize.STRING(300), allowNull: false },
      quantity_micros: { type: Sequelize.BIGINT, allowNull: false },
      unit_cost_cents: { type: Sequelize.BIGINT, allowNull: false },
      discount_cents: { type: Sequelize.BIGINT, allowNull: false, defaultValue: 0 },
      tax_rate_id: { type: Sequelize.CHAR(36), allowNull: true },
      tax_percent: { type: Sequelize.DECIMAL(5, 2), allowNull: false, defaultValue: 0 },
      subtotal_cents: { type: Sequelize.BIGINT, allowNull: false },
      tax_cents: { type: Sequelize.BIGINT, allowNull: false },
      total_cents: { type: Sequelize.BIGINT, allowNull: false },
      received_micros: { type: Sequelize.BIGINT, allowNull: false, defaultValue: 0 },
    });
    await queryInterface.addIndex('purchase_order_lines', ['order_id', 'line_number'], { unique: true, name: 'purchase_order_lines_order_line_uq' });
    await queryInterface.sequelize.query(
      'ALTER TABLE purchase_order_lines ADD CONSTRAINT purchase_order_lines_chk CHECK (quantity_micros > 0 AND unit_cost_cents >= 0 AND discount_cents >= 0 AND received_micros >= 0 AND total_cents = subtotal_cents + tax_cents)',
    );

    // Contador de la serie de numeración (organización, año). El UPDATE va antes que el INSERT: ver repositories.ts.
    await queryInterface.createTable('order_sequences', {
      organization_id: { type: Sequelize.CHAR(36), allowNull: false, primaryKey: true },
      year: { type: Sequelize.INTEGER, allowNull: false, primaryKey: true },
      current_value: { type: Sequelize.INTEGER, allowNull: false, defaultValue: 0 },
    });

    await queryInterface.createTable('purchasing_settings', {
      organization_id: { type: Sequelize.CHAR(36), primaryKey: true },
      approval_threshold_cents: { type: Sequelize.BIGINT, allowNull: true },
      default_warehouse_id: { type: Sequelize.CHAR(36), allowNull: true },
      updated_at: { type: Sequelize.DATE, allowNull: false },
    });

    await queryInterface.createTable('outbox_messages', {
      id: { type: Sequelize.CHAR(36), primaryKey: true },
      aggregate_type: { type: Sequelize.STRING(50), allowNull: false },
      aggregate_id: { type: Sequelize.CHAR(36), allowNull: false },
      type: { type: Sequelize.STRING(100), allowNull: false },
      payload: { type: Sequelize.JSON, allowNull: false },
      occurred_at: { type: Sequelize.DATE, allowNull: false },
      processed_at: { type: Sequelize.DATE, allowNull: true },
    });
    await queryInterface.addIndex('outbox_messages', ['processed_at']);

    await queryInterface.createTable('processed_events', {
      id: { type: Sequelize.CHAR(36), primaryKey: true },
      event_type: { type: Sequelize.STRING(100), allowNull: false },
      routing_key: { type: Sequelize.STRING(200), allowNull: false },
      payload: { type: Sequelize.JSON, allowNull: false },
      status: { type: Sequelize.STRING(20), allowNull: false, defaultValue: 'processed' },
      last_error: { type: Sequelize.TEXT, allowNull: true },
      processed_at: { type: Sequelize.DATE, allowNull: false },
    });
  },

  async down(queryInterface) {
    for (const table of [
      'processed_events', 'outbox_messages', 'purchasing_settings', 'order_sequences', 'purchase_order_lines', 'purchase_orders', 'suppliers',
    ]) {
      await queryInterface.dropTable(table);
    }
  },
};
