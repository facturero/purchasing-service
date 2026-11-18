import { randomUUID } from 'node:crypto';
import type { SriReportRow } from './sri-report.js';

/**
 * - `pending`: se conoce la clave y falta traer el XML (lo hace el trabajo programado).
 * - `needs_portal`: la clave es más vieja que lo que contesta el web service del SRI; el XML solo sale del portal (o de una carga manual).
 * - `downloaded`: el XML autorizado ya está guardado.
 * - `not_authorized`: el SRI dice que ese comprobante no está autorizado; no hay nada que bajar.
 * - `failed`: se agotaron los reintentos sin respuesta útil.
 */
export const RECEIVED_STATUSES = ['pending', 'needs_portal', 'downloaded', 'not_authorized', 'failed'] as const;
export type ReceivedDocumentStatus = (typeof RECEIVED_STATUSES)[number];

/** Cómo llegó la clave: el reporte del portal, o un XML subido a mano. */
export type ReceivedDocumentSource = 'portal_report' | 'manual';

export interface ReceivedSriDocument {
  id: string;
  organizationId: string;
  accessKey: string;
  documentTypeCode: string;
  issuerRuc: string;
  issuerName: string;
  documentNumber: string;
  /** `AAAA-MM-DD`. */
  issueDate: string;
  authorizedAt: Date | null;
  subtotalCents: number;
  taxCents: number;
  totalCents: number;
  modifiedDocumentNumber: string | null;
  status: ReceivedDocumentStatus;
  source: ReceivedDocumentSource;
  /** XML autorizado (el comprobante legal), sin tocar. `null` mientras no se haya traído. */
  xml: string | null;
  attempts: number;
  lastError: string | null;
  lastAttemptAt: Date | null;
  /** Cuándo vuelve a intentarse. `null` si ya no hay nada que intentar. */
  nextAttemptAt: Date | null;
  downloadedAt: Date | null;
  createdBy: string;
  createdAt: Date;
  updatedAt: Date;
}

/**
 * Días hacia atrás que alcanza el web service de autorización del SRI. Medido contra el servicio real el 2026-10-28: 180 días
 * responde y 190 contesta «fecha de emisión fuera del rango permitido». Se usa un margen para no pedir lo que seguro va a fallar;
 * si el SRI cambia el límite, la respuesta «fuera de rango» también manda el documento a `needs_portal`.
 */
export const SRI_WS_WINDOW_DAYS = 175;

export const MAX_FETCH_ATTEMPTS = 8;

const DAY_MS = 86_400_000;

/** `true` si la fecha de emisión (`AAAA-MM-DD`) ya quedó fuera de lo que el web service contesta. */
export function isBeyondWebServiceWindow(issueDate: string, now: Date): boolean {
  return now.getTime() - Date.parse(`${issueDate}T00:00:00-05:00`) > SRI_WS_WINDOW_DAYS * DAY_MS;
}

/** Espera antes del reintento n: 15 min, 30, 1 h, 2 h… con tope de 12 h. El SRI se cae a ratos; no se le insiste. */
export function retryDelayMs(attempts: number): number {
  return Math.min(15 * 60_000 * 2 ** Math.max(0, attempts - 1), 12 * 3_600_000);
}

export function newReceivedDocument(organizationId: string, row: SriReportRow, createdBy: string, now: Date): ReceivedSriDocument {
  const beyond = isBeyondWebServiceWindow(row.access.issueDate, now);
  return {
    id: randomUUID(),
    organizationId,
    accessKey: row.access.accessKey,
    documentTypeCode: row.access.documentTypeCode,
    issuerRuc: row.issuerRuc,
    issuerName: row.issuerName,
    documentNumber: row.documentNumber,
    issueDate: row.access.issueDate,
    authorizedAt: row.authorizedAt ? new Date(row.authorizedAt) : null,
    subtotalCents: row.subtotalCents,
    taxCents: row.taxCents,
    totalCents: row.totalCents,
    modifiedDocumentNumber: row.modifiedDocumentNumber,
    status: beyond ? 'needs_portal' : 'pending',
    source: 'portal_report',
    xml: null,
    attempts: 0,
    lastError: null,
    lastAttemptAt: null,
    nextAttemptAt: beyond ? null : now,
    downloadedAt: null,
    createdBy,
    createdAt: now,
    updatedAt: now,
  };
}

/** Lo que el SRI contesta cuando se le pide un comprobante por su clave de acceso. */
export type SriFetchResult =
  | { state: 'authorized'; xml: string; authorizationNumber: string | null; authorizedAt: string | null }
  | { state: 'not_authorized'; reason: string }
  /** La fecha de emisión es más vieja de lo que el web service contesta: el XML solo sale del portal. */
  | { state: 'out_of_range' }
  /** El SRI todavía no tiene resultado para esa clave (recién emitida, o en procesamiento). Se reintenta. */
  | { state: 'not_found' };

/** El XML trae la clave de acceso del documento (en el sobre de autorización o en el propio comprobante). */
export function xmlMatchesAccessKey(xml: string, accessKey: string): boolean {
  return xml.includes(accessKey);
}

/**
 * Aplica a un documento pendiente lo que contestó el SRI. `error` es el motivo cuando el SRI no respondió nada utilizable (red,
 * timeout): cuenta como intento y se reintenta con espera creciente hasta `MAX_FETCH_ATTEMPTS`, después queda `failed`.
 */
export function applyFetchResult(doc: ReceivedSriDocument, result: SriFetchResult | null, error: string | null, now: Date): ReceivedSriDocument {
  const base = { ...doc, attempts: doc.attempts + 1, lastAttemptAt: now, updatedAt: now };

  if (result?.state === 'authorized') {
    if (!xmlMatchesAccessKey(result.xml, doc.accessKey)) return retry(base, 'El XML que devolvió el SRI no corresponde a la clave pedida.', now);
    return {
      ...base,
      status: 'downloaded',
      xml: result.xml,
      authorizedAt: result.authorizedAt ? new Date(result.authorizedAt) : doc.authorizedAt,
      downloadedAt: now,
      lastError: null,
      nextAttemptAt: null,
    };
  }
  if (result?.state === 'not_authorized') return { ...base, status: 'not_authorized', lastError: result.reason, nextAttemptAt: null };
  if (result?.state === 'out_of_range') {
    return { ...base, status: 'needs_portal', lastError: 'Es más viejo de lo que contesta el web service del SRI: hay que traerlo del portal.', nextAttemptAt: null };
  }
  return retry(base, error ?? 'El SRI aún no tiene resultado para esta clave.', now);
}

function retry(doc: ReceivedSriDocument, reason: string, now: Date): ReceivedSriDocument {
  if (doc.attempts >= MAX_FETCH_ATTEMPTS) return { ...doc, status: 'failed', lastError: reason, nextAttemptAt: null };
  return { ...doc, status: 'pending', lastError: reason, nextAttemptAt: new Date(now.getTime() + retryDelayMs(doc.attempts)) };
}
