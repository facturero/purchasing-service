import {
  BillNotEditableError,
  BillNotFoundError,
  BillNotPostableError,
  DuplicateSupplierDocumentError,
  ValidationError,
} from '../../domain/errors.js';
import {
  formatBillNumber,
  newBillDraft,
  overrideBill,
  postBill,
  replaceBillDraft,
  runThreeWayMatch,
  validateSupplierTotals,
  voidBill,
  type BillHeaderInput,
  type BillLineInput,
  type PurchaseBill,
} from '../../domain/purchase-bill.js';
import type { SupplierDocType } from '../../domain/purchase-bill.js';
import {
  billBlockedEvent,
  billCreatedEvent,
  billOverriddenEvent,
  billPostedEvent,
  billUpdatedEvent,
  billVoidedEvent,
} from '../events.js';
import type { ProductCatalogPort, UnitOfWorkGateway } from '../ports.js';
import { inTransaction } from './supplier-use-cases.js';

export interface CreateBillInput {
  supplierId: string;
  purchaseOrderId?: string | null;
  docType: SupplierDocType;
  establishment: string;
  emissionPoint: string;
  sequential: string;
  authorizationNumber?: string | null;
  issueDate: string;
  dueDate: string;
  currencyCode: string;
  notes?: string | null;
  lines: BillLineInput[];
  supplierTotalCents?: number;
}

export interface BillDeps {
  gateway: UnitOfWorkGateway;
  reads: import('../../domain/repositories.js').UnitOfWork;
  clock: () => Date;
  /** Para saber si el producto de cada línea lleva stock (inventario) o no (gasto). */
  products: ProductCatalogPort;
}

/**
 * Marca cada línea con si su producto lleva stock, consultando el catálogo FUERA de la transacción (como las órdenes). Una línea sin
 * producto es gasto. Un producto que no existe es un 422; un catálogo caído es un 502: nunca se da por «gasto» lo que no se pudo consultar.
 */
async function withStockFlags(products: ProductCatalogPort, organizationId: string, lines: BillLineInput[]): Promise<BillLineInput[]> {
  const cache = new Map<string, boolean>();
  const out: BillLineInput[] = [];
  for (const [i, line] of lines.entries()) {
    if (!line.productId) {
      out.push({ ...line, tracksStock: false });
      continue;
    }
    let tracks = cache.get(line.productId);
    if (tracks === undefined) {
      const product = await products.findById(organizationId, line.productId);
      if (!product) throw new ValidationError([{ field: `lines[${i}].productId`, message: 'El producto no existe.' }]);
      tracks = product.tracksStock;
      cache.set(line.productId, tracks);
    }
    out.push({ ...line, tracksStock: tracks });
  }
  return out;
}

export class CreateBillUseCase {
  constructor(private readonly deps: BillDeps) {}

  async execute(params: { organizationId: string; userId: string; input: CreateBillInput }): Promise<PurchaseBill> {
    const { organizationId, userId, input } = params;

    // Validaciones previas (fuera de transacción)
    const supplier = await this.deps.reads.suppliers.findById(organizationId, input.supplierId);
    if (!supplier) throw new ValidationError([{ field: 'supplierId', message: 'El proveedor no existe.' }]);
    if (supplier.status !== 'active') throw new ValidationError([{ field: 'supplierId', message: 'El proveedor está inactivo.' }]);

    const header: BillHeaderInput = {
      supplierId: supplier.id,
      supplier: { identificationType: supplier.identificationType, identification: supplier.identification, legalName: supplier.legalName },
      purchaseOrderId: input.purchaseOrderId ?? null,
      docType: input.docType,
      establishment: input.establishment,
      emissionPoint: input.emissionPoint,
      sequential: input.sequential,
      authorizationNumber: input.authorizationNumber ?? null,
      issueDate: input.issueDate,
      dueDate: input.dueDate,
      currencyCode: input.currencyCode,
      // Igual que la orden: se recorta y se limita a 1000; vacío es `null` (no cadena hueca).
      notes: input.notes?.trim() ? input.notes.trim().slice(0, 1000) : null,
    };

    const lines = await withStockFlags(this.deps.products, organizationId, input.lines);

    return inTransaction(this.deps.gateway, async (uow) => {
      // Duplicado por documento del proveedor: con o sin orden. Sin esta comprobación la base lo rechazaba igual pero con un
      // 409 genérico (CONFLICT) en vez de DUPLICATE_SUPPLIER_DOCUMENT, que es el que la pantalla sabe explicar.
      const existing = await uow.bills.findBySupplierDocument(organizationId, input.supplierId, input.docType, input.establishment, input.emissionPoint, input.sequential);
      if (existing) throw new DuplicateSupplierDocumentError();
      // Verificar duplicado por autorización
      if (input.authorizationNumber) {
        const existingAuth = await uow.bills.findByAuthorization(organizationId, input.authorizationNumber);
        if (existingAuth) throw new DuplicateSupplierDocumentError('Ya existe una factura con esa autorización.');
      }

      const bill = newBillDraft({ organizationId, createdBy: userId, header, lines, now: this.deps.clock() });

      // Número interno FC-AAAA-NNNNNN: se quema aquí dentro de la transacción, así un fallo posterior
      // no lo deja asignado a una factura que no existe.
      const year = Number(input.issueDate.slice(0, 4));
      bill.internalNumber = formatBillNumber(year, await uow.bills.nextBillSequence(organizationId, year));

      // Validar totales del proveedor si se proporcionaron
      if (input.supplierTotalCents !== undefined) {
        validateSupplierTotals(input.supplierTotalCents, bill.totalCents);
        bill.supplierTotalCents = input.supplierTotalCents;
      }

      await uow.bills.save(bill);
      await uow.bills.saveLines(bill.id, organizationId, bill.lines);
      await uow.outbox.add(billCreatedEvent(bill));
      return bill;
    });
  }
}

