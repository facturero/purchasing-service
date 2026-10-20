import { EventHandler, InboxConsumer } from '@facturero/outbox-relay';
import type { Sequelize } from 'sequelize';
import { HandleWithholdingIssuedUseCase, type WithholdingIssuedPayload } from '../../application/use-cases/withholding-use-cases.js';
import type { UnitOfWorkGateway } from '../../application/ports.js';

/** Eventos que consume purchasing-service (ver asyncapi.yaml). */
export const CONSUMED_BINDINGS = [
  'fiscal.ec.withholding.issued',
] as const;

export interface ConsumerDeps {
  uowGateway: UnitOfWorkGateway;
  systemUserId: string;
}

export function buildEventHandlers(deps: ConsumerDeps): EventHandler[] {
  const withholdingIssued = new HandleWithholdingIssuedUseCase(deps.uowGateway, () => new Date());

  return [
    {
      eventType: 'fiscal.ec.withholding.issued',
      handle: async (payload: unknown): Promise<void> => {
        // El payload real de fiscal NO trae `billId`: la factura se encuentra por proveedor y número del documento sustento.
        const result = await withholdingIssued.execute(payload as WithholdingIssuedPayload);
        if (result.outcome === 'ignored') console.info(`[purchasing-service] retención ignorada: ${result.reason}`);
      },
    },
  ];
}

export async function startEventConsumers(params: {
  sequelize: Sequelize;
  rabbitmqUrl: string;
  exchange: string;
  queue: string;
  handlers: EventHandler[];
  systemUserId: string;
  uowGateway: UnitOfWorkGateway;
}): Promise<void> {
  const consumer = new InboxConsumer({
    sequelize: params.sequelize,
    rabbitmqUrl: params.rabbitmqUrl,
    exchange: params.exchange,
    queue: params.queue,
    // La cola debe estar bindeada a los eventos que este servicio consume (ver asyncapi.yaml).
    bindings: [...CONSUMED_BINDINGS],
    handlers: params.handlers,
  });
  await consumer.start();
  console.log('[purchasing-service] event consumers started');
}