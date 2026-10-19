import {
  ForbiddenError,
  OrderNotFoundError,
  SupplierInactiveError,
  SupplierNotFoundError,
  ValidationError,
  type ErrorDetail,
} from '../../domain/errors.js';
import { parseQuantity, quantityToString } from '../../domain/money.js';
import {
  approve,
  cancel,
  formatOrderNumber,
  newDraft,
  reject,
  reopenRejected,
  replaceDraft,
  requiresApproval,
  submit,
  type OrderHeaderInput,
  type OrderLineInput,
  type PurchaseOrder,
} from '../../domain/purchase-order.js';
import type { OrderFilters, Page, UnitOfWork } from '../../domain/repositories.js';
import {
  orderApprovedEvent,
  orderCancelledEvent,
  orderCreatedEvent,
  orderRejectedEvent,
  orderReopenedEvent,
  orderSubmittedEvent,
  orderUpdatedEvent,
} from '../events.js';
import type { Clock, ProductCatalogPort, TaxRatePort, UnitOfWorkGateway, WarehouseCatalogPort } from '../ports.js';
import { inTransaction } from './supplier-use-cases.js';

/** Lo que llega del cliente para una línea. Lo que no se manda se completa desde el catálogo. */
export interface LineRequest {
  productId: string;
  description?: string;
  /** Cantidad como texto: `"2.5"`. */
  quantity: string;
  unitCostCents: number;
  discountCents?: number;
  /** `undefined`: el IVA que trae el producto; `null`: sin impuesto; un id: esa tarifa. */
  taxRateId?: string | null;
}

export interface OrderRequest {
  supplierId: string;
  warehouseId: string;
  establishmentId?: string | null;
  currencyCode?: string;
  orderDate?: string;
  expectedDate?: string | null;
  paymentTermDays?: number;
  notes?: string | null;
  lines: LineRequest[];
}

export interface OrderDeps {
  gateway: UnitOfWorkGateway;
  /** Lecturas sin transacción: las consultas a los catálogos (HTTP) se hacen ANTES de abrir la transacción, nunca dentro. */
  reads: UnitOfWork;
  clock: Clock;
  products: ProductCatalogPort;
  taxRates: TaxRatePort;
  warehouses: WarehouseCatalogPort;
}

/** La fecha de hoy en Ecuador (UTC-5 todo el año): una orden hecha a las 20:00 no sale con la fecha de mañana. */
export function localToday(now: Date, timeZone = 'America/Guayaquil'): string {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(now);
  const get = (type: string) => parts.find((p) => p.type === type)!.value;
  return `${get('year')}-${get('month')}-${get('day')}`;
}

/** Valida el pedido contra los catálogos y lo traduce a datos de dominio. Se llama FUERA de la transacción de base de datos. */
async function resolveRequest(deps: OrderDeps, uow: UnitOfWork, organizationId: string, countryCode: string, request: OrderRequest): Promise<{ header: OrderHeaderInput; lines: OrderLineInput[] }> {
  const supplier = await uow.suppliers.findById(organizationId, request.supplierId);
  if (!supplier) throw new SupplierNotFoundError();
  if (supplier.status !== 'active') throw new SupplierInactiveError();

  const warehouse = await deps.warehouses.findById(organizationId, request.warehouseId);
  if (!warehouse) throw new ValidationError([{ field: 'warehouseId', message: 'La bodega no existe.' }]);
  if (warehouse.status !== 'active') throw new ValidationError([{ field: 'warehouseId', message: 'La bodega está inactiva.' }]);

  const problems: ErrorDetail[] = [];
  const lines: OrderLineInput[] = [];
  for (const [i, line] of request.lines.entries()) {
    const product = await deps.products.findById(organizationId, line.productId);
    if (!product) {
      problems.push({ field: `lines[${i}].productId`, message: 'El producto no existe.' });
      continue;
    }
    if (product.status !== 'active') {
      problems.push({ field: `lines[${i}].productId`, message: `El producto «${product.name}» está inactivo.` });
      continue;
    }

    let taxRateId: string | null;
    if (line.taxRateId === undefined) taxRateId = product.taxes.find((t) => t.kind === 'vat')?.taxRateId ?? null;
    else taxRateId = line.taxRateId;

    let taxPercent = '0.00';
    if (taxRateId) {
      const rate = await deps.taxRates.findRate(countryCode, taxRateId!);
      if (!rate) {
        problems.push({ field: `lines[${i}].taxRateId`, message: 'La tarifa de impuesto no existe.' });
        continue;
      }
      if (rate.kind !== 'vat') {
        problems.push({ field: `lines[${i}].taxRateId`, message: 'Solo se admite IVA en una orden de compra.' });
        continue;
      }
      taxPercent = Number(rate.percentage).toFixed(2);
    }

    lines.push({
      productId: product.id,
      sku: product.sku,
      description: line.description?.trim() || product.name,
      quantityMicros: parseQuantity(line.quantity, `lines[${i}].quantity`),
      unitCostCents: line.unitCostCents,
      discountCents: line.discountCents ?? 0,
      taxRateId,
      taxPercent,
    });
  }
  if (problems.length) throw new ValidationError(problems);

  return {
    header: {
      supplierId: supplier.id,
      supplier: { identificationType: supplier.identificationType, identification: supplier.identification, legalName: supplier.legalName },
      warehouseId: warehouse.id,
      establishmentId: request.establishmentId ?? null,
      currencyCode: (request.currencyCode ?? 'USD').toUpperCase(),
      orderDate: request.orderDate ?? localToday(deps.clock()),
      expectedDate: request.expectedDate ?? null,
      paymentTermDays: request.paymentTermDays ?? supplier.paymentTermDays,
      notes: request.notes?.trim() ? request.notes.trim().slice(0, 1000) : null,
    },
    lines,
  };
}

