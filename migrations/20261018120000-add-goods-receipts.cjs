'use strict';

/**
 * Compras, Fase 2.2a: recepción de mercadería (goods_receipts).
 *
 * Decisiones C.2:
 *  - Una recepción es inmutable (no se edita ni borra).
 *  - Solo contra orden `approved` o `partially_received`.
 *  - Estado de la orden: `approved` → `partially_received` → `received`.
 *  - Tolerancia de sobre-recepción por organización (puntos básicos).
 *  - Costo de la entrada = costo unitario de la línea de la orden (centavos).
 *  - Numeración RM-AAAA-NNNNNN con contador por (organización, año).
 *  - Evento `purchase.purchase_order.received` + `purchasing.receipt.posted`.
 *  - Todo en la misma transacción (recepción + contador + estado orden + outbox).
 */
/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface, Sequelize) {
    // goods_receipts: cabecera de la recepción
    await queryInterface.createTable('goods_receipts', {
      id: { type: Sequelize.CHAR(36), primaryKey: true },
      organization_id: { type: Sequelize.CHAR(36), allowNull: false },
      number: { type: Sequelize.STRING(20), allowNull: false },
      purchase_order_id: { type: Sequelize.CHAR(36), allowNull: false },
      supplier_id: { type: Sequelize.CHAR(36), allowNull: false },
      warehouse_id: { type: Sequelize.CHAR(36), allowNull: false },
      receipt_date: { type: Sequelize.DATEONLY, allowNull: false },
      supplier_delivery_ref: { type: Sequelize.STRING(60), allowNull: true },
      notes: { type: Sequelize.TEXT, allowNull: true },
      created_by: { type: Sequelize.CHAR(36), allowNull: false },
      created_at: { type: Sequelize.DATE, allowNull: false },
    });
    await queryInterface.addIndex('goods_receipts', ['organization_id', 'number'], { unique: true, name: 'goods_receipts_org_number_uq' });
    await queryInterface.addIndex('goods_receipts', ['organization_id', 'purchase_order_id'], { name: 'goods_receipts_org_order' });
    await queryInterface.addIndex('goods_receipts', ['organization_id', 'receipt_date'], { name: 'goods_receipts_org_date' });

    // goods_receipt_lines: líneas de la recepción
    await queryInterface.createTable('goods_receipt_lines', {
      id: { type: Sequelize.CHAR(36), primaryKey: true },
      receipt_id: { type: Sequelize.CHAR(36), allowNull: false, references: { model: 'goods_receipts', key: 'id' }, onDelete: 'CASCADE' },
      order_line_id: { type: Sequelize.CHAR(36), allowNull: false },
      product_id: { type: Sequelize.CHAR(36), allowNull: false },
      quantity_micros: { type: Sequelize.BIGINT, allowNull: false },
      unit_cost_cents: { type: Sequelize.BIGINT, allowNull: false },
      currency_code: { type: Sequelize.CHAR(3), allowNull: false },
    });
    await queryInterface.addIndex('goods_receipt_lines', ['receipt_id', 'order_line_id'], { unique: true, name: 'goods_receipt_lines_receipt_line_uq' });
    await queryInterface.sequelize.query(
      'ALTER TABLE goods_receipt_lines ADD CONSTRAINT goods_receipt_lines_qty_chk CHECK (quantity_micros > 0 AND unit_cost_cents >= 0)',
    );

    // Contador para numeración RM-AAAA-NNNNNN (organización, año)
    await queryInterface.createTable('receipt_sequences', {
      organization_id: { type: Sequelize.CHAR(36), allowNull: false, primaryKey: true },
      year: { type: Sequelize.INTEGER, allowNull: false, primaryKey: true },
      current_value: { type: Sequelize.INTEGER, allowNull: false, defaultValue: 0 },
    });

    // Ampliar purchasing_settings con tolerancia de sobre-recepción (C.2.4)
    await queryInterface.addColumn('purchasing_settings', 'over_receipt_tolerance_bp', {
      type: Sequelize.INTEGER,
      allowNull: false,
      defaultValue: 0,
    });

    // Ampliar estados permitidos en purchase_orders (ya existían en el modelo: partially_received, received, closed)
    // MySQL usa ENUM en la tabla; Sequelize define el ENUM en el modelo.
    // La migración solo añade la columna si no existe, o actualiza el CHECK.
    // Como ya había una columna status STRING(20), los valores nuevos ya son válidos si el modelo los permite.
    // Añadimos un CHECK para documentar los estados válidos (no rompe datos existentes).
    await queryInterface.sequelize.query(`
      ALTER TABLE purchase_orders
      ADD CONSTRAINT purchase_orders_status_chk
      CHECK (status IN ('draft','pending_approval','approved','partially_received','received','closed','cancelled','rejected'))
    `);
  },

  async down(queryInterface) {
    for (const table of [
      'goods_receipt_lines', 'goods_receipts', 'receipt_sequences',
    ]) {
      await queryInterface.dropTable(table);
    }
    await queryInterface.removeColumn('purchasing_settings', 'over_receipt_tolerance_bp');
    await queryInterface.sequelize.query('ALTER TABLE purchase_orders DROP CHECK purchase_orders_status_chk');
  },
};