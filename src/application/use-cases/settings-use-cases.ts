import { ValidationError } from '../../domain/errors.js';
import type { PurchasingSettings, UnitOfWork } from '../../domain/repositories.js';
import { settingsUpdatedEvent } from '../events.js';
import type { Clock, UnitOfWorkGateway, WarehouseCatalogPort } from '../ports.js';
import { inTransaction } from './supplier-use-cases.js';

export function defaultSettings(organizationId: string, now: Date): PurchasingSettings {
  return { organizationId, approvalThresholdCents: null, defaultWarehouseId: null, updatedAt: now };
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
    changes: { approvalThresholdCents?: number | null; defaultWarehouseId?: string | null };
  }): Promise<PurchasingSettings> {
    const { changes } = params;
    if (changes.defaultWarehouseId) {
      const warehouse = await this.warehouses.findById(params.organizationId, changes.defaultWarehouseId);
      if (!warehouse || warehouse.status !== 'active') {
        throw new ValidationError([{ field: 'defaultWarehouseId', message: 'La bodega no existe o está inactiva.' }]);
      }
    }
    return inTransaction(this.gateway, async (uow) => {
      const current = (await uow.settings.find(params.organizationId)) ?? defaultSettings(params.organizationId, this.clock());
      const next: PurchasingSettings = {
        ...current,
        ...(changes.approvalThresholdCents !== undefined ? { approvalThresholdCents: changes.approvalThresholdCents } : {}),
        ...(changes.defaultWarehouseId !== undefined ? { defaultWarehouseId: changes.defaultWarehouseId } : {}),
        updatedAt: this.clock(),
      };
      await uow.settings.save(next);
      await uow.outbox.add(settingsUpdatedEvent(next));
      return next;
    });
  }
}