export class CreateOrderUseCase {
  constructor(private readonly deps: OrderDeps) {}

  async execute(params: { organizationId: string; userId: string; countryCode: string; request: OrderRequest }): Promise<PurchaseOrder> {
    const { header, lines } = await resolveRequest(this.deps, this.deps.reads, params.organizationId, params.countryCode, params.request);
    return inTransaction(this.deps.gateway, async (uow) => {
      const order = newDraft({ organizationId: params.organizationId, createdBy: params.userId, header, lines, now: this.deps.clock() });
      await uow.orders.save(order, null);
      await uow.outbox.add(orderCreatedEvent(order));
      return order;
    });
  }
}

export class UpdateOrderUseCase {
  constructor(private readonly deps: OrderDeps) {}

  async execute(params: { organizationId: string; orderId: string; countryCode: string; request: OrderRequest }): Promise<PurchaseOrder> {
    const { header, lines } = await resolveRequest(this.deps, this.deps.reads, params.organizationId, params.countryCode, params.request);
    return inTransaction(this.deps.gateway, async (uow) => {
      const current = await uow.orders.findById(params.organizationId, params.orderId, { lock: true });
      if (!current) throw new OrderNotFoundError();
      const next = replaceDraft(current, header, lines, this.deps.clock());
      await uow.orders.save(next, current.version);
      await uow.outbox.add(orderUpdatedEvent(next));
      return next;
    });
  }
}

export class SubmitOrderUseCase {
  constructor(private readonly gateway: UnitOfWorkGateway, private readonly clock: Clock) {}

  async execute(params: { organizationId: string; orderId: string }): Promise<PurchaseOrder> {
    return inTransaction(this.gateway, async (uow) => {
      const current = await uow.orders.findById(params.organizationId, params.orderId, { lock: true });
      if (!current) throw new OrderNotFoundError();
      const settings = await uow.settings.find(params.organizationId);
      const needsApproval = requiresApproval(current.totalCents, settings?.approvalThresholdCents ?? null);
      const now = this.clock();
      const year = Number(current.orderDate.slice(0, 4));
      const sequence = await uow.orders.nextSequence(params.organizationId, year);
      const next = submit(current, { number: formatOrderNumber(year, sequence), needsApproval, now });
      await uow.orders.save(next, current.version);
      await uow.outbox.add(orderSubmittedEvent(next, needsApproval));
      // Aprobada por política: nace aprobada y el compromiso se anuncia de una vez.
      if (!needsApproval) await uow.outbox.add(orderApprovedEvent(next));
      return next;
    });
  }
}

export class ApproveOrderUseCase {
  constructor(private readonly gateway: UnitOfWorkGateway, private readonly clock: Clock) {}

  async execute(params: { organizationId: string; orderId: string; userId: string }): Promise<PurchaseOrder> {
    return inTransaction(this.gateway, async (uow) => {
      const current = await uow.orders.findById(params.organizationId, params.orderId, { lock: true });
      if (!current) throw new OrderNotFoundError();
      const next = approve(current, params.userId, this.clock());
      await uow.orders.save(next, current.version);
      await uow.outbox.add(orderApprovedEvent(next));
      return next;
    });
  }
}

export class RejectOrderUseCase {
  constructor(private readonly gateway: UnitOfWorkGateway, private readonly clock: Clock) {}

