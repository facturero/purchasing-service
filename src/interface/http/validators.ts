import { zValidator } from '@hono/zod-validator';
import { z, type ZodSchema } from 'zod';
import { IDENTIFICATION_TYPES } from '../../domain/supplier.js';
import { ORDER_STATUSES } from '../../domain/purchase-order.js';
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
