'use strict';

/**
 * Compras: `purchase_bill_lines.kind` ('stock' | 'expense').
 *
 * El evento `purchasing.bill.posted` decidía el destino de cada línea con una sola regla —«tiene producto → inventario»— y por
 * eso la compra de un servicio o de un suministro que no lleva stock se asentaba como inventario: el balance mostraba mercadería
 * que no existe y el estado de resultados le faltaba el gasto. Ahora el servidor guarda el destino al registrar la línea, según
 * el catálogo de producto (`trackStock`), y contabilidad asienta a inventario SOLO las `stock`.
 *
 * Las filas que ya existían conservan el comportamiento anterior (con producto → `stock`): ninguna se reclasifica en silencio.
 */
/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.addColumn('purchase_bill_lines', 'kind', {
      type: Sequelize.STRING(10),
      allowNull: false,
      defaultValue: 'expense',
    });
    await queryInterface.sequelize.query("UPDATE purchase_bill_lines SET kind = 'stock' WHERE product_id IS NOT NULL");
    await queryInterface.sequelize.query("ALTER TABLE purchase_bill_lines ADD CONSTRAINT purchase_bill_lines_kind_chk CHECK (kind IN ('stock', 'expense'))");
  },

  async down(queryInterface) {
    await queryInterface.sequelize.query('ALTER TABLE purchase_bill_lines DROP CHECK purchase_bill_lines_kind_chk');
    await queryInterface.removeColumn('purchase_bill_lines', 'kind');
  },
};
