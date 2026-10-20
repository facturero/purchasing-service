'use strict';

/**
 * Compras: se borra la columna muerta `purchase_order_lines.billed_micros`.
 *
 * Se añadió en `20261018140000-add-purchase-bills.cjs` "para D.3", pero ninguna
 * consulta la lee: lo facturado se calcula sumando las líneas de facturas
 * `posted`/`blocked` (`billedByOrderLine`), que es idempotente ante reintentos.
 * Un contador denormalizado sería una segunda verdad que hay que mantener a
 * mano en cada contabilización y anulación; se borra antes de que alguien lo
 * confunda con la fuente de verdad (hueco §5.3 del encargo de la Fase 3).
 */
/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface) {
    // El CHECK depende de la columna: primero el check, luego la columna.
    await queryInterface.sequelize.query(
      'ALTER TABLE purchase_order_lines DROP CHECK purchase_order_lines_billed_chk',
    );
    await queryInterface.removeColumn('purchase_order_lines', 'billed_micros');
  },

  async down(queryInterface, Sequelize) {
    await queryInterface.addColumn('purchase_order_lines', 'billed_micros', {
      type: Sequelize.BIGINT,
      allowNull: false,
      defaultValue: 0,
    });
    await queryInterface.sequelize.query(
      'ALTER TABLE purchase_order_lines ADD CONSTRAINT purchase_order_lines_billed_chk CHECK (billed_micros >= 0 AND billed_micros <= quantity_micros)',
    );
  },
};
