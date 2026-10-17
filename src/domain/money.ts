import { ValidationError } from './errors.js';

/**
 * Cantidades e importes de una compra. Dos reglas que valen para todo el servicio:
 *  - los importes son centavos ENTEROS (`number` seguro): lo mismo que billing, inventario y contabilidad;
 *  - las cantidades llevan hasta 6 decimales (kilos, litros, metros) y se guardan como enteros en millonésimas (`bigint`): ni un
 *    `0.1 + 0.2` ni un redondeo oculto. El producto cantidad × costo se hace en `bigint` y se redondea UNA vez, a la mitad hacia arriba.
 */
export const QTY_SCALE = 1_000_000n;
export const MAX_QTY_MICROS = 999_999_999_999n * QTY_SCALE; // 999 999 999 999 unidades

/** `"2.5"` → 2_500_000n. Rechaza más de 6 decimales, signos y notación científica. */
export function parseQuantity(value: string | number, field = 'quantity'): bigint {
  const text = typeof value === 'number' ? String(value) : value.trim();
  const match = /^(\d{1,12})(?:\.(\d{1,6}))?$/.exec(text);
  if (!match) throw new ValidationError([{ field, message: 'La cantidad debe ser un número positivo con hasta 6 decimales.' }]);
  const micros = BigInt(match[1]!) * QTY_SCALE + BigInt((match[2] ?? '').padEnd(6, '0') || '0');
  if (micros <= 0n) throw new ValidationError([{ field, message: 'La cantidad debe ser mayor que cero.' }]);
  return micros;
}

/** 2_500_000n → `"2.5"`; 10_000_000n → `"10"`. */
export function quantityToString(micros: bigint): string {
  const whole = micros / QTY_SCALE;
  const frac = (micros % QTY_SCALE).toString().padStart(6, '0').replace(/0+$/, '');
  return frac ? `${whole}.${frac}` : `${whole}`;
}

/** cantidad × costo unitario (centavos), redondeado a la mitad hacia arriba. */
export function lineGrossCents(quantityMicros: bigint, unitCostCents: number): number {
  const product = quantityMicros * BigInt(unitCostCents);
  return Number((product + QTY_SCALE / 2n) / QTY_SCALE);
}

/** `"15.00"` → 1500 (centésimas de punto porcentual). */
export function parsePercentHundredths(percent: string): number {
  const match = /^(\d{1,3})(?:\.(\d{1,2}))?$/.exec(percent.trim());
  if (!match) throw new ValidationError([{ field: 'taxPercent', message: 'El porcentaje de impuesto no es válido.' }]);
  const value = Number(match[1]) * 100 + Number((match[2] ?? '').padEnd(2, '0') || '0');
  if (value > 10_000) throw new ValidationError([{ field: 'taxPercent', message: 'El porcentaje de impuesto no puede pasar de 100.' }]);
  return value;
}

/** Impuesto de una base: `base × porcentaje / 100`, mitad hacia arriba. */
export function taxCentsOf(baseCents: number, percentHundredths: number): number {
  return Math.floor((baseCents * percentHundredths + 5000) / 10_000);
}

export function assertCents(value: number, field: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new ValidationError([{ field, message: 'El importe debe ser un número entero de centavos, sin signo.' }]);
  }
}
