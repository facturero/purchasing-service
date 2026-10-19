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

/** Puerto para llamar a fiscal-ecuador (retenciones, liquidaciones, etc.). */
export interface FiscalPort {
  /** Emite una retención (codDoc 07) sobre una factura de compra.
   *  Devuelve el documentId de la retención emitida. */
  issueWithholding(params: {
    organizationId: string;
    billId: string;
    idempotencyKey: string;
    // Datos para prellenar (el usuario elige códigos/porcentajes en UI)
    withholdingLines: Array<{
      taxCode: string;           // código de retención (ej. 01, 02, 03...)
      taxPercentage: string;     // porcentaje (ej. "1.00", "2.00", "10.00")
      baseCents: number;
      taxCents: number;
    }>;
  }): Promise<{ documentId: string; authorizationNumber: string; authorizedAt: string }>;
}
