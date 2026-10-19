import { EventHandler, InboxConsumer } from '@facturero/outbox-relay';
import type { Sequelize } from 'sequelize';
import { HandleWithholdingIssuedUseCase } from '../../application/use-cases/withholding-use-cases.js';
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
        const p = payload as {
          organizationId: string;
          billId: string;
          documentId: string;
          authorizationNumber: string;
          authorizedAt: string;
        };
        await withholdingIssued.execute(p);
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