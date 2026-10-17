import { randomUUID } from 'node:crypto';
import type {
  ProductCatalogPort,
  ProductInfo,
  TaxRatePort,
  UnitOfWorkGateway,
  WarehouseCatalogPort,
  WriteUnitOfWork,
} from '../application/ports.js';
import {
  ApproveOrderUseCase,
  CancelOrderUseCase,
  CreateOrderUseCase,
  GetOrderUseCase,
  ListOrdersUseCase,
  RejectOrderUseCase,
  ReopenOrderUseCase,
  SubmitOrderUseCase,
  UpdateOrderUseCase,
  type LineRequest,
  type OrderDeps,
  type OrderRequest,
} from '../application/use-cases/order-use-cases.js';
import { GetSettingsUseCase, UpdateSettingsUseCase } from '../application/use-cases/settings-use-cases.js';
import {
  CreateSupplierUseCase,
  GetSupplierUseCase,
  ListSuppliersUseCase,
  SetSupplierStatusUseCase,
  UpdateSupplierUseCase,
} from '../application/use-cases/supplier-use-cases.js';
import { CatalogUnavailableError, ConcurrentUpdateError } from '../domain/errors.js';
import type { PurchaseOrder } from '../domain/purchase-order.js';
import type {
  DomainEvent,
  OrderRepository,
  Page,
  PurchasingSettings,
  SettingsRepository,
  SupplierRepository,
  UnitOfWork,
} from '../domain/repositories.js';
import type { Supplier } from '../domain/supplier.js';
import { createApp } from '../interface/http/app.js';
import type { AppDependencies } from '../interface/http/routes.js';

export const ORG_A = '11111111-1111-4111-8111-111111111111';
export const ORG_B = '22222222-2222-4222-8222-222222222222';
export const USER_1 = '33333333-3333-4333-8333-333333333333';
export const USER_2 = '44444444-4444-4444-8444-444444444444';
export const WAREHOUSE = '55555555-5555-4555-8555-555555555555';
export const PRODUCT_1 = '66666666-6666-4666-8666-666666666666';
export const PRODUCT_2 = '77777777-7777-4777-8777-777777777777';
export const IVA15 = '88888888-8888-4888-8888-888888888888';
export const IVA0 = '99999999-9999-4999-8999-999999999999';

const clone = <T>(value: T): T => structuredClone(value);

interface Snapshot {
  suppliers: Map<string, Supplier>;
  orders: Map<string, PurchaseOrder>;
  settings: Map<string, PurchasingSettings>;
  sequences: Map<string, number>;
  outboxLength: number;
}

/** Unit of Work en memoria: todos los repos comparten un store y `begin()/rollback()` simulan una transacción por instantánea. */
export class InMemoryStore implements UnitOfWorkGateway, UnitOfWork {
  supplierMap = new Map<string, Supplier>();
  orderMap = new Map<string, PurchaseOrder>();
  settingsMap = new Map<string, PurchasingSettings>();
  sequences = new Map<string, number>();
  readonly outboxEvents: DomainEvent[] = [];
  private stack: Snapshot[] = [];

  readonly suppliers: SupplierRepository = {
    findById: async (org, id) => {
      const s = this.supplierMap.get(id);
      return s && s.organizationId === org ? clone(s) : null;
    },
    findByIdentification: async (org, identification) => {
      const s = [...this.supplierMap.values()].find((x) => x.organizationId === org && x.identification === identification);
      return s ? clone(s) : null;
    },
    list: async (org, f) => {
      const q = f.q?.toLowerCase();
      const all = [...this.supplierMap.values()]
        .filter((s) => s.organizationId === org && (!f.status || s.status === f.status))
        .filter((s) => !q || s.legalName.toLowerCase().includes(q) || s.identification.includes(q))
        .sort((a, b) => a.legalName.localeCompare(b.legalName));
      return paginate(all.map(clone), f.page, f.pageSize);
    },
    save: async (s) => {
      this.supplierMap.set(s.id, clone(s));
    },
  };

  readonly orders: OrderRepository = {
    findById: async (org, id) => {
      const o = this.orderMap.get(id);
      return o && o.organizationId === org ? clone(o) : null;
    },
    list: async (org, f) => {
      const q = f.q?.toLowerCase();
      const all = [...this.orderMap.values()]
        .filter((o) => o.organizationId === org)
        .filter((o) => !f.status || o.status === f.status)
        .filter((o) => !f.supplierId || o.supplierId === f.supplierId)
        .filter((o) => !f.from || o.orderDate >= f.from)
        .filter((o) => !f.to || o.orderDate <= f.to)
        .filter((o) => !q || (o.number ?? '').toLowerCase().includes(q) || o.supplier.legalName.toLowerCase().includes(q))
        .sort((a, b) => (a.orderDate < b.orderDate ? 1 : -1));
      return paginate(all.map(clone), f.page, f.pageSize);
    },
    save: async (o, expectedVersion) => {
      const existing = this.orderMap.get(o.id);
      if (expectedVersion === null ? Boolean(existing) : !existing || existing.version !== expectedVersion) throw new ConcurrentUpdateError();
      this.orderMap.set(o.id, clone(o));
    },
    nextSequence: async (org, year) => {
      const key = `${org}|${year}`;
      const next = (this.sequences.get(key) ?? 0) + 1;
      this.sequences.set(key, next);
      return next;
    },
  };

