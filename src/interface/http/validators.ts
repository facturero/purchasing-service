import { zValidator } from '@hono/zod-validator';
import { z, type ZodSchema } from 'zod';
import { IDENTIFICATION_TYPES } from '../../domain/supplier.js';
import { ORDER_STATUSES } from '../../domain/purchase-order.js';
import { BILL_STATUSES, SUPPLIER_DOC_TYPES, type BillLineInput, type BillStatus } from '../../domain/purchase-bill.js';
import { parseQuantity } from '../../domain/money.js';
import { ValidationError } from '../../domain/errors.js';

const UUID = z.string().uuid('El identificador no es válido.');
const LOCAL_DATE = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'La fecha debe tener el formato AAAA-MM-DD.');
const CENTS = z.number().int('Los importes van en centavos enteros.').min(0, 'El importe no puede ser negativo.').max(Number.MAX_SAFE_INTEGER);
const optionalText = (max: number) => z.string().trim().max(max).nullish().transform((v) => v || null);

export const supplierSchema = z
  .object({
    identificationType: z.enum(IDENTIFICATION_TYPES),
    identification: z.string().trim().min(1, 'La identificación es obligatoria.').max(20),
    legalName: z.string().trim().min(1, 'La razón social es obligatoria.').max(300),
    tradeName: optionalText(300),
    email: optionalText(300),
    phone: optionalText(40),
    address: optionalText(500),
    paymentTermDays: z.number().int().min(0).max(365).default(0),
    relatedParty: z.boolean().default(false),
    notes: optionalText(2000),
  })
  .strict();

/** Para editar: la identificación no cambia (ver UpdateSupplierUseCase). */
export const updateSupplierSchema = supplierSchema.omit({ identificationType: true, identification: true });

const lineSchema = z
  .object({
    productId: UUID,
    description: z.string().trim().max(300).optional(),
    quantity: z.union([z.string(), z.number()]).transform((v) => String(v)),
    unitCostCents: CENTS,
    discountCents: CENTS.optional(),
    taxRateId: UUID.nullable().optional(),
  })
  .strict();

export const orderSchema = z
  .object({
    supplierId: UUID,
    warehouseId: UUID,
    establishmentId: UUID.nullish(),
    currencyCode: z.string().regex(/^[A-Za-z]{3}$/, 'La moneda es un código de tres letras.').optional(),
    orderDate: LOCAL_DATE.optional(),
    expectedDate: LOCAL_DATE.nullish(),
    paymentTermDays: z.number().int().min(0).max(365).optional(),
    notes: z.string().max(1000).nullish(),
    lines: z.array(lineSchema).min(1, 'La orden necesita al menos una línea.').max(200),
  })
  .strict();

export const reasonSchema = z.object({ reason: z.string().trim().min(3, 'Indica el motivo.').max(300) }).strict();

export const settingsSchema = z
  .object({
    approvalThresholdCents: CENTS.nullable(),
    defaultWarehouseId: UUID.nullable(),
    overReceiptToleranceBp: z.number().int().min(0).max(5000),
    priceToleranceBp: z.number().int().min(0).max(5000),
    qtyToleranceBp: z.number().int().min(0).max(5000),
  })
  .partial()
  .strict();

export const supplierQuerySchema = z.object({
  q: z.string().trim().max(100).optional(),
  status: z.enum(['active', 'inactive']).optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(25),
});

export const orderQuerySchema = z.object({
  q: z.string().trim().max(100).optional(),
  status: z.enum(ORDER_STATUSES as unknown as [string, ...string[]]).optional(),
  supplierId: UUID.optional(),
  from: LOCAL_DATE.optional(),
  to: LOCAL_DATE.optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(25),
});

// ── Recepción ──────────────────────────────────────────────────────────────────

const receiptLineSchema = z
  .object({
    orderLineId: UUID,
    quantity: z.union([z.string(), z.number()]).transform((v) => String(v)),
  })
  .strict();

export const receiptSchema = z
  .object({
    receiptDate: LOCAL_DATE,
    supplierDeliveryRef: z.string().trim().max(60).nullish(),
    notes: optionalText(1000),
    lines: z.array(receiptLineSchema).min(1, 'La recepción necesita al menos una línea.'),
  })
  .strict();