  async execute(params: { organizationId: string; orderId: string; userId: string; reason: string }): Promise<PurchaseOrder> {
    return inTransaction(this.gateway, async (uow) => {
      const current = await uow.orders.findById(params.organizationId, params.orderId, { lock: true });
      if (!current) throw new OrderNotFoundError();
      const next = reject(current, params.userId, params.reason, this.clock());
      await uow.orders.save(next, current.version);
      await uow.outbox.add(orderRejectedEvent(next));
      return next;
    });
  }
}

export class ReopenOrderUseCase {
  constructor(private readonly gateway: UnitOfWorkGateway, private readonly clock: Clock) {}

  async execute(params: { organizationId: string; orderId: string }): Promise<PurchaseOrder> {
    return inTransaction(this.gateway, async (uow) => {
      const current = await uow.orders.findById(params.organizationId, params.orderId, { lock: true });
      if (!current) throw new OrderNotFoundError();
      const next = reopenRejected(current, this.clock());
      await uow.orders.save(next, current.version);
      await uow.outbox.add(orderReopenedEvent(next));
      return next;
    });
  }
}

export class CancelOrderUseCase {
  constructor(private readonly gateway: UnitOfWorkGateway, private readonly clock: Clock) {}

  /** `allowApproved`: cancelar una orden YA aprobada (un compromiso con el proveedor) es de quien tiene `purchase:cancel`. */
  async execute(params: { organizationId: string; orderId: string; userId: string; reason: string; allowApproved: boolean }): Promise<PurchaseOrder> {
    return inTransaction(this.gateway, async (uow) => {
      const current = await uow.orders.findById(params.organizationId, params.orderId, { lock: true });
      if (!current) throw new OrderNotFoundError();
      if (current.status === 'approved' && !params.allowApproved) throw new ForbiddenError('Cancelar una orden aprobada requiere el permiso de cancelar compras.');
      const next = cancel(current, params.userId, params.reason, this.clock());
      await uow.orders.save(next, current.version);
      await uow.outbox.add(orderCancelledEvent(next));
      return next;
    });
  }
}

export class GetOrderUseCase {
  constructor(private readonly repos: UnitOfWork) {}

  async execute(params: { organizationId: string; orderId: string }): Promise<PurchaseOrder> {
    const order = await this.repos.orders.findById(params.organizationId, params.orderId);
    if (!order) throw new OrderNotFoundError();
    return order;
  }
}

export class ListOrdersUseCase {
  constructor(private readonly repos: UnitOfWork) {}

  execute(params: { organizationId: string; filters: OrderFilters }): Promise<Page<PurchaseOrder>> {
    return this.repos.orders.list(params.organizationId, params.filters);
  }
}

export class GetOrderReceivingUseCase {
  constructor(private readonly repos: UnitOfWork) {}

  async execute(params: { organizationId: string; orderId: string }) {
    const order = await this.repos.orders.findById(params.organizationId, params.orderId);
    if (!order) throw new (await import('../../domain/errors.js')).OrderNotFoundError();
    const { computeLineReceiving } = await import('../../domain/purchase-order.js');
    // Lo ya facturado contra la orden (posted/blocked), para que el seguimiento muestre el saldo real
    // por facturar y no un 0 que ocultaría la doble facturación.
    const billedByLine = await this.repos.bills.billedByOrderLine(params.organizationId, order.id);
    return {
      orderId: order.id,
      orderNumber: order.number,
      status: order.status,
      // Los bigint no se pueden serializar a JSON: se entregan como texto (misma regla que el resto de cantidades).
      lines: computeLineReceiving(order, billedByLine).map((l) => ({
        lineId: l.lineId,
        ordered: quantityToString(l.ordered),
        received: quantityToString(l.received),
        pending: quantityToString(l.pending),
        billed: quantityToString(l.billed),
      })),
    };
  }
}

export class GetReceiptUseCase {
  constructor(private readonly repos: UnitOfWork) {}

  async execute(params: { organizationId: string; receiptId: string }) {
    const receipt = await this.repos.receipts.findById(params.organizationId, params.receiptId);
    if (!receipt) throw new (await import('../../domain/errors.js')).OrderNotFoundError();
    return receipt;
  }
}

export class ListReceiptsUseCase {
  constructor(private readonly repos: UnitOfWork) {}

  execute(params: { organizationId: string; filters: import('../../domain/repositories.js').ReceiptFilters }) {
    return this.repos.receipts.list(params.organizationId, params.filters);
  }
}
