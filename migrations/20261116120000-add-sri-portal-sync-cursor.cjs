'use strict';

module.exports = {
  async up(queryInterface, Sequelize) {
    // Cursor de la sincronización con el portal: periodo `YYYY-MM` que toca bajar en la
    // próxima corrida. NULL = empezar por el mes actual (recorrido completo de la ventana).
    await queryInterface.addColumn('purchasing_sri_portal_config', 'sync_cursor_period', {
      type: Sequelize.STRING(7),
      allowNull: true,
    });
  },

  async down(queryInterface) {
    await queryInterface.removeColumn('purchasing_sri_portal_config', 'sync_cursor_period');
  },
};
