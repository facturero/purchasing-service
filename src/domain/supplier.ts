import { randomUUID } from 'node:crypto';
import { ValidationError, type ErrorDetail } from './errors.js';

export const IDENTIFICATION_TYPES = ['RUC', 'CEDULA', 'PASAPORTE', 'EXTERIOR'] as const;
export type IdentificationType = (typeof IDENTIFICATION_TYPES)[number];
export type SupplierStatus = 'active' | 'inactive';

/** Un proveedor: a quien se le compra y, más adelante, a quien se le retiene y se le paga. */
export interface Supplier {
  id: string;
  organizationId: string;
  identificationType: IdentificationType;
  identification: string;
  legalName: string;
  tradeName: string | null;
  email: string | null;
  phone: string | null;
  address: string | null;
  /** Días de crédito por defecto: 0 = contado. Se copian a la orden y a la factura de compra. */
  paymentTermDays: number;
  /** El proveedor es parte relacionada (el SRI lo exige en la retención). */
  relatedParty: boolean;
  notes: string | null;
  status: SupplierStatus;
  createdAt: Date;
  updatedAt: Date;
}

export interface SupplierInput {
  identificationType: IdentificationType;
  identification: string;
  legalName: string;
  tradeName?: string | null;
  email?: string | null;
  phone?: string | null;
  address?: string | null;
  paymentTermDays?: number;
  relatedParty?: boolean;
  notes?: string | null;
}

const IDENTIFICATION_PATTERNS: Record<IdentificationType, { regex: RegExp; message: string }> = {
  RUC: { regex: /^\d{13}$/, message: 'El RUC tiene 13 dígitos.' },
  CEDULA: { regex: /^\d{10}$/, message: 'La cédula tiene 10 dígitos.' },
  PASAPORTE: { regex: /^[A-Za-z0-9]{1,20}$/, message: 'El pasaporte admite letras y números (hasta 20).' },
  EXTERIOR: { regex: /^[A-Za-z0-9]{1,20}$/, message: 'La identificación del exterior admite letras y números (hasta 20).' },
};

const clean = (value: string | null | undefined): string | null => {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
};

/** Valida y normaliza. Lanza `ValidationError` con TODOS los problemas, no solo el primero. */
export function normalizeSupplierInput(input: SupplierInput): Required<Omit<SupplierInput, 'identificationType'>> & { identificationType: IdentificationType } {
  const problems: ErrorDetail[] = [];
  const identification = input.identification.trim().toUpperCase();
  const rule = IDENTIFICATION_PATTERNS[input.identificationType];
  if (!rule.regex.test(identification)) problems.push({ field: 'identification', message: rule.message });
  const legalName = input.legalName.trim();
  if (!legalName) problems.push({ field: 'legalName', message: 'La razón social o el nombre es obligatorio.' });
  if (legalName.length > 300) problems.push({ field: 'legalName', message: 'La razón social admite hasta 300 caracteres.' });
  const email = clean(input.email);
  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) problems.push({ field: 'email', message: 'El correo no es válido.' });
  const paymentTermDays = input.paymentTermDays ?? 0;
  if (!Number.isInteger(paymentTermDays) || paymentTermDays < 0 || paymentTermDays > 365) {
    problems.push({ field: 'paymentTermDays', message: 'Los días de crédito van de 0 a 365.' });
  }
  if (problems.length) throw new ValidationError(problems);
  return {
    identificationType: input.identificationType,
    identification,
    legalName,
    tradeName: clean(input.tradeName),
    email,
    phone: clean(input.phone),
    address: clean(input.address),
    paymentTermDays,
    relatedParty: input.relatedParty ?? false,
    notes: clean(input.notes),
  };
}

export function newSupplier(organizationId: string, input: SupplierInput, now: Date): Supplier {
  return { id: randomUUID(), organizationId, status: 'active', createdAt: now, updatedAt: now, ...normalizeSupplierInput(input) };
}