export class UpdateBillUseCase {
  constructor(private readonly deps: BillDeps) {}

  async execute(params: { organizationId: string; billId: string; input: CreateBillInput }): Promise<PurchaseBill> {
    const { organizationId, billId, input } = params;

    const supplier = await this.deps.reads.suppliers.findById(organizationId, input.supplierId);
    if (!supplier) throw new ValidationError([{ field: 'supplierId', message: 'El proveedor no existe.' }]);

    const header: BillHeaderInput = {
      supplierId: supplier.id,
      supplier: { identificationType: supplier.identificationType, identification: supplier.identification, legalName: supplier.legalName },
      purchaseOrderId: input.purchaseOrderId ?? null,
      docType: input.docType,
      establishment: input.establishment,
      emissionPoint: input.emissionPoint,
      sequential: input.sequential,
      authorizationNumber: input.authorizationNumber ?? null,
      issueDate: input.issueDate,
      dueDate: input.dueDate,
      currencyCode: input.currencyCode,
      // Igual que la orden: se recorta y se limita a 1000; vacío es `null` (no cadena hueca).
      notes: input.notes?.trim() ? input.notes.trim().slice(0, 1000) : null,
    };

    const lines = await withStockFlags(this.deps.products, organizationId, input.lines);

    return inTransaction(this.deps.gateway, async (uow) => {
      const current = await uow.bills.findById(organizationId, billId);
      if (!current) throw new BillNotFoundError();

      if (current.status !== 'draft' && current.status !== 'blocked') throw new BillNotEditableError();

      // Verificar duplicado (excluyendo la actual)
      const existing = await uow.bills.findBySupplierDocument(organizationId, input.supplierId, input.docType, input.establishment, input.emissionPoint, input.sequential);
      if (existing && existing.id !== billId) throw new DuplicateSupplierDocumentError();

      if (input.authorizationNumber) {
        const existingAuth = await uow.bills.findByAuthorization(organizationId, input.authorizationNumber);
        if (existingAuth && existingAuth.id !== billId) throw new DuplicateSupplierDocumentError('Ya existe una factura con esa autorización.');
      }

      const next = replaceBillDraft(current, header, lines, this.deps.clock());

      if (input.supplierTotalCents !== undefined) {
        validateSupplierTotals(input.supplierTotalCents, next.totalCents);
        next.supplierTotalCents = input.supplierTotalCents;
      }

      await uow.bills.save(next, current.version);
      await uow.bills.saveLines(next.id, organizationId, next.lines);
      await uow.outbox.add(billUpdatedEvent(next));
      return next;
    });
  }
}

export class GetBillUseCase {
  constructor(private readonly repos: import('../../domain/repositories.js').UnitOfWork) {}

  async execute(params: { organizationId: string; billId: string }): Promise<PurchaseBill> {
    const bill = await this.repos.bills.findById(params.organizationId, params.billId);
    if (!bill) throw new BillNotFoundError();
    return bill;
  }
}

export class ListBillsUseCase {
  constructor(private readonly repos: import('../../domain/repositories.js').UnitOfWork) {}

  execute(params: { organizationId: string; filters: import('../../domain/repositories.js').BillFilters }) {
    return this.repos.bills.list(params.organizationId, params.filters);
  }
}

export class PostBillUseCase {
  constructor(private readonly gateway: UnitOfWorkGateway, private readonly clock: () => Date) {}

