import { describe, expect, it } from 'vitest';
import { lineGrossCents, parsePercentHundredths, parseQuantity, quantityToString, taxCentsOf } from '../domain/money.js';
import {
  approve,
  cancel,
  computeLine,
  formatOrderNumber,
  newDraft,
  reject,
  reopenRejected,
  replaceDraft,
  requiresApproval,
  submit,
  type OrderHeaderInput,
  type OrderLineInput,
} from '../domain/purchase-order.js';
import { normalizeSupplierInput } from '../domain/supplier.js';
import { InvalidOrderStateError, SelfApprovalError, ValidationError } from '../domain/errors.js';

const NOW = new Date('2026-10-20T15:00:00Z');
const header: OrderHeaderInput = {
  supplierId: 's1',
  supplier: { identificationType: 'RUC', identification: '1790012345001', legalName: 'Proveedor' },
  warehouseId: 'w1',
  establishmentId: null,
  currencyCode: 'USD',
  orderDate: '2026-10-20',
  expectedDate: null,
  paymentTermDays: 30,
  notes: null,
};
const line = (over: Partial<OrderLineInput> = {}): OrderLineInput => ({
  productId: 'p1', sku: 'SKU', description: 'Papel', quantityMicros: 10_000_000n, unitCostCents: 250, discountCents: 0, taxRateId: 't15', taxPercent: '15.00', ...over,
});
const draft = () => newDraft({ organizationId: 'o1', createdBy: 'maker', header, lines: [line()], now: NOW });

describe('cantidades', () => {
  it('se leen con hasta 6 decimales y sin pérdida', () => {
    expect(parseQuantity('2.5')).toBe(2_500_000n);
    expect(parseQuantity('0.000001')).toBe(1n);
    expect(parseQuantity(10)).toBe(10_000_000n);
    expect(parseQuantity('999999999999')).toBe(999_999_999_999_000_000n);
  });

  it.each(['', '0', '0.000000', '-1', '1.2345678', '1e3', 'abc', '1,5', '1000000000000'])('rechaza %j', (bad) => {
    expect(() => parseQuantity(bad)).toThrow(ValidationError);
  });

  it('se muestran sin ceros de más', () => {
    expect(quantityToString(2_500_000n)).toBe('2.5');
    expect(quantityToString(10_000_000n)).toBe('10');
    expect(quantityToString(1n)).toBe('0.000001');
  });
});

describe('importes', () => {
  it('cantidad × costo se redondea una sola vez, a la mitad hacia arriba', () => {
    expect(lineGrossCents(10_000_000n, 250)).toBe(2500);
    expect(lineGrossCents(2_500_000n, 399)).toBe(998); // 997,5
    expect(lineGrossCents(333_333n, 100)).toBe(33); // 33,3333
    expect(lineGrossCents(1n, 1)).toBe(0);
  });

  it('un costo enorme por una cantidad enorme no pierde precisión (bigint)', () => {
    expect(lineGrossCents(999_999_999_999_000_000n, 1_000_000)).toBe(999_999_999_999_000_000);
  });

  it('el IVA se calcula sobre la base de cada línea', () => {
    expect(taxCentsOf(2500, parsePercentHundredths('15.00'))).toBe(375);
    expect(taxCentsOf(333, parsePercentHundredths('15'))).toBe(50); // 49,95
    expect(taxCentsOf(1000, parsePercentHundredths('0.00'))).toBe(0);
    expect(() => parsePercentHundredths('101')).toThrow(ValidationError);
  });
});

describe('línea y totales', () => {
  it('calcula subtotal, impuesto y total, con descuento', () => {
    const l = computeLine(line({ discountCents: 500 }), 1);
    expect(l).toMatchObject({ subtotalCents: 2000, taxCents: 300, totalCents: 2300, receivedMicros: 0n });
  });

  it('el descuento no puede superar el valor de la línea', () => {
    expect(() => computeLine(line({ discountCents: 2501 }), 1)).toThrow(/descuento/);
  });

  it('el borrador suma sus líneas', () => {
    const d = newDraft({ organizationId: 'o1', createdBy: 'maker', header, lines: [line(), line({ unitCostCents: 100, taxPercent: '0.00' })], now: NOW });
    expect(d).toMatchObject({ status: 'draft', number: null, subtotalCents: 3500, taxCents: 375, totalCents: 3875, version: 1 });
  });

  it('exige al menos una línea y una descripción', () => {
    expect(() => newDraft({ organizationId: 'o1', createdBy: 'm', header, lines: [], now: NOW })).toThrow(/al menos una línea/);
    expect(() => newDraft({ organizationId: 'o1', createdBy: 'm', header, lines: [line({ description: '  ' })], now: NOW })).toThrow(ValidationError);
  });

  it('valida las fechas del encabezado', () => {
    expect(() => newDraft({ organizationId: 'o1', createdBy: 'm', header: { ...header, expectedDate: '2026-10-01' }, lines: [line()], now: NOW })).toThrow(/anterior/);
    expect(() => newDraft({ organizationId: 'o1', createdBy: 'm', header: { ...header, orderDate: '20/10/2026' }, lines: [line()], now: NOW })).toThrow(ValidationError);
  });
});

