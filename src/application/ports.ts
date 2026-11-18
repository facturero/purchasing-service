import type { UnitOfWork } from '../domain/repositories.js';
import type { SriFetchResult } from '../domain/received-document.js';

export type { SriFetchResult };

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


/** Consulta de autorización del SRI (web service sin sesión). Si el servicio no responde lanza `SriUnavailableError`. */
export interface SriAuthorizationPort {
  fetchByAccessKey(accessKey: string): Promise<SriFetchResult>;
}

export interface SriPortalConfigRecord {
  organizationId: string;
  username: string | null;
  passwordEnc: string | null;
  enabled: boolean;
  lastRunAt: Date | null;
  lastStatus: string | null;
  lastError: string | null;
  updatedAt: Date;
  updatedBy: string | null;
  loginFailCount: number;
  loginBlockedUntil: Date | null;
  lastLoginTestAt: Date | null;
  lastLoginTestOk: boolean;
  blockedBySri: boolean;
  blockedReason: string | null;
  /** Próximo periodo a sincronizar (`YYYY-MM`); `null` = empezar por el mes actual. */
  syncCursorPeriod: string | null;
}

export interface SriPortalConfigRepository {
  get(organizationId: string): Promise<SriPortalConfigRecord | null>;
  upsert(organizationId: string, patch: Partial<Omit<SriPortalConfigRecord, 'organizationId'>> & { updatedBy?: string | null }): Promise<SriPortalConfigRecord>;
  incrementFail(organizationId: string, reason?: string): Promise<SriPortalConfigRecord>;
  markBlocked(organizationId: string, reason: string): Promise<SriPortalConfigRecord>;
  resetOnSuccess(organizationId: string, username: string, passwordEnc: string, updatedBy?: string | null): Promise<SriPortalConfigRecord>;
  /** Corrida terminada bien: limpia contadores de fallo SIN tocar `enabled` (lo decide el usuario). */
  markRunOk(organizationId: string): Promise<SriPortalConfigRecord>;
  /** Guarda el próximo periodo a sincronizar; `null` reinicia el recorrido por el mes actual. */
  setSyncCursor(organizationId: string, period: string | null): Promise<void>;
}

export interface CaptchaSolveRequest {
  type: 'recaptcha_v2' | 'recaptcha_v2_enterprise';
  siteKey?: string;
  pageUrl?: string;
  image?: string;
  /** Widget `size: 'invisible'` (el token lo produce `execute`, no hay casilla que marcar). */
  invisible?: boolean;
  /** Nombre de la acción de reCAPTCHA Enterprise, p. ej. `consulta_cel_recibidos`. */
  action?: string;
}

export interface CaptchaSolver {
  solve(req: CaptchaSolveRequest): Promise<string>;
}

export interface SriPortalPeriodResult {
  /**
   * Texto TSV con las mismas columnas que el «Descargar reporte» del portal, armado
   * desde la tabla de resultados (que es lo que hacía el repo viejo). Un solo captcha
   * por periodo: pulsar «Descargar reporte» dispara otra consulta y duplica el riesgo.
   */
  reportText: string;
  /** Filas leídas de la tabla (todas las páginas). */
  rowCount: number;
  /** Clave de acceso → XML descargado del portal. */
  xmls: Map<string, string>;
}

export interface SriPortalPort {
  isLoggedIn(): Promise<boolean>;
  login(username: string, password: string): Promise<void>;
  /** Consulta un periodo (año/mes, día = Todos), lee la tabla completa y baja los XML. */
  syncPeriod(params: { year: number; month: number; receiverId: string }): Promise<SriPortalPeriodResult>;
  close(): Promise<void>;
}

