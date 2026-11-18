import './infrastructure/telemetry/otel.js';
import { serve } from '@hono/node-server';
import { OutboxRelay } from '@facturero/outbox-relay';
import { config } from './infrastructure/config.js';
import { sequelize } from './infrastructure/persistence/sequelize.js';
import './infrastructure/persistence/models.js';
import { readOnlyRepositories, SequelizeUnitOfWorkFactory } from './infrastructure/persistence/repositories.js';
import { HttpProductCatalog, HttpTaxRateCatalog, HttpWarehouseCatalog } from './infrastructure/catalogs/http-catalogs.js';
import { buildEventHandlers, startEventConsumers } from './infrastructure/messaging/consumer.js';
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
import { GetSettingsUseCase, UpdateSettingsUseCase } from './application/use-cases/settings-use-cases.js';
import {
  AttachReceivedXmlUseCase,
  FetchReceivedDocumentsUseCase,
  GetReceivedDocumentsStatusUseCase,
  GetReceivedDocumentUseCase,
  ImportSriReportUseCase,
  ListReceivedDocumentsUseCase,
} from './application/use-cases/received-document-use-cases.js';
import { HttpSriAuthorizationClient } from './infrastructure/sri/sri-authorization-client.js';
import { startReceivedDocumentsJob } from './infrastructure/jobs/received-documents-job.js';
import { createApp } from './interface/http/app.js';
import { SequelizeSriPortalConfigRepository } from './infrastructure/persistence/sri-portal-config-repository.js';
import { GetSriPortalConfigUseCase, SaveSriPortalCredentialsUseCase, SetSriPortalEnabledUseCase } from './application/use-cases/sri-portal-config-use-cases.js';
import { SriPortalController } from './interface/http/sri-portal-controller.js';
import { startPortalSyncJob } from './infrastructure/jobs/portal-sync-job.js';
import { createSriPortalClient, wipePortalProfile } from './infrastructure/sri/portal/index.js';
import { runSyncWithRetry } from './infrastructure/sri/portal/sync-retry.js';
import { decrypt } from './infrastructure/crypto/encrypt.js';
import { SriPortalAuthError, SriPortalCaptchaError } from './domain/sri-portal.js';

/** `YYYY-MM` → primer día de ese mes (hora local). */
function parsePeriod(period: string | null): Date | null {
  if (!period) return null;
  const m = /^(\d{4})-(\d{2})$/.exec(period);
  if (!m) return null;
  const year = Number(m[1]);
  const month = Number(m[2]);
  if (month < 1 || month > 12) return null;
  return new Date(year, month - 1, 1);
}

