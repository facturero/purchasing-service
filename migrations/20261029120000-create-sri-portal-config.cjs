'use strict';

module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.createTable('purchasing_sri_portal_config', {
      organization_id: {
        type: Sequelize.CHAR(36),
        allowNull: false,
        primaryKey: true,
      },
      username: {
        type: Sequelize.STRING(20),
        allowNull: true,
      },
      password_enc: {
        type: Sequelize.TEXT,
        allowNull: true,
      },
      enabled: {
        type: Sequelize.BOOLEAN,
        allowNull: false,
        defaultValue: false,
      },
      last_run_at: {
        type: Sequelize.DATE,
        allowNull: true,
      },
      last_status: {
        type: Sequelize.STRING(32),
        allowNull: true,
      },
      last_error: {
        type: Sequelize.TEXT,
        allowNull: true,
      },
      updated_at: {
        type: Sequelize.DATE,
        allowNull: false,
        defaultValue: Sequelize.literal('CURRENT_TIMESTAMP'),
      },
      updated_by: {
        type: Sequelize.CHAR(36),
        allowNull: true,
      },
    });

    await queryInterface.addIndex('purchasing_sri_portal_config', ['enabled']);
  },

  async down(queryInterface) {
    await queryInterface.dropTable('purchasing_sri_portal_config');
  },
};
