import { Hono, type Context } from 'hono';
import type { z } from 'zod';
import type {
  CreateSupplierUseCase,
  GetSupplierUseCase,
  ListSuppliersUseCase,
  SetSupplierStatusUseCase,
  UpdateSupplierUseCase,
} from '../../application/use-cases/supplier-use-cases.js';
import type {
  ApproveOrderUseCase,
  CancelOrderUseCase,
  CreateOrderUseCase,
  GetOrderUseCase,
  ListOrdersUseCase,
  RejectOrderUseCase,
  ReopenOrderUseCase,
  SubmitOrderUseCase,
  UpdateOrderUseCase,
} from '../../application/use-cases/order-use-cases.js';
import type { GetSettingsUseCase, UpdateSettingsUseCase } from '../../application/use-cases/settings-use-cases.js';
import type { OrderStatus } from '../../domain/purchase-order.js';
import { type ContextVariables, requireOrganization, requirePermission, requireUser } from './middlewares.js';
import {
  orderQuerySchema,
  orderSchema,
  reasonSchema,
  settingsSchema,
  supplierQuerySchema,
  supplierSchema,
  updateSupplierSchema,
  validateJson,
  validateQuery,
} from './validators.js';
import { toOrderJSON, toSettingsJSON, toSupplierJSON } from './serializers.js';

type Vars = { Variables: ContextVariables };
type Ctx = Context<Vars>;

export interface AppDependencies {
  useCases: {
    getSettings: GetSettingsUseCase;
    updateSettings: UpdateSettingsUseCase;
    listSuppliers: ListSuppliersUseCase;
    getSupplier: GetSupplierUseCase;
    createSupplier: CreateSupplierUseCase;
    updateSupplier: UpdateSupplierUseCase;
    setSupplierStatus: SetSupplierStatusUseCase;
    listOrders: ListOrdersUseCase;
    getOrder: GetOrderUseCase;
    createOrder: CreateOrderUseCase;
    updateOrder: UpdateOrderUseCase;
    submitOrder: SubmitOrderUseCase;
    approveOrder: ApproveOrderUseCase;
    rejectOrder: RejectOrderUseCase;
    reopenOrder: ReopenOrderUseCase;
    cancelOrder: CancelOrderUseCase;
  };
  corsOrigin: string;
}

export function healthRoutes(): Hono {
  const r = new Hono();
  r.get('/health', (c) => c.json({ status: 'ok' }));
  return r;
}

const org = (c: Ctx) => c.get('organizationId');
const user = (c: Ctx) => c.get('userId');
const country = (c: Ctx) => c.get('countryCode') || 'EC';
const can = (c: Ctx, permission: string) => (c.get('permissions') ?? []).includes(permission);

/**
 * Rutas bajo `/purchasing`. El gateway las deja pasar con el prefijo intacto y exige el plugin de cada una
 * (`inventory.suppliers` para proveedores, `purchasing.purchase_orders` para órdenes); aquí se exige el PERMISO de cada acción.
 * Separación de funciones: quien prepara (`purchase:create`) no aprueba (`purchase:approve`), y cancelar lo ya aprobado es aparte.
 */
