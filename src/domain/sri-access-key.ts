import { AppError } from './errors.js';

/** Tipos de comprobante que el SRI numera en la clave de acceso (tabla 3 de la ficha técnica). */
export type SriDocumentType = 'invoice' | 'purchase_settlement' | 'credit_note' | 'debit_note' | 'waybill' | 'withholding';

const TYPE_BY_CODE: Record<string, SriDocumentType> = {
  '01': 'invoice',
  '03': 'purchase_settlement',
  '04': 'credit_note',
  '05': 'debit_note',
  '06': 'waybill',
  '07': 'withholding',
};

export class InvalidAccessKeyError extends AppError {
  readonly code = 'INVALID_ACCESS_KEY';
  readonly httpStatus = 422;
  constructor(message = 'La clave de acceso no es válida.') { super(message); }
}

/** Dígito verificador módulo 11 de los primeros 48 dígitos (pesos 2..7 de derecha a izquierda). */
export function accessKeyCheckDigit(digits48: string): string {
  const weights = [2, 3, 4, 5, 6, 7];
  let sum = 0;
  for (let i = digits48.length - 1, w = 0; i >= 0; i--, w++) sum += Number(digits48[i]) * weights[w % weights.length]!;
  const result = 11 - (sum % 11);
  if (result === 11) return '0';
  if (result === 10) return '1';
  return String(result);
}

export interface ParsedAccessKey {
  accessKey: string;
  /** `AAAA-MM-DD`. */
  issueDate: string;
  documentTypeCode: string;
  /** `null` si el código no es de los que este módulo conoce: se guarda igual, pero no se interpreta. */
  documentType: SriDocumentType | null;
  issuerRuc: string;
  environment: 'pruebas' | 'produccion';
  /** `001-002-000000123`: establecimiento, punto de emisión y secuencial. */
  documentNumber: string;
}

/**
 * Valida y descompone una clave de acceso de 49 dígitos: `ddmmaaaa` + tipo(2) + RUC(13) + ambiente(1) + serie(6) + secuencial(9)
 * + código numérico(8) + tipo de emisión(1) + dígito verificador(1).
 *
 * Valida el dígito, no solo el largo: una clave pegada con un dígito cambiado se rechaza aquí y no llega al SRI a pedir un
 * comprobante que no existe (o, peor, a traer el de otro).
 */
export function parseAccessKey(raw: string): ParsedAccessKey {
  const accessKey = raw.trim();
  if (!/^\d{49}$/.test(accessKey)) throw new InvalidAccessKeyError('La clave de acceso debe tener 49 dígitos.');
  if (accessKeyCheckDigit(accessKey.slice(0, 48)) !== accessKey[48]) {
    throw new InvalidAccessKeyError('La clave de acceso tiene un dígito verificador incorrecto.');
  }

  const day = accessKey.slice(0, 2);
  const month = accessKey.slice(2, 4);
  const year = accessKey.slice(4, 8);
  // `Date` acepta el 31 de febrero y lo corre a marzo: se compara de vuelta para detectar fechas imposibles.
  const probe = new Date(Date.UTC(Number(year), Number(month) - 1, Number(day)));
  if (probe.getUTCFullYear() !== Number(year) || probe.getUTCMonth() !== Number(month) - 1 || probe.getUTCDate() !== Number(day)) {
    throw new InvalidAccessKeyError('La fecha de la clave de acceso no existe.');
  }

  const documentTypeCode = accessKey.slice(8, 10);
  const serie = accessKey.slice(24, 30);
  const sequential = accessKey.slice(30, 39);
  return {
    accessKey,
    issueDate: `${year}-${month}-${day}`,
    documentTypeCode,
    documentType: TYPE_BY_CODE[documentTypeCode] ?? null,
    issuerRuc: accessKey.slice(10, 23),
    environment: accessKey[23] === '2' ? 'produccion' : 'pruebas',
    documentNumber: `${serie.slice(0, 3)}-${serie.slice(3, 6)}-${sequential}`,
  };
}