describe('ciclo de vida de la orden', () => {
  it('solo un borrador se edita', () => {
    const d = draft();
    const edited = replaceDraft(d, { ...header, notes: 'urgente' }, [line({ quantityMicros: 20_000_000n })], NOW);
    expect(edited).toMatchObject({ notes: 'urgente', subtotalCents: 5000, version: 2 });
    const sent = submit(d, { number: 'OC-2026-000001', needsApproval: false, now: NOW });
    expect(() => replaceDraft(sent, header, [line()], NOW)).toThrow(InvalidOrderStateError);
  });

  it('enviar sin que se exija aprobación la deja aprobada, sin aprobador', () => {
    const sent = submit(draft(), { number: 'OC-2026-000001', needsApproval: false, now: NOW });
    expect(sent).toMatchObject({ status: 'approved', number: 'OC-2026-000001', approvedBy: null, approvedAt: NOW });
  });

  it('enviar con aprobación la deja pendiente; la aprueba otra persona, no quien la preparó', () => {
    const pending = submit(draft(), { number: 'OC-2026-000001', needsApproval: true, now: NOW });
    expect(pending.status).toBe('pending_approval');
    expect(() => approve(pending, 'maker', NOW)).toThrow(SelfApprovalError);
    expect(approve(pending, 'boss', NOW)).toMatchObject({ status: 'approved', approvedBy: 'boss' });
  });

  it('una orden de valor cero no se envía', () => {
    const zero = newDraft({ organizationId: 'o1', createdBy: 'm', header, lines: [line({ unitCostCents: 0 })], now: NOW });
    expect(() => submit(zero, { number: 'OC-2026-000001', needsApproval: false, now: NOW })).toThrow(/valor cero/);
  });

  it('rechazar pide motivo y deja la orden rechazada; se reabre como borrador', () => {
    const pending = submit(draft(), { number: 'OC-2026-000001', needsApproval: true, now: NOW });
    expect(() => reject(pending, 'boss', ' ', NOW)).toThrow(/motivo/);
    expect(() => reject(pending, 'maker', 'no', NOW)).toThrow(SelfApprovalError);
    const rejected = reject(pending, 'boss', 'Precio fuera de rango', NOW);
    expect(rejected).toMatchObject({ status: 'rejected', rejectionReason: 'Precio fuera de rango' });
    expect(reopenRejected(rejected, NOW).status).toBe('draft');
  });

  it('cancelar pide motivo y no se puede con mercadería recibida', () => {
    const approved = submit(draft(), { number: 'OC-2026-000001', needsApproval: false, now: NOW });
    expect(() => cancel(approved, 'u', '', NOW)).toThrow(/motivo/);
    expect(cancel(approved, 'u', 'Ya no se necesita', NOW)).toMatchObject({ status: 'cancelled', cancelReason: 'Ya no se necesita', cancelledBy: 'u' });
    const received = { ...approved, lines: approved.lines.map((l) => ({ ...l, receivedMicros: 1n })) };
    expect(() => cancel(received, 'u', 'tarde', NOW)).toThrow(/ya recibió/);
  });

  it('una orden cancelada no vuelve a ningún estado', () => {
    const cancelled = cancel(draft(), 'u', 'error de captura', NOW);
    expect(() => submit(cancelled, { number: 'x', needsApproval: false, now: NOW })).toThrow(InvalidOrderStateError);
    expect(() => cancel(cancelled, 'u', 'otra vez', NOW)).toThrow(InvalidOrderStateError);
  });

  it('la política de aprobación', () => {
    expect(requiresApproval(1_000_000, null)).toBe(false);
    expect(requiresApproval(99_999, 100_000)).toBe(false);
    expect(requiresApproval(100_000, 100_000)).toBe(true);
    expect(requiresApproval(1, 0)).toBe(true);
  });

  it('numera como OC-AAAA-NNNNNN', () => {
    expect(formatOrderNumber(2026, 42)).toBe('OC-2026-000042');
  });
});

describe('proveedor', () => {
  const ok = { identificationType: 'RUC' as const, identification: '1790012345001', legalName: ' Andina ' };

  it('normaliza y completa los valores por defecto', () => {
    expect(normalizeSupplierInput({ ...ok, email: ' ventas@andina.ec ', tradeName: '  ' })).toMatchObject({
      legalName: 'Andina', email: 'ventas@andina.ec', tradeName: null, paymentTermDays: 0, relatedParty: false,
    });
  });

  it('valida la identificación según su tipo', () => {
    expect(() => normalizeSupplierInput({ ...ok, identification: '123' })).toThrow(/13 dígitos/);
    expect(() => normalizeSupplierInput({ ...ok, identificationType: 'CEDULA' })).toThrow(/10 dígitos/);
    expect(normalizeSupplierInput({ ...ok, identificationType: 'PASAPORTE', identification: 'ab123456' }).identification).toBe('AB123456');
  });

  it('informa TODOS los problemas, no solo el primero', () => {
    try {
      normalizeSupplierInput({ ...ok, identification: 'x', legalName: ' ', email: 'no-es-correo', paymentTermDays: 400 });
      expect.unreachable();
    } catch (err) {
      expect((err as ValidationError).details?.map((d) => d.field).sort()).toEqual(['email', 'identification', 'legalName', 'paymentTermDays']);
    }
  });
});
