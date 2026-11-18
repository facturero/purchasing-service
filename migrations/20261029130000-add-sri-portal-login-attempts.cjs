'use strict';

module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.addColumn('purchasing_sri_portal_config', 'login_fail_count', {
      type: Sequelize.INTEGER.UNSIGNED,
      allowNull: false,
      defaultValue: 0,
    });
    await queryInterface.addColumn('purchasing_sri_portal_config', 'login_blocked_until', {
      type: Sequelize.DATE,
      allowNull: true,
    });
    await queryInterface.addColumn('purchasing_sri_portal_config', 'last_login_test_at', {
      type: Sequelize.DATE,
      allowNull: true,
    });
    await queryInterface.addColumn('purchasing_sri_portal_config', 'last_login_test_ok', {
      type: Sequelize.TINYINT(1),
      allowNull: false,
      defaultValue: 0,
    });
    await queryInterface.addColumn('purchasing_sri_portal_config', 'blocked_by_sri', {
      type: Sequelize.TINYINT(1),
      allowNull: false,
      defaultValue: 0,
    });
    await queryInterface.addColumn('purchasing_sri_portal_config', 'blocked_reason', {
      type: Sequelize.STRING(255),
      allowNull: true,
    });
    await queryInterface.addIndex('purchasing_sri_portal_config', ['blocked_by_sri', 'enabled']);
  },

  async down(queryInterface) {
    await queryInterface.removeIndex('purchasing_sri_portal_config', ['blocked_by_sri', 'enabled']);
    await queryInterface.removeColumn('purchasing_sri_portal_config', 'blocked_reason');
    await queryInterface.removeColumn('purchasing_sri_portal_config', 'blocked_by_sri');
    await queryInterface.removeColumn('purchasing_sri_portal_config', 'last_login_test_ok');
    await queryInterface.removeColumn('purchasing_sri_portal_config', 'last_login_test_at');
    await queryInterface.removeColumn('purchasing_sri_portal_config', 'login_blocked_until');
    await queryInterface.removeColumn('purchasing_sri_portal_config', 'login_fail_count');
  },
};