  async execute(params: { organizationId: string; billId: string }): Promise<PurchaseBill> {
    const { organizationId, billId } = params;
    const now = this.clock();

    // READ COMMITTED: la suma de lo ya facturado se lee después de esperar el bloqueo de la orden y tiene que ver lo que
    // confirmó la transacción anterior (ver `billedByOrderLine`).
    return inTransaction(this.gateway, async (uow) => {
      const bill = await uow.bills.findById(organizationId, billId, { lock: true });
      if (!bill) throw new BillNotFoundError();

      if (bill.status !== 'draft') throw new BillNotPostableError();

      // Si no tiene orden, matchStatus = not_applicable y pasa directo a posted
      if (!bill.purchaseOrderId) {
        const posted = postBill(bill, { matchStatus: 'not_applicable', matchReasons: [], linesWithVariance: [] }, now);
        await uow.bills.save(posted, bill.version);
        await uow.outbox.add(billPostedEvent(posted));
        return posted;
      }

      // Bloquear la orden para concurrencia
      const order = await uow.orders.findById(organizationId, bill.purchaseOrderId, { lock: true });
      if (!order) throw new ValidationError([{ field: 'purchaseOrderId', message: 'La orden asociada no existe.' }]);

      const settings = await uow.settings.find(organizationId);
      const priceToleranceBp = settings?.priceToleranceBp ?? 0;
      const qtyToleranceBp = settings?.qtyToleranceBp ?? 0;

      // Construir mapa de líneas de la orden con recibido
      const orderLineMap = new Map(order.lines.map(l => [l.id, { quantityMicros: l.quantityMicros, receivedMicros: l.receivedMicros, unitCostCents: l.unitCostCents }]));

      // Lo ya facturado contra la orden (posted/blocked): la invariante es acumulada, así que dos
      // facturas del 100% de lo recibido no pueden pasar las dos. La orden está bloqueada arriba,
      // de modo que este cálculo no compite con otra contabilización de la misma orden.
      const billedSoFarByLine = await uow.bills.billedByOrderLine(organizationId, bill.purchaseOrderId, bill.id);

      const matchResult = runThreeWayMatch({
        bill,
        orderLines: orderLineMap,
        billedSoFarByLine,
        priceToleranceBp,
        qtyToleranceBp,
      });

      const posted = postBill(bill, matchResult, now);
      await uow.bills.save(posted, bill.version);
      // Persiste las líneas con la variación de precio que asignó la conciliación.
      await uow.bills.saveLines(posted.id, organizationId, posted.lines);
      // Una factura que no pasa la conciliación sale `blocked`, no `posted`: el evento debe decirlo.
      await uow.outbox.add(posted.status === 'blocked' ? billBlockedEvent(posted) : billPostedEvent(posted));
      return posted;
    }, { readCommitted: true });
  }
}

export class OverrideBillUseCase {
  constructor(private readonly gateway: UnitOfWorkGateway, private readonly clock: () => Date) {}

  async execute(params: { organizationId: string; billId: string; userId: string; reason: string }): Promise<PurchaseBill> {
    const { organizationId, billId, userId, reason } = params;
    const now = this.clock();

    return inTransaction(this.gateway, async (uow) => {
      const bill = await uow.bills.findById(organizationId, billId, { lock: true });
      if (!bill) throw new BillNotFoundError();

      const overridden = overrideBill(bill, userId, reason, now);
      await uow.bills.save(overridden, bill.version);
      await uow.outbox.add(billOverriddenEvent(overridden));
      // La excepción convierte una factura bloqueada en CONTABILIZADA: contabilidad solo asienta `purchasing.bill.posted`, así que sin
      // este evento la factura quedaba «posted» sin asiento (y su anulación no tenía nada que reversar). Apareció al probar la
      // pantalla completa: los scripts solo miraban la bitácora.
      await uow.outbox.add(billPostedEvent(overridden));
      return overridden;
    });
  }
}

export class VoidBillUseCase {
  constructor(private readonly gateway: UnitOfWorkGateway, private readonly clock: () => Date) {}

  async execute(params: { organizationId: string; billId: string; userId: string; reason: string }): Promise<PurchaseBill> {
    const { organizationId, billId, userId, reason } = params;
    const now = this.clock();

    return inTransaction(this.gateway, async (uow) => {
      const bill = await uow.bills.findById(organizationId, billId, { lock: true });
      if (!bill) throw new BillNotFoundError();

      const voided = voidBill(bill, userId, reason, now);
      await uow.bills.save(voided, bill.version);
      await uow.outbox.add(billVoidedEvent(voided));
      return voided;
    });
  }
}