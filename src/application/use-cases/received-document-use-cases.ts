import { randomUUID } from 'node:crypto';
import { ReceivedDocumentNotFoundError, ReceivedDocumentXmlMismatchError, SriUnavailableError, ValidationError } from '../../domain/errors.js';
import {
  applyFetchResult,
  newReceivedDocument,
  xmlMatchesAccessKey,
  type ReceivedDocumentStatus,
  type ReceivedSriDocument,
  type SriFetchResult,
} from '../../domain/received-document.js';
import type { Page, ReceivedDocumentFilters, UnitOfWork } from '../../domain/repositories.js';
import { parseSriReport, type RejectedReportRow } from '../../domain/sri-report.js';
import { sriDocumentDownloadedEvent, sriDocumentsImportedEvent, sriDocumentUnavailableEvent } from '../events.js';
import type { Clock, SriAuthorizationPort, UnitOfWorkGateway } from '../ports.js';
import { inTransaction } from './supplier-use-cases.js';

/** Un reporte mensual trae decenas o cientos de filas; este tope evita que un archivo equivocado (o malicioso) arme una transacción gigante. */
export const MAX_REPORT_ROWS = 5000;
/** Un XML autorizado pesa unos 10-40 KB; 2 MB es holgado y corta lo que claramente no es un comprobante. */
export const MAX_XML_BYTES = 2_000_000;

export interface ImportReportResult {
  batchId: string;
  /** Filas válidas del archivo. */
  total: number;
  created: number;
  /** Claves que ya estaban (en la base o repetidas dentro del archivo): no se vuelven a registrar ni a bajar. */
  duplicates: number;
  rejected: RejectedReportRow[];
  /** De las nuevas, las que son más viejas que lo que contesta el web service del SRI. */
  needsPortal: number;
}

/**
 * Registra las claves de un reporte «Descargar reporte» del portal del SRI. No baja nada: deja cada comprobante nuevo en `pending`
 * (o `needs_portal` si es muy viejo) y el trabajo programado trae los XML. Reimportar el mismo reporte no duplica nada: eso es lo que
 * permite correr la sincronización cada día sin volver a bajar lo ya bajado.
 */
export class ImportSriReportUseCase {
  constructor(private readonly gateway: UnitOfWorkGateway, private readonly clock: Clock) {}

  async execute(params: { organizationId: string; userId: string; text: string }): Promise<ImportReportResult> {
    const { rows, rejected } = parseSriReport(params.text);
    if (rows.length + rejected.length > MAX_REPORT_ROWS) {
      throw new ValidationError([{ field: 'report', message: `El reporte tiene más de ${MAX_REPORT_ROWS} filas; divídelo por mes.` }]);
    }

    // Una clave repetida dentro del archivo cuenta una vez: la primera.
    const unique = new Map(rows.map((r) => [r.access.accessKey, r] as const));
    const now = this.clock();
    const batchId = randomUUID();

    return inTransaction(this.gateway, async (uow) => {
      const existing = await uow.receivedDocuments.findExistingKeys(params.organizationId, [...unique.keys()]);
      const fresh = [...unique.values()].filter((r) => !existing.has(r.access.accessKey));
      const documents = fresh.map((r) => newReceivedDocument(params.organizationId, r, params.userId, now));
      if (documents.length) await uow.receivedDocuments.insertMany(documents);

      const result: ImportReportResult = {
        batchId,
        total: rows.length,
        created: documents.length,
        duplicates: rows.length - documents.length,
        rejected,
        needsPortal: documents.filter((d) => d.status === 'needs_portal').length,
      };
      await uow.outbox.add(
        sriDocumentsImportedEvent({
          organizationId: params.organizationId,
          batchId,
          source: 'portal_report',
          total: result.total,
          created: result.created,
          duplicates: result.duplicates,
          rejected: rejected.length,
          needsPortal: result.needsPortal,
          createdBy: params.userId,
        }),
      );
      return result;
    });
  }
}

export interface FetchSummary {
  attempted: number;
  downloaded: number;
  notAuthorized: number;
  needsPortal: number;
  failed: number;
  /** Siguen pendientes: el SRI aún no los tiene o no contestó; se reintentan con espera creciente. */
  retrying: number;
}

/**
 * Trae del SRI el XML de los comprobantes pendientes. Es lo que corre el trabajo programado. La llamada al SRI va FUERA de la
 * transacción (puede tardar decenas de segundos y no se debe retener un bloqueo mientras tanto); el resultado se aplica después,
 * releyendo el documento con bloqueo, por si una carga manual o una corrida anterior ya lo resolvió.
 */
export class FetchReceivedDocumentsUseCase {
  constructor(
    private readonly gateway: UnitOfWorkGateway,
    private readonly reads: UnitOfWork,
    private readonly sri: SriAuthorizationPort,
    private readonly clock: Clock,
  ) {}

