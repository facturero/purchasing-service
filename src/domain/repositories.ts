import type { OrderStatus, PurchaseOrder } from './purchase-order.js';
import type { Supplier, SupplierStatus } from './supplier.js';

export interface DomainEvent {
  eventId: string;
  aggregateType: string;
  aggregateId: string;
  type: string;
  payload: Record<string, unknown>;
  occurredAt: Date;
}

export interface Page<T> {
  items: T[];
  total: number;
  page: number;
  pageSize: number;
}

export interface PurchasingSettings {
  organizationId: string;
  /** Las órdenes de este monto (centavos) o más piden aprobación. `null`: nunca piden aprobación. */
  approvalThresholdCents: number | null;
  /** Bodega que se propone al preparar una orden. */
  defaultWarehouseId: string | null;
  updatedAt: Date;
}

export interface SupplierFilters {
  q?: string;
  status?: SupplierStatus;
  page: number;
  pageSize: number;
}

export interface OrderFilters {
  status?: OrderStatus;
  supplierId?: string;
  /** Rango de fechas de la orden, `AAAA-MM-DD`. */
  from?: string;
  to?: string;
  /** Busca en el número y en el nombre del proveedor. */
  q?: string;
  page: number;
  pageSize: number;
}

export interface SupplierRepository {
  findById(organizationId: string, id: string): Promise<Supplier | null>;
  findByIdentification(organizationId: string, identification: string): Promise<Supplier | null>;
  list(organizationId: string, filters: SupplierFilters): Promise<Page<Supplier>>;
  /** Alta o cambio, por clave primaria (nunca `upsert`: un UNIQUE ajeno pisaría la fila de otro). */
  save(supplier: Supplier): Promise<void>;
}

export interface OrderRepository {
  /** Con `lock`, bloquea la fila y sus líneas hasta el final de la transacción: las decisiones (aprobar, cancelar) se toman sobre lo último. */
  findById(organizationId: string, id: string, options?: { lock?: boolean }): Promise<PurchaseOrder | null>;
  list(organizationId: string, filters: OrderFilters): Promise<Page<PurchaseOrder>>;
  /**
   * Guarda la orden con sus líneas. `expectedVersion` es la versión que se leyó (`null` si es un alta): si la fila ya cambió, lanza
   * `ConcurrentUpdateError` en vez de pisar el cambio de otra persona.
   */
  save(order: PurchaseOrder, expectedVersion: number | null): Promise<void>;
  /** Siguiente secuencial de la serie `(organización, año)`. El UPDATE del contador va ANTES que cualquier INSERT (ver el guardián de persistencia). */
  nextSequence(organizationId: string, year: number): Promise<number>;
}

export interface SettingsRepository {
  find(organizationId: string): Promise<PurchasingSettings | null>;
  save(settings: PurchasingSettings): Promise<void>;
}

export interface OutboxRepository {
  add(event: DomainEvent): Promise<void>;
}

export interface UnitOfWork {
  suppliers: SupplierRepository;
  orders: OrderRepository;
  settings: SettingsRepository;
  outbox: OutboxRepository;
}