function formatPeriod(date: Date): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`;
}

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

  const billDeps = { gateway: uow, reads: repos, clock, products };
  const fetchReceived = new FetchReceivedDocumentsUseCase(uow, repos, new HttpSriAuthorizationClient(config.SRI_AUTHORIZATION_URL, config.SRI_TIMEOUT_MS), clock);

  const sriPortalRepo = new SequelizeSriPortalConfigRepository(sequelize);
  const sriPortalController = new SriPortalController(
    new GetSriPortalConfigUseCase(sriPortalRepo),
    new SaveSriPortalCredentialsUseCase(sriPortalRepo, uow),
    new SetSriPortalEnabledUseCase(sriPortalRepo),
  );

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
      importSriReport: new ImportSriReportUseCase(uow, clock),
      fetchReceivedDocuments: fetchReceived,
      attachReceivedXml: new AttachReceivedXmlUseCase(uow, clock),
      listReceivedDocuments: new ListReceivedDocumentsUseCase(repos),
      getReceivedDocument: new GetReceivedDocumentUseCase(repos),
      getReceivedDocumentsStatus: new GetReceivedDocumentsStatusUseCase(repos),
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
    sriPortal: sriPortalController,
    corsOrigin: config.CORS_ORIGIN,
  });

  serve({ fetch: app.fetch, port: config.PORT });
  console.log(`[purchasing-service] corriendo en puerto ${config.PORT}`);

  if (config.RECEIVED_DOCS_FETCH_INTERVAL_MINUTES > 0) {
    startReceivedDocumentsJob({ run: () => fetchReceived.execute(), intervalMinutes: config.RECEIVED_DOCS_FETCH_INTERVAL_MINUTES });
  }

  if (config.SRI_PORTAL_CRON_INTERVAL_MINUTES > 0) {
    startPortalSyncJob({
      runForOrg: async (orgId: string) => {
        const cfg = await sriPortalRepo.get(orgId);
        if (!cfg || !cfg.enabled || cfg.blockedBySri) {
          await sriPortalRepo.upsert(orgId, { lastRunAt: new Date(), lastStatus: 'skipped', lastError: null });
          return;
        }
        if (!cfg.username || !cfg.passwordEnc) {
          await sriPortalRepo.upsert(orgId, { lastRunAt: new Date(), lastStatus: 'error', lastError: 'Credenciales incompletas' });
          return;
        }

        console.log(`[portal-sync] iniciando sync org ${orgId} (cursor ${cfg.syncCursorPeriod ?? 'nuevo'})`);
        // Se fijan fuera de `runOnce` para que el estrechamiento de tipos del guardia de
        // arriba siga valiendo dentro de la función (TypeScript lo pierde en los closures).
        const username = cfg.username;
        const passwordEnc = cfg.passwordEnc;

        // Una pasada = un navegador, un login y hasta `maxPeriods` periodos. No lanza:
        // devuelve cuántos periodos quedaron hechos y el error si lo hubo, para que quien
        // llama decida si reintenta. El navegador se cierra siempre.
        const runOnce = async (): Promise<{ synced: number; error?: unknown }> => {
          const client = createSriPortalClient();
          let synced = 0;
          try {
            const password = decrypt(passwordEnc);
            await client.login(username, password);

            // Recorrido hacia atrás desde el cursor, un periodo por corrida como máximo.
            // Cada periodo gasta un captcha y el portal castiga las consultas seguidas:
            // con CAPTCHA_SOLVER=manual esto es lo único que pasa de forma sostenida.
            const monthsBack = Math.max(1, config.SRI_PORTAL_SYNC_MONTHS);
            const now = new Date();
            const newest = new Date(now.getFullYear(), now.getMonth(), 1);
            const oldest = new Date(now.getFullYear(), now.getMonth() - (monthsBack - 1), 1);
            let current = parsePeriod(cfg.syncCursorPeriod) ?? newest;
            if (current < oldest || current > newest) current = newest;

            const importUseCase = new ImportSriReportUseCase(uow, clock);
            const attachXml = new AttachReceivedXmlUseCase(uow, clock);
            const maxPeriods = Math.max(1, config.SRI_PORTAL_PERIODS_PER_RUN);

            for (let i = 0; i < maxPeriods; i++) {
              if (current < oldest) {
                // Ventana completa recorrida: la próxima corrida vuelve a empezar por el mes actual.
                await sriPortalRepo.setSyncCursor(orgId, null);
                current = newest;
              }
              const year = current.getFullYear();
              const month = current.getMonth() + 1;
              const periodo = formatPeriod(current);
              console.log(`[portal-sync] consultando periodo ${periodo} org ${orgId}`);

              // Un solo captcha por periodo: consulta, lee la tabla completa y baja los XML.
              const res = await client.syncPeriod({ year, month, receiverId: username });
              const imported = await importUseCase.execute({
                organizationId: orgId,
                userId: 'system',
                text: res.reportText,
              });
              console.log(
                `[portal-sync] periodo ${periodo} filas=${res.rowCount} import=${JSON.stringify(imported)} xmls=${res.xmls.size}`,
              );

              for (const [accessKey, xml] of res.xmls) {
                try {
                  const doc = await repos.receivedDocuments.findByAccessKey(orgId, accessKey);
                  if (!doc) continue;
                  await attachXml.execute({ organizationId: orgId, documentId: doc.id, xml });
                } catch (e: any) {
                  console.warn(`[portal-sync] no se pudo adjuntar XML ${accessKey} org ${orgId}: ${e.message}`);
                }
              }

              synced++;
              const previous = new Date(year, month - 2, 1);
              await sriPortalRepo.setSyncCursor(orgId, previous < oldest ? null : formatPeriod(previous));
              current = previous;
            }

            await sriPortalRepo.markRunOk(orgId);
            console.log(`[portal-sync] corrida OK org ${orgId}: ${synced} periodo(s)`);
            return { synced };
          } catch (error) {
            return { synced, error };
          } finally {
            try { await client.close(); } catch {}
          }
        };

        // Un captcha rechazado o una navegación fallida **sin haber hecho ningún periodo**
        // suele ser transitorio o un perfil de Chrome degradado (ver IMPLEMENTATION.md). Se
        // borra el perfil —después de cerrar el navegador, que es quien lo retiene— y se
        // intenta una vez más con perfil limpio en la misma corrida. Si ya se hizo algún
        // periodo el cursor avanzó y no se reintenta (el portal castiga la repetición): la
        // hora siguiente sigue sola. Un fallo de credenciales no se reintenta ni toca el perfil.
        await runSyncWithRetry(
          runOnce,
          (e) => e instanceof SriPortalAuthError,
          async (error, synced, willRetry) => {
            const msg = ((error as any)?.message || 'Error desconocido').slice(0, 500);
            if (error instanceof SriPortalAuthError) {
              await sriPortalRepo.upsert(orgId, { lastRunAt: new Date(), lastStatus: 'error', lastError: msg });
              const rec = await sriPortalRepo.incrementFail(orgId, msg).catch(() => null);
              if (rec && rec.loginFailCount >= config.SRI_PORTAL_MAX_LOGIN_ATTEMPTS) {
                await sriPortalRepo.markBlocked(orgId, msg).catch(() => null);
                console.error(`[portal-sync] org ${orgId} bloqueada tras ${rec.loginFailCount} fallos de login`);
              }
              return;
            }

            try { wipePortalProfile(username); } catch {}
            if (error instanceof SriPortalCaptchaError) {
              // Un captcha rechazado no es culpa de las credenciales: no cuenta como fallo
              // de login ni bloquea la organización. Se retoma en la próxima corrida.
              await sriPortalRepo.upsert(orgId, { lastRunAt: new Date(), lastStatus: 'captcha_pending', lastError: msg });
              console.warn(`[portal-sync] captcha rechazado org ${orgId} (${synced} periodo(s) hechos): ${msg}`);
            } else {
              await sriPortalRepo.upsert(orgId, { lastRunAt: new Date(), lastStatus: 'error', lastError: msg });
              console.error(`[portal-sync] error org ${orgId} (${synced} periodo(s) hechos): ${msg}`);
            }
            console.warn(
              `[portal-sync] perfil del portal borrado org ${orgId}; ${willRetry ? 'reintentando en esta misma corrida' : 'la próxima corrida arranca limpia'}`,
            );
          },
        );
      },
      intervalMinutes: config.SRI_PORTAL_CRON_INTERVAL_MINUTES,
    });
    console.log('[purchasing-service] portal-sync job iniciado');
  }

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
