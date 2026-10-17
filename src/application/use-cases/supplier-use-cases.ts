import { SupplierIdentificationExistsError, SupplierNotFoundError } from '../../domain/errors.js';
import type { Page, SupplierFilters, UnitOfWork } from '../../domain/repositories.js';
import { newSupplier, normalizeSupplierInput, type Supplier, type SupplierInput } from '../../domain/supplier.js';
import { supplierUpsertedEvent } from '../events.js';
import type { Clock, UnitOfWorkGateway } from '../ports.js';

/** Corre `work` dentro de una transacción: confirma si termina, deshace si lanza. */
export async function inTransaction<T>(gateway: UnitOfWorkGateway, work: (uow: UnitOfWork) => Promise<T>): Promise<T> {
  const uow = await gateway.begin();
  try {
    const result = await work(uow);
    await uow.commit();
    return result;
  } catch (err) {
    await uow.rollback();
    throw err;
  }
}

export class CreateSupplierUseCase {
  constructor(private readonly gateway: UnitOfWorkGateway, private readonly clock: Clock) {}

  async execute(params: { organizationId: string; input: SupplierInput }): Promise<Supplier> {
    const supplier = newSupplier(params.organizationId, params.input, this.clock());
    return inTransaction(this.gateway, async (uow) => {
      if (await uow.suppliers.findByIdentification(supplier.organizationId, supplier.identification)) {
        throw new SupplierIdentificationExistsError();
      }
      await uow.suppliers.save(supplier);
      await uow.outbox.add(supplierUpsertedEvent(supplier));
      return supplier;
    });
  }
}

/**
 * Cambia los datos del proveedor SALVO su identificación: las órdenes, las facturas y las retenciones ya emitidas la citan, y una
 * retención al RUC equivocado no se corrige editando el maestro. Si el RUC estaba mal, se desactiva el proveedor y se crea otro.
 */
export class UpdateSupplierUseCase {
  constructor(private readonly gateway: UnitOfWorkGateway, private readonly clock: Clock) {}

  async execute(params: { organizationId: string; supplierId: string; input: Omit<SupplierInput, 'identificationType' | 'identification'> }): Promise<Supplier> {
    return inTransaction(this.gateway, async (uow) => {
      const current = await uow.suppliers.findById(params.organizationId, params.supplierId);
      if (!current) throw new SupplierNotFoundError();
      const normalized = normalizeSupplierInput({ ...params.input, identificationType: current.identificationType, identification: current.identification });
      const next: Supplier = {
        ...current,
        legalName: normalized.legalName,
        tradeName: normalized.tradeName,
        email: normalized.email,
        phone: normalized.phone,
        address: normalized.address,
        paymentTermDays: normalized.paymentTermDays,
        relatedParty: normalized.relatedParty,
        notes: normalized.notes,
        updatedAt: this.clock(),
      };
      await uow.suppliers.save(next);
      await uow.outbox.add(supplierUpsertedEvent(next));
      return next;
    });
  }
}

export class SetSupplierStatusUseCase {
  constructor(private readonly gateway: UnitOfWorkGateway, private readonly clock: Clock) {}

  async execute(params: { organizationId: string; supplierId: string; status: 'active' | 'inactive' }): Promise<Supplier> {
    return inTransaction(this.gateway, async (uow) => {
      const current = await uow.suppliers.findById(params.organizationId, params.supplierId);
      if (!current) throw new SupplierNotFoundError();
      if (current.status === params.status) return current;
      const next: Supplier = { ...current, status: params.status, updatedAt: this.clock() };
      await uow.suppliers.save(next);
      await uow.outbox.add(supplierUpsertedEvent(next, current.status));
      return next;
    });
  }
}

export class GetSupplierUseCase {
  constructor(private readonly repos: UnitOfWork) {}

  async execute(params: { organizationId: string; supplierId: string }): Promise<Supplier> {
    const supplier = await this.repos.suppliers.findById(params.organizationId, params.supplierId);
    if (!supplier) throw new SupplierNotFoundError();
    return supplier;
  }
}

export class ListSuppliersUseCase {
  constructor(private readonly repos: UnitOfWork) {}

  execute(params: { organizationId: string; filters: SupplierFilters }): Promise<Page<Supplier>> {
    return this.repos.suppliers.list(params.organizationId, params.filters);
  }
}
