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
  GetOrderReceivingUseCase,
  GetOrderUseCase,
  GetReceiptUseCase,
  ListOrdersUseCase,
  ListReceiptsUseCase,
  RejectOrderUseCase,
  ReopenOrderUseCase,
  SubmitOrderUseCase,
  UpdateOrderUseCase,
} from '../../application/use-cases/order-use-cases.js';
import type { ReceiveOrderUseCase } from '../../application/use-cases/receive-order-use-case.js';
import type { CloseOrderUseCase } from '../../application/use-cases/close-order-use-case.js';
import type {
  CreateBillUseCase,
  GetBillUseCase,
  ListBillsUseCase,
  OverrideBillUseCase,
  PostBillUseCase,
  UpdateBillUseCase,
  VoidBillUseCase,
} from '../../application/use-cases/bill-use-cases.js';
import type { GetSettingsUseCase, UpdateSettingsUseCase } from '../../application/use-cases/settings-use-cases.js';
import type {
  AttachReceivedXmlUseCase,
  FetchReceivedDocumentsUseCase,
  GetReceivedDocumentsStatusUseCase,
  GetReceivedDocumentUseCase,
  ImportSriReportUseCase,
  ListReceivedDocumentsUseCase,
} from '../../application/use-cases/received-document-use-cases.js';
import type { OrderStatus } from '../../domain/purchase-order.js';
import { assertCanBillWithoutOrder, type ContextVariables, requireOrganization, requirePermission, requireUser } from './middlewares.js';
import type { SriPortalController } from './sri-portal-controller.js';
import {
  billQuerySchema,
  billSchema,
  importReportSchema,
  receivedDocumentQuerySchema,
  orderQuerySchema,
  orderSchema,
  overrideSchema,
  reasonSchema,
  receiptQuerySchema,
  receiptSchema,
  settingsSchema,
  supplierQuerySchema,
  supplierSchema,
  updateSupplierSchema,
  validateJson,
  validateQuery,
  voidSchema,
} from './validators.js';
import { toBillJSON, toOrderJSON, toReceiptJSON, toReceivedDocumentJSON, toSettingsJSON, toSupplierJSON } from './serializers.js';

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
    getOrderReceiving: GetOrderReceivingUseCase;
    getReceipt: GetReceiptUseCase;
    listReceipts: ListReceiptsUseCase;
    listBills: ListBillsUseCase;
    getBill: GetBillUseCase;
    createBill: CreateBillUseCase;
    updateBill: UpdateBillUseCase;
    postBill: PostBillUseCase;
    overrideBill: OverrideBillUseCase;
    voidBill: VoidBillUseCase;
    importSriReport: ImportSriReportUseCase;
    fetchReceivedDocuments: FetchReceivedDocumentsUseCase;
    attachReceivedXml: AttachReceivedXmlUseCase;
    listReceivedDocuments: ListReceivedDocumentsUseCase;
    getReceivedDocument: GetReceivedDocumentUseCase;
    getReceivedDocumentsStatus: GetReceivedDocumentsStatusUseCase;
    createOrder: CreateOrderUseCase;
    updateOrder: UpdateOrderUseCase;
    submitOrder: SubmitOrderUseCase;
    approveOrder: ApproveOrderUseCase;
    rejectOrder: RejectOrderUseCase;
    reopenOrder: ReopenOrderUseCase;
    cancelOrder: CancelOrderUseCase;
    receiveOrder: ReceiveOrderUseCase;
    closeOrder: CloseOrderUseCase;
  };
  sriPortal?: SriPortalController;
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

  // ── Recepción de mercadería ─────────────────────────────────────────────────
  r.post('/purchasing/orders/:id/receipts', ...base, requireUser(), requirePermission('receipt:create'), validateJson(receiptSchema), async (c) => {
    const input = c.req.valid('json' as never) as z.infer<typeof receiptSchema>;
    const { order, receiptId, receiptNumber } = await uc.receiveOrder.execute({
      organizationId: org(c),
      input: { ...input, orderId: c.req.param('id'), userId: user(c) },
    });
    return c.json({ ...toOrderJSON(order), receiptId, receiptNumber }, 201);
  });

  r.get('/purchasing/receipts', ...base, requirePermission('purchase:read'), validateQuery(receiptQuerySchema), async (c) => {
    const q = c.req.valid('query' as never) as z.infer<typeof receiptQuerySchema>;
    const page = await uc.listReceipts.execute({ organizationId: org(c), filters: q });
    return c.json({ ...page, items: page.items.map(toReceiptJSON) });
  });

  r.get('/purchasing/receipts/:id', ...base, requirePermission('purchase:read'), async (c) =>
    c.json(toReceiptJSON(await uc.getReceipt.execute({ organizationId: org(c), receiptId: c.req.param('id') }))));

  r.get('/purchasing/orders/:id/receiving', ...base, requirePermission('purchase:read'), async (c) =>
    c.json(await uc.getOrderReceiving.execute({ organizationId: org(c), orderId: c.req.param('id') })));

  // ── Cierre manual de orden ──────────────────────────────────────────────────
  r.post('/purchasing/orders/:id/close', ...base, requireUser(), requirePermission('purchase:close'), validateJson(reasonSchema), async (c) => {
    const input = c.req.valid('json' as never) as z.infer<typeof reasonSchema>;
    const order = await uc.closeOrder.execute({
      organizationId: org(c),
      input: { orderId: c.req.param('id'), userId: user(c), reason: input.reason },
    });
    return c.json(toOrderJSON(order));
  });

  // ── Factura de compra (conciliación a tres vías) ────────────────────────────
  r.get('/purchasing/bills', ...base, requirePermission('purchase_bill:read'), validateQuery(billQuerySchema), async (c) => {
    const q = c.req.valid('query' as never) as z.infer<typeof billQuerySchema>;
    const page = await uc.listBills.execute({ organizationId: org(c), filters: q });
    return c.json({ ...page, items: page.items.map((b) => toBillJSON(b, { withLines: false })) });
  });

  r.post('/purchasing/bills', ...base, requireUser(), requirePermission('purchase_bill:create'), validateJson(billSchema), async (c) => {
    const input = c.req.valid('json' as never) as z.infer<typeof billSchema>;
    assertCanBillWithoutOrder(input.purchaseOrderId, c.get('permissions') ?? []);
    const bill = await uc.createBill.execute({
      organizationId: org(c),
      userId: user(c),
      input: { ...input, supplierTotalCents: input.supplierTotalCents },
    });
    return c.json(toBillJSON(bill), 201);
  });

  r.get('/purchasing/bills/:id', ...base, requirePermission('purchase_bill:read'), async (c) =>
    c.json(toBillJSON(await uc.getBill.execute({ organizationId: org(c), billId: c.req.param('id') }))));

  r.put('/purchasing/bills/:id', ...base, requireUser(), requirePermission('purchase_bill:create'), validateJson(billSchema), async (c) => {
    const input = c.req.valid('json' as never) as z.infer<typeof billSchema>;
    assertCanBillWithoutOrder(input.purchaseOrderId, c.get('permissions') ?? []);
    const bill = await uc.updateBill.execute({
      organizationId: org(c),
      billId: c.req.param('id'),
      input: { ...input, supplierTotalCents: input.supplierTotalCents },
    });
    return c.json(toBillJSON(bill));
  });

  r.post('/purchasing/bills/:id/post', ...base, requireUser(), requirePermission('purchase_bill:create'), async (c) => {
    const bill = await uc.postBill.execute({ organizationId: org(c), billId: c.req.param('id') });
    return c.json(toBillJSON(bill));
  });

  r.post('/purchasing/bills/:id/override', ...base, requireUser(), requirePermission('purchase_bill:override'), validateJson(overrideSchema), async (c) => {
    const input = c.req.valid('json' as never) as z.infer<typeof overrideSchema>;
    const bill = await uc.overrideBill.execute({ organizationId: org(c), billId: c.req.param('id'), userId: user(c), reason: input.reason });
    return c.json(toBillJSON(bill));
  });

  r.post('/purchasing/bills/:id/void', ...base, requireUser(), requirePermission('purchase_bill:void'), validateJson(voidSchema), async (c) => {
    const input = c.req.valid('json' as never) as z.infer<typeof voidSchema>;
    const bill = await uc.voidBill.execute({ organizationId: org(c), billId: c.req.param('id'), userId: user(c), reason: input.reason });
    return c.json(toBillJSON(bill));
  });

  // ── Comprobantes recibidos del SRI ──────────────────────────────────────────
  // Leer es `purchase_bill:read`; registrar claves o subir un XML es `purchase_bill:create` (es preparar facturas de compra).
  r.get('/purchasing/received-documents/status', ...base, requirePermission('purchase_bill:read'), async (c) =>
    c.json(await uc.getReceivedDocumentsStatus.execute({ organizationId: org(c) })));

  r.get('/purchasing/received-documents', ...base, requirePermission('purchase_bill:read'), validateQuery(receivedDocumentQuerySchema), async (c) => {
    const filters = c.req.valid('query' as never) as z.infer<typeof receivedDocumentQuerySchema>;
    const page = await uc.listReceivedDocuments.execute({ organizationId: org(c), filters });
    return c.json({ ...page, items: page.items.map(toReceivedDocumentJSON) });
  });

  r.post('/purchasing/received-documents/import', ...base, requireUser(), requirePermission('purchase_bill:create'), validateJson(importReportSchema), async (c) => {
    const input = c.req.valid('json' as never) as z.infer<typeof importReportSchema>;
    return c.json(await uc.importSriReport.execute({ organizationId: org(c), userId: user(c), text: input.report }), 201);
  });

  r.get('/purchasing/received-documents/:id', ...base, requirePermission('purchase_bill:read'), async (c) =>
    c.json(toReceivedDocumentJSON(await uc.getReceivedDocument.execute({ organizationId: org(c), documentId: c.req.param('id') }))));

  r.get('/purchasing/received-documents/:id/xml', ...base, requirePermission('purchase_bill:read'), async (c) => {
    const doc = await uc.getReceivedDocument.execute({ organizationId: org(c), documentId: c.req.param('id') });
    if (!doc.xml) return c.json({ code: 'XML_NOT_AVAILABLE', message: 'Este comprobante todavía no tiene XML.' }, 404);
    return c.body(doc.xml, 200, { 'Content-Type': 'application/xml; charset=utf-8', 'Content-Disposition': `attachment; filename="${doc.accessKey}.xml"` });
  });

  /** El cuerpo es el XML tal cual (no JSON): así lo manda un recolector o una persona que arrastra el archivo. */
  r.put('/purchasing/received-documents/:id/xml', ...base, requireUser(), requirePermission('purchase_bill:create'), async (c) =>
    c.json(toReceivedDocumentJSON(await uc.attachReceivedXml.execute({ organizationId: org(c), documentId: c.req.param('id'), xml: await c.req.text() }))));

  // ── Sincronización portal SRI ───────────────────────────────────────────────
  if (deps.sriPortal) {
    r.get('/purchasing/sri-portal/config', ...base, requireUser(), (c: any) => deps.sriPortal!.getConfigHandler(c));
    r.post('/purchasing/sri-portal/credentials', ...base, requireUser(), (c: any) => deps.sriPortal!.saveCredentials(c));
    r.post('/purchasing/sri-portal/enable', ...base, requireUser(), (c: any) => deps.sriPortal!.enable(c));
    r.post('/purchasing/sri-portal/disable', ...base, requireUser(), (c: any) => deps.sriPortal!.disable(c));
  }

  return r;
}
