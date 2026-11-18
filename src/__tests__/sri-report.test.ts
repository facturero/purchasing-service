import { describe, expect, it } from 'vitest';
import { accessKeyCheckDigit, InvalidAccessKeyError, parseAccessKey } from '../domain/sri-access-key.js';
import { parseSriReport } from '../domain/sri-report.js';
import { ValidationError } from '../domain/errors.js';

/** Arma una clave válida: el dígito verificador se calcula, así las pruebas no cargan facturas reales de nadie. */
function key(parts: { date?: string; type?: string; ruc?: string; env?: string; serie?: string; seq?: string; code?: string } = {}): string {
  const base48 =
    (parts.date ?? '28022026') + (parts.type ?? '01') + (parts.ruc ?? '1790012345001') + (parts.env ?? '2') +
    (parts.serie ?? '001002') + (parts.seq ?? '000000123') + (parts.code ?? '12345678') + '1';
  return base48 + accessKeyCheckDigit(base48);
}

describe('parseAccessKey', () => {
  it('descompone una clave válida', () => {
    const p = parseAccessKey(key());
    expect(p).toMatchObject({
      issueDate: '2026-02-28',
      documentTypeCode: '01',
      documentType: 'invoice',
      issuerRuc: '1790012345001',
      environment: 'produccion',
      documentNumber: '001-002-000000123',
    });
  });

  it('reconoce los tipos de comprobante y no inventa los que no conoce', () => {
    expect(parseAccessKey(key({ type: '04' })).documentType).toBe('credit_note');
    expect(parseAccessKey(key({ type: '07' })).documentType).toBe('withholding');
    expect(parseAccessKey(key({ type: '41' })).documentType).toBeNull();
  });

  it('rechaza una clave con un dígito cambiado', () => {
    const good = key();
    const bad = good.slice(0, 20) + (good[20] === '9' ? '0' : String(Number(good[20]) + 1)) + good.slice(21);
    expect(() => parseAccessKey(bad)).toThrow(InvalidAccessKeyError);
  });

  it('rechaza lo que no tiene 49 dígitos', () => {
    expect(() => parseAccessKey('123')).toThrow(/49 dígitos/);
    expect(() => parseAccessKey(key() + '0')).toThrow(InvalidAccessKeyError);
    expect(() => parseAccessKey('A'.repeat(49))).toThrow(InvalidAccessKeyError);
  });

  it('rechaza una fecha que no existe aunque el dígito cuadre', () => {
    expect(() => parseAccessKey(key({ date: '31022026' }))).toThrow(/fecha/);
  });

  it('tolera espacios alrededor (lo que queda al copiar de una tabla)', () => {
    expect(parseAccessKey(`  ${key()}\n`).accessKey).toBe(key());
  });
});

const HEADER = 'RUC_EMISOR\tRAZON_SOCIAL_EMISOR\tTIPO_COMPROBANTE\tSERIE_COMPROBANTE\tCLAVE_ACCESO\tFECHA_AUTORIZACION\tFECHA_EMISION\tIDENTIFICACION_RECEPTOR\tVALOR_SIN_IMPUESTOS\tIVA\tIMPORTE_TOTAL\tNUMERO_DOCUMENTO_MODIFICADO';

function line(k: string, extra: Partial<Record<'name' | 'sub' | 'iva' | 'total' | 'auth' | 'mod', string>> = {}): string {
  return ['1790012345001', extra.name ?? 'PROVEEDOR S.A.', 'Factura', '001-002-000000123', k, extra.auth ?? '28/02/2026 18:24:44', '28/02/2026', '0912345678', extra.sub ?? '113.52', extra.iva ?? '7.78', extra.total ?? '121.3', extra.mod ?? ''].join('\t');
}

describe('parseSriReport', () => {
  it('lee las filas con importes en centavos y la hora de Ecuador', () => {
    const { rows, rejected } = parseSriReport([HEADER, line(key())].join('\r\n'));
    expect(rejected).toEqual([]);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      issuerRuc: '1790012345001',
      issuerName: 'PROVEEDOR S.A.',
      subtotalCents: 11352,
      taxCents: 778,
      totalCents: 12130,
      authorizedAt: '2026-02-28T18:24:44-05:00',
      modifiedDocumentNumber: null,
    });
  });

  it('los importes no pasan por coma flotante: 1.005 no se redondea a un lado ni a otro por azar', () => {
    const { rows, rejected } = parseSriReport([HEADER, line(key(), { sub: '8.7', iva: '1.3', total: '10.0' })].join('\n'));
    expect(rejected).toEqual([]);
    expect(rows[0]).toMatchObject({ subtotalCents: 870, taxCents: 130, totalCents: 1000 });
  });

  it('acepta los importes sin cero a la izquierda que escribe el portal (".58", ".5")', () => {
    const { rows, rejected } = parseSriReport([HEADER, line(key(), { sub: '.01', iva: '.58', total: '.5' })].join('\n'));
    expect(rejected).toEqual([]);
    expect(rows[0]).toMatchObject({ subtotalCents: 1, taxCents: 58, totalCents: 50 });
  });

  it('un punto suelto no es un importe', () => {
    const { rows, rejected } = parseSriReport([HEADER, line(key(), { iva: '.' })].join('\n'));
    expect(rows).toHaveLength(0);
    expect(rejected[0]!.reason).toMatch(/importe/);
  });

  it('una fila mala se rechaza con su número de línea y las demás se importan', () => {
    const good = key();
    const bad = good.slice(0, 48) + (good[48] === '9' ? '0' : String(Number(good[48]) + 1));
    const { rows, rejected } = parseSriReport([HEADER, line(good), line(bad), line(key({ seq: '000000124' }), { total: 'abc' })].join('\n'));
    expect(rows).toHaveLength(1);
    expect(rejected.map((r) => r.line)).toEqual([3, 4]);
    expect(rejected[0]!.reason).toMatch(/verificador/);
    expect(rejected[1]!.reason).toMatch(/importe/);
  });

  it('encuentra las columnas por nombre aunque cambie el orden', () => {
    const cols = HEADER.split('\t');
    const vals = line(key()).split('\t');
    const swap = (a: string[]) => [a[4], a[0], ...a.slice(1, 4), ...a.slice(5)];
    const { rows } = parseSriReport([swap(cols).join('\t'), swap(vals).join('\t')].join('\n'));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.issuerRuc).toBe('1790012345001');
  });

  it('guarda el documento modificado de una nota de crédito', () => {
    const { rows } = parseSriReport([HEADER, line(key({ type: '04' }), { mod: '001-002-000000100' })].join('\n'));
    expect(rows[0]!.access.documentType).toBe('credit_note');
    expect(rows[0]!.modifiedDocumentNumber).toBe('001-002-000000100');
  });

  it('un archivo que no es el reporte se rechaza entero con un 422', () => {
    expect(() => parseSriReport('hola\tmundo\n1\t2')).toThrow(ValidationError);
  });

  it('ignora líneas en blanco y el BOM', () => {
    const { rows } = parseSriReport('﻿' + [HEADER, '', line(key()), ''].join('\n'));
    expect(rows).toHaveLength(1);
  });
});
