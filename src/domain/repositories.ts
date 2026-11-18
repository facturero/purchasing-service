import type { OrderStatus, PurchaseOrder } from './purchase-order.js';
import type { BillLine, BillStatus, MatchStatus, PurchaseBill, SupplierDocType } from './purchase-bill.js';
import type { Supplier, SupplierStatus } from './supplier.js';
import type { ReceivedDocumentStatus, ReceivedSriDocument } from './received-document.js';

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
  /** Tolerancia de sobre-recepción en puntos básicos (0-5000). C.2.4. */
  overReceiptToleranceBp: number;
  /** Tolerancia de precio en conciliación (puntos básicos). D.2.3. */
  priceToleranceBp: number;
  /** Tolerancia de cantidad en conciliación (puntos básicos). D.2.3. */
  qtyToleranceBp: number;
  updatedAt: Date;
}

export interface BillFilters {
  supplierId?: string;
  status?: BillStatus;
  matchStatus?: MatchStatus;
  purchaseOrderId?: string;
  from?: string;
  to?: string;
  q?: string;
  page: number;
  pageSize: number;
}

export interface BillRepository {
  /** Con `lock`, bloquea la fila hasta el final de la transacción (post/override/void/retención). */
  findById(organizationId: string, id: string, options?: { lock?: boolean }): Promise<PurchaseBill | null>;
  findBySupplierDocument(organizationId: string, supplierId: string, docType: SupplierDocType, establishment: string, emissionPoint: string, sequential: string): Promise<PurchaseBill | null>;
  findByAuthorization(organizationId: string, authorizationNumber: string): Promise<PurchaseBill | null>;
  /**
   * La factura que cita un comprobante de retención. Fiscal no conoce nuestro id de factura: solo el RUC del proveedor y el número
   * del documento sustento (`001-002-000000123`), que es justo lo que identifica la factura del proveedor.
   */
  findBySupplierIdentificationDocument(
    organizationId: string,
    supplierIdentification: string,
    docType: SupplierDocType,
    establishment: string,
    emissionPoint: string,
    sequential: string,
  ): Promise<PurchaseBill | null>;
  list(organizationId: string, filters: BillFilters): Promise<Page<PurchaseBill>>;
  /**
   * Alta (`expectedVersion` omitido) o cambio con optimistic locking: si la fila ya cambió desde que se
   * leyó, lanza `ConcurrentUpdateError` en vez de pisar el cambio de otra persona.
   */
  save(bill: PurchaseBill, expectedVersion?: number | null): Promise<void>;
  saveLines(billId: string, organizationId: string, lines: BillLine[]): Promise<void>;
  /**
   * Cantidad ya facturada (micros) por línea de orden, sumando las facturas `posted` y `blocked`
   * de esa orden (`excludeBillId` deja fuera la que se está contabilizando). Es la base de la
   * invariante "lo facturado nunca supera lo recibido", que es acumulada entre facturas.
   */
  billedByOrderLine(organizationId: string, purchaseOrderId: string, excludeBillId?: string): Promise<Map<string, bigint>>;
  /** Siguiente secuencial para FC-(organización, año). */
  nextBillSequence(organizationId: string, year: number): Promise<number>;
}

export interface GoodsReceipt {
  id: string;
  organizationId: string;
  number: string;
  purchaseOrderId: string;
  supplierId: string;
  warehouseId: string;
  receiptDate: string; // AAAA-MM-DD
  supplierDeliveryRef: string | null;
  notes: string | null;
  createdBy: string;
  createdAt: Date;
  /** Detalle recibido. En listados puede venir vacío; en detalle se carga. */
  lines?: GoodsReceiptLine[];
}

export interface GoodsReceiptLine {
  id: string;
  receiptId: string;
  orderLineId: string;
  productId: string;
  quantityMicros: bigint;
  unitCostCents: number;
  currencyCode: string;
}

export interface ReceiptFilters {
  purchaseOrderId?: string;
  supplierId?: string;
  from?: string;
  to?: string;
  q?: string;
  page: number;
  pageSize: number;
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

export interface ReceiptRepository {
  findById(organizationId: string, id: string): Promise<GoodsReceipt | null>;
  findByNumber(organizationId: string, number: string): Promise<GoodsReceipt | null>;
  list(organizationId: string, filters: ReceiptFilters): Promise<Page<GoodsReceipt>>;
  save(receipt: GoodsReceipt): Promise<void>;
  saveLines(lines: GoodsReceiptLine[]): Promise<void>;
  /** Siguiente secuencial para RM-(organización, año). */
  nextReceiptSequence(organizationId: string, year: number): Promise<number>;
}

export interface SettingsRepository {
  find(organizationId: string): Promise<PurchasingSettings | null>;
  save(settings: PurchasingSettings): Promise<void>;
}

export interface ReceivedDocumentFilters {
  status?: ReceivedDocumentStatus;
  issuerRuc?: string;
  /** Fecha de emisión, `AAAA-MM-DD`. */
  from?: string;
  to?: string;
  /** Busca en la razón social, el número y la clave de acceso. */
  q?: string;
  page: number;
  pageSize: number;
}

export interface ReceivedDocumentRepository {
  findById(organizationId: string, id: string, options?: { lock?: boolean }): Promise<ReceivedSriDocument | null>;
  findByAccessKey(organizationId: string, accessKey: string, options?: { lock?: boolean }): Promise<ReceivedSriDocument | null>;
  /** De estas claves, las que la organización ya tiene: la base del «no repetir lo ya bajado». */
  findExistingKeys(organizationId: string, accessKeys: string[]): Promise<Set<string>>;
  list(organizationId: string, filters: ReceivedDocumentFilters): Promise<Page<ReceivedSriDocument>>;
  /** Los pendientes cuyo próximo intento ya llegó, de TODAS las organizaciones (lo usa el trabajo programado, no una petición). */
  listDue(now: Date, limit: number): Promise<ReceivedSriDocument[]>;
  /** Cuántos hay por estado: lo que la pantalla muestra como «al día» o «faltan N». */
  countByStatus(organizationId: string): Promise<Record<ReceivedDocumentStatus, number>>;
  /** Fecha de emisión más reciente que ya se tiene: «el último bajado», para saber desde dónde seguir. */
  latestIssueDate(organizationId: string): Promise<string | null>;
  /** Alta de varios; una clave repetida (carrera entre dos importaciones) se ignora, no tumba el lote. */
  insertMany(documents: ReceivedSriDocument[]): Promise<void>;
  /** Cambio por clave primaria. */
  save(document: ReceivedSriDocument): Promise<void>;
}

export interface OutboxRepository {
  add(event: DomainEvent): Promise<void>;
}

export interface UnitOfWork {
  suppliers: SupplierRepository;
  orders: OrderRepository;
  receipts: ReceiptRepository;
  bills: BillRepository;
  settings: SettingsRepository;
  receivedDocuments: ReceivedDocumentRepository;
  outbox: OutboxRepository;
}
