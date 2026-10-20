import type { UnitOfWork } from '../domain/repositories.js';

/** UnitOfWork que además sabe cerrar su transacción. Los casos de uso de escritura lo obtienen del gateway y hacen commit explícito. */
export interface WriteUnitOfWork extends UnitOfWork {
  commit(): Promise<void>;
  rollback(): Promise<void>;
}

/** Abre unidades de trabajo de escritura. La implementación real abre una transacción de Sequelize; en tests, repos en memoria. */
export interface UnitOfWorkGateway {
  /**
   * `readCommitted`: cada sentencia ve lo último confirmado en vez de la instantánea del primer SELECT. Hace falta cuando la
   * transacción lee una suma DESPUÉS de esperar un bloqueo (la conciliación de facturas espera el bloqueo de la orden): con
   * REPEATABLE READ esa suma sale de una instantánea anterior a la espera y no ve lo que confirmó quien tenía el bloqueo.
   */
  begin(options?: { readCommitted?: boolean }): Promise<WriteUnitOfWork>;
}

export type Clock = () => Date;

export interface ProductInfo {
  id: string;
  name: string;
  sku: string | null;
  status: string;
  /** Si el producto lleva control de stock. Decide a dónde va su compra: inventario (sí) o gasto (no: un servicio, un suministro). */
  tracksStock: boolean;
  /** Tarifas de impuesto que el producto trae asignadas (la de IVA se propone al armar la línea). */
  taxes: { taxRateId: string; kind: string }[];
}

/** Catálogo de productos (product-service). Si no responde se lanza `CatalogUnavailableError`: nunca se inventa un producto. */
export interface ProductCatalogPort {
  findById(organizationId: string, productId: string): Promise<ProductInfo | null>;
}

export interface TaxRateInfo {
  id: string;
  /** `"15.00"`. */
  percentage: string;
  kind: string;
}

/** Tarifas de impuesto (tax-service). */
export interface TaxRatePort {
  findRate(countryCode: string, taxRateId: string): Promise<TaxRateInfo | null>;
}

export interface WarehouseInfo {
  id: string;
  name: string;
  status: string;
}

/** Bodegas (inventory-service). */
export interface WarehouseCatalogPort {
  findById(organizationId: string, warehouseId: string): Promise<WarehouseInfo | null>;
}