  readonly settings: SettingsRepository = {
    find: async (org) => {
      const s = this.settingsMap.get(org);
      return s ? clone(s) : null;
    },
    save: async (s) => {
      this.settingsMap.set(s.organizationId, clone(s));
    },
  };

  readonly outbox = {
    add: async (event: DomainEvent) => {
      this.outboxEvents.push(event);
    },
  };

  async begin(): Promise<WriteUnitOfWork> {
    this.stack.push({
      suppliers: clone(this.supplierMap),
      orders: clone(this.orderMap),
      settings: clone(this.settingsMap),
      sequences: clone(this.sequences),
      outboxLength: this.outboxEvents.length,
    });
    return {
      suppliers: this.suppliers,
      orders: this.orders,
      settings: this.settings,
      outbox: this.outbox,
      commit: async () => {
        this.stack.pop();
      },
      rollback: async () => {
        const snap = this.stack.pop();
        if (!snap) return;
        this.supplierMap = snap.suppliers;
        this.orderMap = snap.orders;
        this.settingsMap = snap.settings;
        this.sequences = snap.sequences;
        this.outboxEvents.length = snap.outboxLength;
      },
    };
  }

  eventTypes(): string[] {
    return this.outboxEvents.map((e) => e.type);
  }
}

function paginate<T>(items: T[], page: number, pageSize: number): Page<T> {
  return { items: items.slice((page - 1) * pageSize, page * pageSize), total: items.length, page, pageSize };
}

// ── Catálogos de mentira ────────────────────────────────────────────────────

export class FakeCatalogs implements ProductCatalogPort, TaxRatePort, WarehouseCatalogPort {
  down = false;
  products = new Map<string, ProductInfo>([
    [PRODUCT_1, { id: PRODUCT_1, name: 'Papel bond A4', sku: 'PAP-A4', status: 'active', taxes: [{ taxRateId: IVA15, kind: 'vat' }] }],
    [PRODUCT_2, { id: PRODUCT_2, name: 'Servicio de limpieza', sku: null, status: 'active', taxes: [{ taxRateId: IVA0, kind: 'vat' }] }],
  ]);
  rates = new Map([
    [IVA15, { id: IVA15, percentage: '15', kind: 'vat' }],
    [IVA0, { id: IVA0, percentage: '0', kind: 'vat' }],
    ['aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', { id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', percentage: '10', kind: 'withholding_rent' }],
  ]);
  warehouses = new Map([[WAREHOUSE, { id: WAREHOUSE, name: 'Bodega central', status: 'active' }]]);

  private check(): void {
    if (this.down) throw new CatalogUnavailableError();
  }
  async findById(_org: string, id: string) {
    this.check();
    return this.products.get(id) ?? this.warehouses.get(id) ?? null;
  }
  async findRate(_country: string, id: string) {
    this.check();
    return this.rates.get(id) ?? null;
  }
}

export function buildPurchasing(store: InMemoryStore, now: () => Date = () => new Date('2026-10-20T15:00:00Z')) {
  const catalogs = new FakeCatalogs();
  const products: ProductCatalogPort = { findById: (org, id) => catalogs.findById(org, id) as Promise<ProductInfo | null> };
  const warehouses: WarehouseCatalogPort = { findById: (org, id) => catalogs.findById(org, id) as never };
  const orderDeps: OrderDeps = { gateway: store, reads: store, clock: now, products, taxRates: catalogs, warehouses };
  const uc = {
    getSettings: new GetSettingsUseCase(store, now),
    updateSettings: new UpdateSettingsUseCase(store, now, warehouses),
    listSuppliers: new ListSuppliersUseCase(store),
    getSupplier: new GetSupplierUseCase(store),
    createSupplier: new CreateSupplierUseCase(store, now),
    updateSupplier: new UpdateSupplierUseCase(store, now),
    setSupplierStatus: new SetSupplierStatusUseCase(store, now),
    listOrders: new ListOrdersUseCase(store),
    getOrder: new GetOrderUseCase(store),
    createOrder: new CreateOrderUseCase(orderDeps),
    updateOrder: new UpdateOrderUseCase(orderDeps),
    submitOrder: new SubmitOrderUseCase(store, now),
    approveOrder: new ApproveOrderUseCase(store, now),
    rejectOrder: new RejectOrderUseCase(store, now),
    reopenOrder: new ReopenOrderUseCase(store, now),
    cancelOrder: new CancelOrderUseCase(store, now),
  };
  const deps: AppDependencies = { useCases: uc, corsOrigin: '*' };
  return { uc, catalogs, app: createApp(deps) };
}

export const supplierInput = (over: Record<string, unknown> = {}) => ({
  identificationType: 'RUC' as const,
  identification: '1790012345001',
  legalName: 'Distribuidora Andina Cía. Ltda.',
  paymentTermDays: 30,
  ...over,
});

export const lineRequest = (over: Partial<LineRequest> = {}): LineRequest => ({ productId: PRODUCT_1, quantity: '10', unitCostCents: 250, ...over });

export const orderRequest = (supplierId: string, over: Partial<OrderRequest> = {}): OrderRequest => ({
  supplierId,
  warehouseId: WAREHOUSE,
  lines: [lineRequest()],
  ...over,
});

export const newId = () => randomUUID();
