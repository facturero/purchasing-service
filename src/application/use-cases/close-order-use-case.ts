import { OrderNotFoundError, ValidationError } from '../../domain/errors.js';
import type { PurchaseOrder } from '../../domain/purchase-order.js';
import type { UnitOfWorkGateway } from '../ports.js';
import { inTransaction } from './supplier-use-cases.js';
import { orderClosedEvent } from '../events.js';

export interface CloseOrderInput {
  orderId: string;
  userId: string;
  reason: string;
}

/** Cierre manual de una orden: da por terminado lo pendiente (el proveedor no enviará el resto).
 *  Solo desde estados `approved` o `partially_received`. La orden pasa a `closed`. */
export class CloseOrderUseCase {
  constructor(private readonly gateway: UnitOfWorkGateway, private readonly clock: () => Date) {}

  async execute(params: { organizationId: string; input: CloseOrderInput }): Promise<PurchaseOrder> {
    const { organizationId, input } = params;
    const now = this.clock();

    return inTransaction(this.gateway, async (uow) => {
      const order = await uow.orders.findById(organizationId, input.orderId, { lock: true });
      if (!order) throw new OrderNotFoundError();

      if (!['approved', 'partially_received'].includes(order.status)) {
        throw new ValidationError([{ field: 'order', message: `No se puede cerrar una orden en estado "${order.status}". Solo approved o partially_received.` }]);
      }

      const trimmed = input.reason.trim();
      if (trimmed.length < 5) throw new ValidationError([{ field: 'reason', message: 'El motivo debe tener al menos 5 caracteres.' }]);

      const closedOrder = { ...order, status: 'closed' as const, updatedAt: now, version: order.version + 1 };
      await uow.orders.save(closedOrder, order.version);

      await uow.outbox.add(orderClosedEvent(closedOrder, trimmed.slice(0, 300)));
      return closedOrder;
    });
  }
}