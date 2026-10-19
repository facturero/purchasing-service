import { ValidationError, type ErrorDetail } from '../../domain/errors.js';
import type { PurchasingSettings, UnitOfWork } from '../../domain/repositories.js';
import { settingsUpdatedEvent } from '../events.js';
import type { Clock, UnitOfWorkGateway, WarehouseCatalogPort } from '../ports.js';
import { inTransaction } from './supplier-use-cases.js';

export function defaultSettings(organizationId: string, now: Date): PurchasingSettings {
  return { organizationId, approvalThresholdCents: null, defaultWarehouseId: null, overReceiptToleranceBp: 0, priceToleranceBp: 0, qtyToleranceBp: 0, updatedAt: now };
}

export class GetSettingsUseCase {
  constructor(private readonly repos: UnitOfWork, private readonly clock: Clock) {}

  async execute(params: { organizationId: string }): Promise<PurchasingSettings> {
    return (await this.repos.settings.find(params.organizationId)) ?? defaultSettings(params.organizationId, this.clock());
  }
}

export class UpdateSettingsUseCase {
  constructor(private readonly gateway: UnitOfWorkGateway, private readonly clock: Clock, private readonly warehouses: WarehouseCatalogPort) {}

  async execute(params: {
    organizationId: string;
    changes: {
      approvalThresholdCents?: number | null;
      defaultWarehouseId?: string | null;
      /** Tolerancias en puntos básicos (0-5000 = 0%-50%). Las fija el administrador; no van en el código. */
      overReceiptToleranceBp?: number;
      priceToleranceBp?: number;
      qtyToleranceBp?: number;
    };
  }): Promise<PurchasingSettings> {
    const { changes } = params;
    if (changes.defaultWarehouseId) {
      const warehouse = await this.warehouses.findById(params.organizationId, changes.defaultWarehouseId);
      if (!warehouse || warehouse.status !== 'active') {
        throw new ValidationError([{ field: 'defaultWarehouseId', message: 'La bodega no existe o está inactiva.' }]);
      }
    }
    const toleranceProblems: ErrorDetail[] = [];
    for (const field of ['overReceiptToleranceBp', 'priceToleranceBp', 'qtyToleranceBp'] as const) {
      const value = changes[field];
      if (value === undefined) continue;
      if (!Number.isInteger(value) || value < 0 || value > 5000) {
        toleranceProblems.push({ field, message: 'La tolerancia va en puntos básicos enteros (0 a 5000).' });
      }
    }
    if (toleranceProblems.length) throw new ValidationError(toleranceProblems);
    return inTransaction(this.gateway, async (uow) => {
      const current = (await uow.settings.find(params.organizationId)) ?? defaultSettings(params.organizationId, this.clock());
      const next: PurchasingSettings = {
        ...current,
        ...(changes.approvalThresholdCents !== undefined ? { approvalThresholdCents: changes.approvalThresholdCents } : {}),
        ...(changes.defaultWarehouseId !== undefined ? { defaultWarehouseId: changes.defaultWarehouseId } : {}),
        ...(changes.overReceiptToleranceBp !== undefined ? { overReceiptToleranceBp: changes.overReceiptToleranceBp } : {}),
        ...(changes.priceToleranceBp !== undefined ? { priceToleranceBp: changes.priceToleranceBp } : {}),
        ...(changes.qtyToleranceBp !== undefined ? { qtyToleranceBp: changes.qtyToleranceBp } : {}),
        updatedAt: this.clock(),
      };
      await uow.settings.save(next);
      await uow.outbox.add(settingsUpdatedEvent(next));
      return next;
    });
  }
}
