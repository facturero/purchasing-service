import { Op, type Transaction, type WhereOptions } from 'sequelize';
import { sequelize } from './sequelize.js';
import { ReceivedDocumentModel } from './models.js';
import {
  RECEIVED_STATUSES,
  type ReceivedDocumentSource,
  type ReceivedDocumentStatus,
  type ReceivedSriDocument,
} from '../../domain/received-document.js';
import type { Page, ReceivedDocumentFilters, ReceivedDocumentRepository } from '../../domain/repositories.js';

/** Escapa los comodines de LIKE: buscar «100%» no debe traer todo. */
const likeTerm = (q: string): string => `%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;

const toReceived = (m: ReceivedDocumentModel): ReceivedSriDocument => ({
  id: m.id,
  organizationId: m.organization_id,
  accessKey: m.access_key,
  documentTypeCode: m.document_type_code,
  issuerRuc: m.issuer_ruc,
  issuerName: m.issuer_name,
  documentNumber: m.document_number,
  issueDate: String(m.issue_date),
  authorizedAt: m.authorized_at,
  subtotalCents: Number(m.subtotal_cents),
  taxCents: Number(m.tax_cents),
  totalCents: Number(m.total_cents),
  modifiedDocumentNumber: m.modified_document_number,
  status: m.status as ReceivedDocumentStatus,
  source: m.source as ReceivedDocumentSource,
  // Los listados no cargan el XML (decenas de KB por fila): ahí es `null` aunque el estado sea `downloaded`.
  xml: m.xml ?? null,
  attempts: m.attempts,
  lastError: m.last_error,
  lastAttemptAt: m.last_attempt_at,
  nextAttemptAt: m.next_attempt_at,
  downloadedAt: m.downloaded_at,
  createdBy: m.created_by,
  createdAt: m.created_at,
  updatedAt: m.updated_at,
});

const receivedFields = (d: ReceivedSriDocument) => ({
  organization_id: d.organizationId,
  access_key: d.accessKey,
  document_type_code: d.documentTypeCode,
  issuer_ruc: d.issuerRuc,
  issuer_name: d.issuerName,
  document_number: d.documentNumber,
  issue_date: d.issueDate,
  authorized_at: d.authorizedAt,
  subtotal_cents: d.subtotalCents,
  tax_cents: d.taxCents,
  total_cents: d.totalCents,
  modified_document_number: d.modifiedDocumentNumber,
  status: d.status,
  source: d.source,
  xml: d.xml,
  attempts: d.attempts,
  last_error: d.lastError,
  last_attempt_at: d.lastAttemptAt,
  next_attempt_at: d.nextAttemptAt,
  downloaded_at: d.downloadedAt,
  created_by: d.createdBy,
  updated_at: d.updatedAt,
});

export function receivedDocumentRepository(tx?: Transaction): ReceivedDocumentRepository {
  return {
    async findById(organizationId, id, options) {
      const row = await ReceivedDocumentModel.findOne({
        where: { id, organization_id: organizationId },
        ...(options?.lock && tx ? { lock: tx.LOCK.UPDATE } : {}),
        transaction: tx,
      });
      return row ? toReceived(row) : null;
    },
    async findByAccessKey(organizationId, accessKey, options) {
      const row = await ReceivedDocumentModel.findOne({
        where: { organization_id: organizationId, access_key: accessKey },
        ...(options?.lock && tx ? { lock: tx.LOCK.UPDATE } : {}),
        transaction: tx,
      });
      return row ? toReceived(row) : null;
    },
    async findExistingKeys(organizationId, accessKeys) {
      const found = new Set<string>();
      // Por tandas: un reporte grande no debe armar un IN con miles de valores.
      for (let i = 0; i < accessKeys.length; i += 500) {
        const rows = await ReceivedDocumentModel.findAll({
          attributes: ['access_key'],
          where: { organization_id: organizationId, access_key: { [Op.in]: accessKeys.slice(i, i + 500) } },
          transaction: tx,
        });
        for (const r of rows) found.add(r.access_key);
      }
      return found;
    },
    async list(organizationId, filters: ReceivedDocumentFilters): Promise<Page<ReceivedSriDocument>> {
      const and: WhereOptions[] = [{ organization_id: organizationId }];
      if (filters.status) and.push({ status: filters.status });
      if (filters.issuerRuc) and.push({ issuer_ruc: filters.issuerRuc });
      if (filters.from) and.push({ issue_date: { [Op.gte]: filters.from } });
      if (filters.to) and.push({ issue_date: { [Op.lte]: filters.to } });
      if (filters.q?.trim()) {
        const term = likeTerm(filters.q.trim());
        and.push({
          [Op.or]: [
            { issuer_name: { [Op.like]: term } },
            { document_number: { [Op.like]: term } },
            { access_key: { [Op.like]: term } },
            { issuer_ruc: { [Op.like]: term } },
          ],
        });
      }
      const { rows, count } = await ReceivedDocumentModel.findAndCountAll({
        attributes: { exclude: ['xml'] },
        where: { [Op.and]: and },
        order: [['issue_date', 'DESC'], ['document_number', 'DESC']],
        limit: filters.pageSize,
        offset: (filters.page - 1) * filters.pageSize,
        transaction: tx,
      });
      return { items: rows.map(toReceived), total: count, page: filters.page, pageSize: filters.pageSize };
    },
    // A propósito SIN organization_id: lo usa el trabajo programado, que atiende a todas las organizaciones.
    async listDue(now, limit) {
      const rows = await ReceivedDocumentModel.findAll({
        attributes: { exclude: ['xml'] },
        where: { status: 'pending', next_attempt_at: { [Op.lte]: now } },
        order: [['next_attempt_at', 'ASC']],
        limit,
        transaction: tx,
      });
      return rows.map(toReceived);
    },
    async countByStatus(organizationId) {
      const rows = (await ReceivedDocumentModel.findAll({
        attributes: ['status', [sequelize.fn('COUNT', sequelize.col('id')), 'n']],
        where: { organization_id: organizationId },
        group: ['status'],
        raw: true,
        transaction: tx,
      })) as unknown as { status: ReceivedDocumentStatus; n: string | number }[];
      const counts = Object.fromEntries(RECEIVED_STATUSES.map((s) => [s, 0])) as Record<ReceivedDocumentStatus, number>;
      for (const r of rows) counts[r.status] = Number(r.n);
      return counts;
    },
    async latestIssueDate(organizationId) {
      const max = await ReceivedDocumentModel.max<string, ReceivedDocumentModel>('issue_date', {
        where: { organization_id: organizationId },
        transaction: tx,
      });
      return max ? String(max) : null;
    },
    async insertMany(documents) {
      if (!documents.length) return;
      // `ignoreDuplicates`: si otra importación registró la misma clave entre la lectura y este alta, esa fila se omite en vez de tumbar el lote.
      await ReceivedDocumentModel.bulkCreate(
        documents.map((d) => ({ id: d.id, created_at: d.createdAt, ...receivedFields(d) })),
        { ignoreDuplicates: true, transaction: tx },
      );
    },
    async save(d) {
      await ReceivedDocumentModel.update(receivedFields(d), { where: { id: d.id, organization_id: d.organizationId }, transaction: tx });
    },
  };
}