  async execute(params: { limit?: number } = {}): Promise<FetchSummary> {
    const due = await this.reads.receivedDocuments.listDue(this.clock(), params.limit ?? 50);
    const summary: FetchSummary = { attempted: 0, downloaded: 0, notAuthorized: 0, needsPortal: 0, failed: 0, retrying: 0 };

    for (const doc of due) {
      let result: SriFetchResult | null = null;
      let error: string | null = null;
      try {
        result = await this.sri.fetchByAccessKey(doc.accessKey);
      } catch (err) {
        // Solo la indisponibilidad del SRI se reintenta; un error de programación no se disfraza de «reintentar».
        if (err instanceof SriUnavailableError) error = err.message;
        else throw err;
      }

      const next = await inTransaction(this.gateway, async (uow) => {
        const current = await uow.receivedDocuments.findById(doc.organizationId, doc.id, { lock: true });
        if (!current || current.status !== 'pending') return null;
        const updated = applyFetchResult(current, result, error, this.clock());
        await uow.receivedDocuments.save(updated);
        if (updated.status === 'downloaded') await uow.outbox.add(sriDocumentDownloadedEvent(updated, 'web_service'));
        else if (updated.status !== 'pending') await uow.outbox.add(sriDocumentUnavailableEvent(updated));
        return updated;
      });
      if (!next) continue;

      summary.attempted++;
      if (next.status === 'downloaded') summary.downloaded++;
      else if (next.status === 'not_authorized') summary.notAuthorized++;
      else if (next.status === 'needs_portal') summary.needsPortal++;
      else if (next.status === 'failed') summary.failed++;
      else summary.retrying++;
    }
    return summary;
  }
}

/**
 * Guarda a mano el XML de un comprobante: la vía para lo que el web service ya no contesta (más de ~6 meses) y para lo que el
 * recolector baje del portal. Exige que el XML cite la clave de acceso del documento: un XML de otro comprobante no se acepta.
 * Si el XML ya estaba guardado no se pisa: es el comprobante legal.
 */
export class AttachReceivedXmlUseCase {
  constructor(private readonly gateway: UnitOfWorkGateway, private readonly clock: Clock) {}

  async execute(params: { organizationId: string; documentId: string; xml: string }): Promise<ReceivedSriDocument> {
    const xml = params.xml.trim();
    if (xml.length === 0 || Buffer.byteLength(xml, 'utf8') > MAX_XML_BYTES) {
      throw new ValidationError([{ field: 'xml', message: 'El XML está vacío o es demasiado grande.' }]);
    }
    return inTransaction(this.gateway, async (uow) => {
      const doc = await uow.receivedDocuments.findById(params.organizationId, params.documentId, { lock: true });
      if (!doc) throw new ReceivedDocumentNotFoundError();
      if (doc.status === 'downloaded') return doc;
      if (!xmlMatchesAccessKey(xml, doc.accessKey)) throw new ReceivedDocumentXmlMismatchError();
      // Un sobre de autorización que dice otra cosa que AUTORIZADO no es el comprobante legal.
      const estado = xml.match(/<estado>([^<]*)<\/estado>/)?.[1]?.trim();
      if (estado && estado !== 'AUTORIZADO') throw new ReceivedDocumentXmlMismatchError(`El XML está en estado «${estado}», no autorizado.`);

      const now = this.clock();
      const next: ReceivedSriDocument = {
        ...doc,
        status: 'downloaded',
        source: 'manual',
        xml,
        downloadedAt: now,
        lastError: null,
        nextAttemptAt: null,
        updatedAt: now,
      };
      await uow.receivedDocuments.save(next);
      await uow.outbox.add(sriDocumentDownloadedEvent(next, 'manual'));
      return next;
    });
  }
}

export class ListReceivedDocumentsUseCase {
  constructor(private readonly repos: UnitOfWork) {}

  execute(params: { organizationId: string; filters: ReceivedDocumentFilters }): Promise<Page<ReceivedSriDocument>> {
    return this.repos.receivedDocuments.list(params.organizationId, params.filters);
  }
}

export class GetReceivedDocumentUseCase {
  constructor(private readonly repos: UnitOfWork) {}

  async execute(params: { organizationId: string; documentId: string }): Promise<ReceivedSriDocument> {
    const doc = await this.repos.receivedDocuments.findById(params.organizationId, params.documentId);
    if (!doc) throw new ReceivedDocumentNotFoundError();
    return doc;
  }
}

export interface ReceivedDocumentsStatus {
  counts: Record<ReceivedDocumentStatus, number>;
  /** Fecha de emisión más reciente que ya se tiene (`AAAA-MM-DD`), o `null` si todavía no hay nada: desde dónde seguir. */
  latestIssueDate: string | null;
}

/** El resumen que contesta «¿estoy al día?»: cuántos hay por estado y hasta qué fecha se tiene. */
export class GetReceivedDocumentsStatusUseCase {
  constructor(private readonly repos: UnitOfWork) {}

  async execute(params: { organizationId: string }): Promise<ReceivedDocumentsStatus> {
    const [counts, latestIssueDate] = await Promise.all([
      this.repos.receivedDocuments.countByStatus(params.organizationId),
      this.repos.receivedDocuments.latestIssueDate(params.organizationId),
    ]);
    return { counts, latestIssueDate };
  }
}
