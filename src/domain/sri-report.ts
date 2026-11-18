import { ValidationError } from './errors.js';
import { parseAccessKey, type ParsedAccessKey } from './sri-access-key.js';

/** Una fila del reporte «Descargar reporte» de Comprobantes electrónicos recibidos del portal del SRI. */
export interface SriReportRow {
  access: ParsedAccessKey;
  issuerRuc: string;
  issuerName: string;
  /** Lo que el portal llama TIPO_COMPROBANTE ("Factura", "Notas de Crédito"…): texto libre, la fuente de verdad es el código de la clave. */
  documentLabel: string;
  documentNumber: string;
  /** ISO 8601 con la hora de Ecuador (-05:00, sin horario de verano), o `null` si el reporte no la trae. */
  authorizedAt: string | null;
  receiverIdentification: string;
  subtotalCents: number;
  taxCents: number;
  totalCents: number;
  /** Para notas de crédito y débito: el documento que modifican. */
  modifiedDocumentNumber: string | null;
}

export interface RejectedReportRow {
  /** Número de línea del archivo (la 1 es la cabecera). */
  line: number;
  reason: string;
}

export interface ParsedSriReport {
  rows: SriReportRow[];
  rejected: RejectedReportRow[];
}

const REQUIRED_COLUMNS = ['CLAVE_ACCESO', 'RUC_EMISOR', 'IMPORTE_TOTAL'] as const;

/**
 * `"113.52"` → 11352. Sin pasar por coma flotante: 1.005 * 100 da 100.49999… y un centavo de diferencia en un libro.
 * El portal escribe `.58` (sin el cero de la izquierda) para los importes menores a un dólar.
 */
function toCents(value: string, label: string): number {
  const v = value.trim();
  if (v === '') return 0;
  const m = /^(-?)(\d*)(?:\.(\d{1,2}))?$/.exec(v);
  if (!m || (m[2] === '' && m[3] === undefined)) throw new Error(`${label} no es un importe: "${value}".`);
  const cents = Number(m[2] || '0') * 100 + Number((m[3] ?? '').padEnd(2, '0'));
  return m[1] ? -cents : cents;
}

/** `28/02/2026 18:24:44` → `2026-02-28T18:24:44-05:00`. */
function toEcuadorIso(value: string): string | null {
  const m = /^(\d{2})\/(\d{2})\/(\d{4})(?:\s+(\d{2}):(\d{2}):(\d{2}))?$/.exec(value.trim());
  if (!m) return null;
  return `${m[3]}-${m[2]}-${m[1]}T${m[4] ?? '00'}:${m[5] ?? '00'}:${m[6] ?? '00'}-05:00`;
}

/**
 * Lee el reporte de comprobantes recibidos: texto con tabuladores y cabecera. Se ubica cada columna POR NOMBRE, no por posición, para
 * no depender de que el SRI conserve el orden. Una fila mala (clave con el dígito errado, importe ilegible) se devuelve en
 * `rejected` con su motivo y no tumba el resto: un reporte de 800 filas con una mala debe importar las otras 799.
 *
 * El texto debe llegar ya decodificado: el SRI lo sirve en ISO-8859-1 y, leído como UTF-8, la «Ñ» de una razón social se corrompe.
 */
export function parseSriReport(text: string): ParsedSriReport {
  const lines = text.replace(/^﻿/, '').split(/\r?\n/);
  const header = (lines[0] ?? '').split('\t').map((h) => h.trim().toUpperCase());
  const missing = REQUIRED_COLUMNS.filter((c) => !header.includes(c));
  if (missing.length) {
    throw new ValidationError([{ field: 'report', message: `El archivo no parece un reporte de comprobantes recibidos del SRI: faltan las columnas ${missing.join(', ')}.` }]);
  }
  const col = (cells: string[], name: string): string => (cells[header.indexOf(name)] ?? '').trim();

  const rows: SriReportRow[] = [];
  const rejected: RejectedReportRow[] = [];
  for (let i = 1; i < lines.length; i++) {
    const raw = lines[i]!;
    if (raw.trim() === '') continue;
    const cells = raw.split('\t');
    try {
      const access = parseAccessKey(col(cells, 'CLAVE_ACCESO'));
      rows.push({
        access,
        issuerRuc: col(cells, 'RUC_EMISOR') || access.issuerRuc,
        issuerName: col(cells, 'RAZON_SOCIAL_EMISOR'),
        documentLabel: col(cells, 'TIPO_COMPROBANTE'),
        documentNumber: col(cells, 'SERIE_COMPROBANTE') || access.documentNumber,
        authorizedAt: toEcuadorIso(col(cells, 'FECHA_AUTORIZACION')),
        receiverIdentification: col(cells, 'IDENTIFICACION_RECEPTOR'),
        subtotalCents: toCents(col(cells, 'VALOR_SIN_IMPUESTOS'), 'El valor sin impuestos'),
        taxCents: toCents(col(cells, 'IVA'), 'El IVA'),
        totalCents: toCents(col(cells, 'IMPORTE_TOTAL'), 'El importe total'),
        modifiedDocumentNumber: col(cells, 'NUMERO_DOCUMENTO_MODIFICADO') || null,
      });
    } catch (err) {
      rejected.push({ line: i + 1, reason: err instanceof Error ? err.message : String(err) });
    }
  }
  return { rows, rejected };
}
