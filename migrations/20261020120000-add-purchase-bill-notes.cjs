'use strict';

/**
 * Compras, Fase 2.3: `notes` en la factura de compra.
 *
 * La entrada ya lo aceptaba (`BillInput.notes` y el validador) pero se descartaba en silencio: la factura
 * no tenía dónde guardarlo. Mismo tipo y nulabilidad que `purchase_orders.notes` (TEXT, admitiendo NULL),
 * que es el patrón de la orden. Va en migración aparte porque `purchase_bills` ya está aplicada.
 */
/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.addColumn('purchase_bills', 'notes', { type: Sequelize.TEXT, allowNull: true });
  },

  async down(queryInterface) {
    await queryInterface.removeColumn('purchase_bills', 'notes');
  },
};
