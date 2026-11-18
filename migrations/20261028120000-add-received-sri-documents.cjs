'use strict';

/**
 * Compras: `received_sri_documents` — comprobantes que el SRI registra a nombre de la organización (facturas recibidas, notas de
 * crédito, retenciones…), con su XML autorizado.
 *
 * Llegan por la clave de acceso (reporte del portal, o carga manual) y el XML se trae aparte, así que la fila nace sin XML y con
 * `status = 'pending'`. UNIQUE (organization_id, access_key): es lo que impide bajar dos veces lo mismo aunque dos importaciones
 * corran a la vez. El XML se guarda en la propia fila (LONGTEXT, unos 10-40 KB): es el comprobante legal y no se reescribe.
 */
/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.createTable('received_sri_documents', {
      id: { type: Sequelize.CHAR(36), primaryKey: true },
      organization_id: { type: Sequelize.CHAR(36), allowNull: false },
      access_key: { type: Sequelize.CHAR(49), allowNull: false },
      document_type_code: { type: Sequelize.CHAR(2), allowNull: false },
      issuer_ruc: { type: Sequelize.STRING(13), allowNull: false },
      issuer_name: { type: Sequelize.STRING(300), allowNull: false, defaultValue: '' },
      document_number: { type: Sequelize.STRING(20), allowNull: false },
      issue_date: { type: Sequelize.DATEONLY, allowNull: false },
      authorized_at: { type: Sequelize.DATE, allowNull: true },
      subtotal_cents: { type: Sequelize.BIGINT, allowNull: false, defaultValue: 0 },
      tax_cents: { type: Sequelize.BIGINT, allowNull: false, defaultValue: 0 },
      total_cents: { type: Sequelize.BIGINT, allowNull: false, defaultValue: 0 },
      modified_document_number: { type: Sequelize.STRING(20), allowNull: true },
      status: { type: Sequelize.STRING(16), allowNull: false, defaultValue: 'pending' },
      source: { type: Sequelize.STRING(16), allowNull: false, defaultValue: 'portal_report' },
      xml: { type: 'LONGTEXT', allowNull: true },
      attempts: { type: Sequelize.INTEGER, allowNull: false, defaultValue: 0 },
      last_error: { type: Sequelize.STRING(500), allowNull: true },
      last_attempt_at: { type: Sequelize.DATE, allowNull: true },
      next_attempt_at: { type: Sequelize.DATE, allowNull: true },
      downloaded_at: { type: Sequelize.DATE, allowNull: true },
      created_by: { type: Sequelize.CHAR(36), allowNull: false },
      created_at: { type: Sequelize.DATE, allowNull: false },
      updated_at: { type: Sequelize.DATE, allowNull: false },
    });
    await queryInterface.addIndex('received_sri_documents', ['organization_id', 'access_key'], { unique: true, name: 'received_sri_documents_org_key_uq' });
    // El trabajo programado busca «pendientes con el próximo intento vencido»; sin este índice recorrería toda la tabla.
    await queryInterface.addIndex('received_sri_documents', ['status', 'next_attempt_at'], { name: 'received_sri_documents_due_idx' });
    await queryInterface.addIndex('received_sri_documents', ['organization_id', 'issue_date'], { name: 'received_sri_documents_org_date_idx' });
    await queryInterface.addIndex('received_sri_documents', ['organization_id', 'issuer_ruc'], { name: 'received_sri_documents_org_issuer_idx' });
    await queryInterface.sequelize.query(
      "ALTER TABLE received_sri_documents ADD CONSTRAINT received_sri_documents_status_chk CHECK (status IN ('pending', 'needs_portal', 'downloaded', 'not_authorized', 'failed'))",
    );
    // Un documento «bajado» sin XML sería una mentira que la pantalla repetiría.
    await queryInterface.sequelize.query(
      "ALTER TABLE received_sri_documents ADD CONSTRAINT received_sri_documents_xml_chk CHECK (status <> 'downloaded' OR xml IS NOT NULL)",
    );
  },

  async down(queryInterface) {
    await queryInterface.dropTable('received_sri_documents');
  },
};