export const receiptQuerySchema = z.object({
  q: z.string().trim().max(100).optional(),
  purchaseOrderId: UUID.optional(),
  supplierId: UUID.optional(),
  from: LOCAL_DATE.optional(),
  to: LOCAL_DATE.optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(25),
});

// ── Factura de compra ──────────────────────────────────────────────────────────

const billLineSchema = z
  .object({
    orderLineId: UUID.nullish(),
    productId: UUID.nullish(),
    description: z.string().trim().min(1).max(300),
    quantity: z.union([z.string(), z.number()]).transform((v) => String(v)),
    unitCostCents: CENTS,
    discountCents: CENTS.optional(),
    taxCode: z.string().max(12).nullish(),
    taxPercentageCode: z.string().max(12).nullish(),
    taxRatePct: z.string().regex(/^\d+(\.\d{1,2})?$/, 'Porcentaje con hasta 2 decimales.'),
    taxCents: CENTS.optional(),
    iceCents: CENTS.optional(),
    irbpnrCents: CENTS.optional(),
    expenseAccountHint: z.string().max(60).nullish(),
  })
  .strict();

export const billSchema = z
  .object({
    supplierId: UUID,
    purchaseOrderId: UUID.nullish(),
    docType: z.enum(SUPPLIER_DOC_TYPES),
    establishment: z.string().regex(/^\d{3}$/, 'El establecimiento debe ser 3 dígitos.'),
    emissionPoint: z.string().regex(/^\d{3}$/, 'El punto de emisión debe ser 3 dígitos.'),
    sequential: z.string().regex(/^\d{9}$/, 'El secuencial debe ser 9 dígitos.'),
    authorizationNumber: z.string().max(49).nullish(),
    issueDate: LOCAL_DATE,
    dueDate: LOCAL_DATE,
    currencyCode: z.string().regex(/^[A-Za-z]{3}$/, 'La moneda es un código de tres letras.'),
    notes: optionalText(1000),
    lines: z
      .array(billLineSchema)
      .min(1, 'La factura necesita al menos una línea.')
      // La capa HTTP entrega `quantity` como texto; el dominio trabaja en micros.
      .transform((lines): BillLineInput[] =>
        lines.map((l, i) => ({
          orderLineId: l.orderLineId ?? null,
          productId: l.productId ?? null,
          description: l.description,
          quantityMicros: parseQuantity(l.quantity, `lines[${i}].quantity`),
          unitCostCents: l.unitCostCents,
          discountCents: l.discountCents ?? 0,
          taxCode: l.taxCode ?? null,
          taxPercentageCode: l.taxPercentageCode ?? null,
          taxRatePct: l.taxRatePct,
          taxCents: l.taxCents,
          iceCents: l.iceCents ?? 0,
          irbpnrCents: l.irbpnrCents ?? 0,
          expenseAccountHint: l.expenseAccountHint ?? null,
        })),
      ),
    supplierTotalCents: CENTS.optional(),
  })
  .strict();

export const billQuerySchema = z.object({
  q: z.string().trim().max(100).optional(),
  supplierId: UUID.optional(),
  status: z.enum(BILL_STATUSES as unknown as [BillStatus, ...BillStatus[]]).optional(),
  matchStatus: z.enum(['matched', 'blocked', 'overridden', 'not_applicable']).optional(),
  purchaseOrderId: UUID.optional(),
  from: LOCAL_DATE.optional(),
  to: LOCAL_DATE.optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(25),
});

export const overrideSchema = z.object({ reason: z.string().trim().min(5, 'El motivo debe tener al menos 5 caracteres.').max(300) }).strict();

export const voidSchema = z.object({ reason: z.string().trim().min(5, 'El motivo debe tener al menos 5 caracteres.').max(300) }).strict();

/** Valida el cuerpo y responde con el formato de error del servicio (`VALIDATION_ERROR` + campos), no con el de zod. */
export function validateJson<T extends ZodSchema>(schema: T) {
  return zValidator('json', schema, (result) => {
    if (!result.success) {
      throw new ValidationError(result.error.issues.map((i) => ({ field: i.path.join('.'), message: i.message })));
    }
  });
}

export function validateQuery<T extends ZodSchema>(schema: T) {
  return zValidator('query', schema, (result) => {
    if (!result.success) {
      throw new ValidationError(result.error.issues.map((i) => ({ field: i.path.join('.'), message: i.message })));
    }
  });
}
