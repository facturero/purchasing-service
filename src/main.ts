import './infrastructure/telemetry/otel.js';
import { serve } from '@hono/node-server';
import { OutboxRelay } from '@facturero/outbox-relay';
import { config } from './infrastructure/config.js';
import { sequelize } from './infrastructure/persistence/sequelize.js';
import './infrastructure/persistence/models.js';
import { readOnlyRepositories, SequelizeUnitOfWorkFactory } from './infrastructure/persistence/repositories.js';
import { HttpProductCatalog, HttpTaxRateCatalog, HttpWarehouseCatalog } from './infrastructure/catalogs/http-catalogs.js';
import { buildEventHandlers, startEventConsumers } from './infrastructure/messaging/consumer.js';
import { HttpFiscalPort } from './infrastructure/catalogs/http-fiscal.js';
import {
  CreateSupplierUseCase,
  GetSupplierUseCase,
  ListSuppliersUseCase,
  SetSupplierStatusUseCase,
  UpdateSupplierUseCase,
} from './application/use-cases/supplier-use-cases.js';
import { ReceiveOrderUseCase } from './application/use-cases/receive-order-use-case.js';
import { CloseOrderUseCase } from './application/use-cases/close-order-use-case.js';
import {
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
} from './application/use-cases/order-use-cases.js';
import {
  CreateBillUseCase,
  GetBillUseCase,
  ListBillsUseCase,
  OverrideBillUseCase,
  PostBillUseCase,
  UpdateBillUseCase,
  VoidBillUseCase,
} from './application/use-cases/bill-use-cases.js';
import { IssueBillWithholdingUseCase } from './application/use-cases/withholding-use-cases.js';
import { GetSettingsUseCase, UpdateSettingsUseCase } from './application/use-cases/settings-use-cases.js';
import { createApp } from './interface/http/app.js';

async function main(): Promise<void> {
  // NO se llama a `sequelize.sync()`: la migración (initContainer purchasing-migrate) es la fuente de verdad del esquema.
  await sequelize.authenticate();

  let relay: OutboxRelay | undefined;
  const uow = new SequelizeUnitOfWorkFactory((tx) => relay?.attachToTransaction(tx));
  const repos = readOnlyRepositories;
  const clock = () => new Date();
  const products = new HttpProductCatalog(config.PRODUCT_SERVICE_URL);
  const taxRates = new HttpTaxRateCatalog(config.TAX_SERVICE_URL);
  const warehouses = new HttpWarehouseCatalog(config.INVENTORY_SERVICE_URL);
  const orderDeps = { gateway: uow, reads: repos, clock, products, taxRates, warehouses };

  const billDeps = { gateway: uow, reads: repos, clock };
  const fiscal = new HttpFiscalPort(config.FISCAL_SERVICE_URL);

  const app = createApp({
    useCases: {
      getSettings: new GetSettingsUseCase(repos, clock),
      updateSettings: new UpdateSettingsUseCase(uow, clock, warehouses),
      listSuppliers: new ListSuppliersUseCase(repos),
      getSupplier: new GetSupplierUseCase(repos),
      createSupplier: new CreateSupplierUseCase(uow, clock),
      updateSupplier: new UpdateSupplierUseCase(uow, clock),
      setSupplierStatus: new SetSupplierStatusUseCase(uow, clock),
      listOrders: new ListOrdersUseCase(repos),
      getOrder: new GetOrderUseCase(repos),
      getOrderReceiving: new GetOrderReceivingUseCase(repos),
      getReceipt: new GetReceiptUseCase(repos),
      listReceipts: new ListReceiptsUseCase(repos),
      listBills: new ListBillsUseCase(repos),
      getBill: new GetBillUseCase(repos),
      createBill: new CreateBillUseCase(billDeps),
      updateBill: new UpdateBillUseCase(billDeps),
      postBill: new PostBillUseCase(uow, clock),
      overrideBill: new OverrideBillUseCase(uow, clock),
      voidBill: new VoidBillUseCase(uow, clock),
      issueBillWithholding: new IssueBillWithholdingUseCase(uow, fiscal, clock),
      createOrder: new CreateOrderUseCase(orderDeps),
      updateOrder: new UpdateOrderUseCase(orderDeps),
      submitOrder: new SubmitOrderUseCase(uow, clock),
      approveOrder: new ApproveOrderUseCase(uow, clock),
      rejectOrder: new RejectOrderUseCase(uow, clock),
      reopenOrder: new ReopenOrderUseCase(uow, clock),
      cancelOrder: new CancelOrderUseCase(uow, clock),
      receiveOrder: new ReceiveOrderUseCase(uow, clock),
      closeOrder: new CloseOrderUseCase(uow, clock),
    },
    corsOrigin: config.CORS_ORIGIN,
  });

  serve({ fetch: app.fetch, port: config.PORT });
  console.log(`[purchasing-service] corriendo en puerto ${config.PORT}`);

  if (config.RABBITMQ_URL) {
    relay = new OutboxRelay({ sequelize, rabbitmqUrl: config.RABBITMQ_URL, exchange: 'crm.events' });
    await relay.start();
    console.log('[purchasing-service] outbox relay activo');

    // Consumers
    await startEventConsumers({
      sequelize,
      rabbitmqUrl: config.RABBITMQ_URL,
      exchange: 'crm.events',
      queue: 'purchasing-service.events',
      handlers: buildEventHandlers({ uowGateway: uow, systemUserId: 'system' }),
      systemUserId: 'system',
      uowGateway: uow,
    });
  } else {
    console.warn('[purchasing-service] RABBITMQ_URL no configurado: los eventos NO se publican ni consumen');
  }
}

main().catch((err) => {
  console.error('[purchasing-service] error al iniciar:', err);
  process.exit(1);
});