export function purchasingRoutes(deps: AppDependencies): Hono<Vars> {
  const r = new Hono<Vars>();
  const { useCases: uc } = deps;
  const base = [requireOrganization()] as const;

  // ── Ajustes ───────────────────────────────────────────────────────────────
  r.get('/purchasing/settings', ...base, requirePermission('purchase:read'), async (c) =>
    c.json(toSettingsJSON(await uc.getSettings.execute({ organizationId: org(c) }))));

  r.put('/purchasing/settings', ...base, requirePermission('purchase:approve'), validateJson(settingsSchema), async (c) =>
    c.json(toSettingsJSON(await uc.updateSettings.execute({ organizationId: org(c), changes: (c.req.valid('json' as never) as z.infer<typeof settingsSchema>) }))));

  // ── Proveedores ───────────────────────────────────────────────────────────
  r.get('/purchasing/suppliers', ...base, requirePermission('supplier:read'), validateQuery(supplierQuerySchema), async (c) => {
    const filters = c.req.valid('query' as never) as z.infer<typeof supplierQuerySchema>;
    const page = await uc.listSuppliers.execute({ organizationId: org(c), filters });
    return c.json({ ...page, items: page.items.map(toSupplierJSON) });
  });

  r.post('/purchasing/suppliers', ...base, requirePermission('supplier:manage'), validateJson(supplierSchema), async (c) =>
    c.json(toSupplierJSON(await uc.createSupplier.execute({ organizationId: org(c), input: c.req.valid('json' as never) as z.infer<typeof supplierSchema> })), 201));

  r.get('/purchasing/suppliers/:id', ...base, requirePermission('supplier:read'), async (c) =>
    c.json(toSupplierJSON(await uc.getSupplier.execute({ organizationId: org(c), supplierId: c.req.param('id') }))));

  r.put('/purchasing/suppliers/:id', ...base, requirePermission('supplier:manage'), validateJson(updateSupplierSchema), async (c) =>
    c.json(toSupplierJSON(await uc.updateSupplier.execute({ organizationId: org(c), supplierId: c.req.param('id'), input: c.req.valid('json' as never) as z.infer<typeof updateSupplierSchema> }))));

  r.post('/purchasing/suppliers/:id/deactivate', ...base, requirePermission('supplier:manage'), async (c) =>
    c.json(toSupplierJSON(await uc.setSupplierStatus.execute({ organizationId: org(c), supplierId: c.req.param('id'), status: 'inactive' }))));

  r.post('/purchasing/suppliers/:id/activate', ...base, requirePermission('supplier:manage'), async (c) =>
    c.json(toSupplierJSON(await uc.setSupplierStatus.execute({ organizationId: org(c), supplierId: c.req.param('id'), status: 'active' }))));

  // ── Órdenes de compra ─────────────────────────────────────────────────────
  r.get('/purchasing/orders', ...base, requirePermission('purchase:read'), validateQuery(orderQuerySchema), async (c) => {
    const q = c.req.valid('query' as never) as z.infer<typeof orderQuerySchema>;
    const page = await uc.listOrders.execute({ organizationId: org(c), filters: { ...q, status: q.status as OrderStatus | undefined } });
    return c.json({ ...page, items: page.items.map((o) => toOrderJSON(o, { withLines: false })) });
  });

  r.post('/purchasing/orders', ...base, requireUser(), requirePermission('purchase:create'), validateJson(orderSchema), async (c) =>
    c.json(toOrderJSON(await uc.createOrder.execute({
      organizationId: org(c), userId: user(c), countryCode: country(c), request: c.req.valid('json' as never) as z.infer<typeof orderSchema>,
    })), 201));

  r.get('/purchasing/orders/:id', ...base, requirePermission('purchase:read'), async (c) =>
    c.json(toOrderJSON(await uc.getOrder.execute({ organizationId: org(c), orderId: c.req.param('id') }))));

  r.put('/purchasing/orders/:id', ...base, requireUser(), requirePermission('purchase:create'), validateJson(orderSchema), async (c) =>
    c.json(toOrderJSON(await uc.updateOrder.execute({
      organizationId: org(c), orderId: c.req.param('id'), countryCode: country(c), request: c.req.valid('json' as never) as z.infer<typeof orderSchema>,
    }))));

  r.post('/purchasing/orders/:id/submit', ...base, requireUser(), requirePermission('purchase:create'), async (c) =>
    c.json(toOrderJSON(await uc.submitOrder.execute({ organizationId: org(c), orderId: c.req.param('id') }))));

  r.post('/purchasing/orders/:id/approve', ...base, requireUser(), requirePermission('purchase:approve'), async (c) =>
    c.json(toOrderJSON(await uc.approveOrder.execute({ organizationId: org(c), orderId: c.req.param('id'), userId: user(c) }))));

  r.post('/purchasing/orders/:id/reject', ...base, requireUser(), requirePermission('purchase:approve'), validateJson(reasonSchema), async (c) =>
    c.json(toOrderJSON(await uc.rejectOrder.execute({
      organizationId: org(c), orderId: c.req.param('id'), userId: user(c), reason: (c.req.valid('json' as never) as z.infer<typeof reasonSchema>).reason,
    }))));

  r.post('/purchasing/orders/:id/reopen', ...base, requireUser(), requirePermission('purchase:create'), async (c) =>
    c.json(toOrderJSON(await uc.reopenOrder.execute({ organizationId: org(c), orderId: c.req.param('id') }))));

  r.post('/purchasing/orders/:id/cancel', ...base, requireUser(), requirePermission('purchase:create'), validateJson(reasonSchema), async (c) =>
    c.json(toOrderJSON(await uc.cancelOrder.execute({
      organizationId: org(c), orderId: c.req.param('id'), userId: user(c), reason: (c.req.valid('json' as never) as z.infer<typeof reasonSchema>).reason,
      allowApproved: can(c, 'purchase:cancel'),
    }))));

  return r;
}
