import { applyReceipt, RECEIVABLE_STATUSES, formatReceiptNumber } from '../../domain/purchase-order.js';
import { parseQuantity, lineGrossCents } from '../../domain/money.js';
import { OrderNotFoundError, OrderNotReceivableError } from '../../domain/errors.js';
import type { PurchaseOrder } from '../../domain/purchase-order.js';
import type { UnitOfWorkGateway } from '../ports.js';
import { inTransaction } from './supplier-use-cases.js';
import { purchaseOrderReceivedEvent, receiptPostedEvent, orderReceivedEvent } from '../events.js';

export interface ReceiveOrderInput {
  orderId: string;
  userId: string;
  receiptDate: string; // AAAA-MM-DD
  supplierDeliveryRef?: string | null;
  notes?: string | null;
  lines: { orderLineId: string; quantity: string }[]; // cantidad como texto para preservar decimales
}

/** Registra una recepción de mercadería contra una orden aprobada/partially_received.
 *  - Bloquea la orden (SELECT ... FOR UPDATE) para concurrencia.
 *  - Valida estado, líneas, cantidades, tolerancia.
 *  - Crea goods_receipt + lines, actualiza receivedMicros, cambia estado de la orden.
 *  - Publica eventos: purchase.purchase_order.received, purchasing.receipt.posted, purchasing.order.received (si aplica).
 *  - Todo en una transacción. */
export class ReceiveOrderUseCase {
  constructor(private readonly gateway: UnitOfWorkGateway, private readonly clock: () => Date) {}

  async execute(params: { organizationId: string; input: ReceiveOrderInput }): Promise<{ order: PurchaseOrder; receiptId: string; receiptNumber: string }> {
    const { organizationId, input } = params;
    const now = this.clock();
    const year = Number(input.receiptDate.slice(0, 4));

    return inTransaction(this.gateway, async (uow) => {
      // 1) Leer orden con lock
      const order = await uow.orders.findById(organizationId, input.orderId, { lock: true });
      if (!order) throw new OrderNotFoundError();

      // 2) Validar estado recepcionable
      if (!RECEIVABLE_STATUSES.includes(order.status)) throw new OrderNotReceivableError();

      // 3) Obtener settings (tolerancia)
      const settings = await uow.settings.find(organizationId);
      const toleranceBp = settings?.overReceiptToleranceBp ?? 0;

      // 4) Parsear y validar líneas de entrada
      const receiptLines = input.lines.map((l) => ({
        orderLineId: l.orderLineId,
        quantityMicros: parseQuantity(l.quantity, 'quantity'),
      }));

      // 5) Aplicar recepción al dominio (valida pertenencia, cantidad>0, tolerancia, duplicados)
      const updatedOrder = applyReceipt({
        order,
        receiptLines,
        toleranceBp,
        now,
      });

      // 6) Generar número de recepción RM-AAAA-NNNNNN
      const seq = await uow.receipts.nextReceiptSequence(organizationId, year);
      const receiptNumber = formatReceiptNumber(year, seq);
      const receiptId = crypto.randomUUID();

      // 7) Crear receipt y líneas
      const supplierId = order.supplierId;
      const warehouseId = order.warehouseId;
      const receipt = {
        id: receiptId,
        organizationId,
        number: receiptNumber,
        purchaseOrderId: order.id,
        supplierId,
        warehouseId,
        receiptDate: input.receiptDate,
        supplierDeliveryRef: input.supplierDeliveryRef ?? null,
        notes: input.notes ?? null,
        createdBy: input.userId,
        createdAt: now,
      };

      const receiptLinesToSave = receiptLines.map((rl) => {
        const orderLine = order.lines.find(l => l.id === rl.orderLineId)!;
        return {
          id: crypto.randomUUID(),
          receiptId,
          orderLineId: rl.orderLineId,
          productId: orderLine.productId,
          quantityMicros: rl.quantityMicros,
          unitCostCents: orderLine.unitCostCents,
          currencyCode: order.currencyCode,
        };
      });

      await uow.receipts.save(receipt);
      await uow.receipts.saveLines(receiptLinesToSave);

      // 8) Guardar orden actualizada (con receivedMicros y nuevo estado)
      await uow.orders.save(updatedOrder, order.version);

      // 9) Publicar eventos en outbox (misma transacción)
      // 9a) Contrato con inventory-service
      await uow.outbox.add(purchaseOrderReceivedEvent({
        order: updatedOrder,
        receiptId,
        receiptNumber,
        warehouseId,
        lines: receiptLinesToSave,
      }));

      // 9b) Evento propio de purchasing para auditoría/terceros
      // Cantidad en micros × costo en centavos: un solo redondeo por línea (lineGrossCents divide entre 1e6).
      const totalCostCents = receiptLinesToSave.reduce((sum, l) => sum + lineGrossCents(l.quantityMicros, l.unitCostCents), 0);
      await uow.outbox.add(receiptPostedEvent({
        receiptId,
        receiptNumber,
        orderId: order.id,
        orderNumber: order.number,
        supplierId,
        warehouseId,
        lineCount: receiptLinesToSave.length,
        totalCostCents,
        organizationId,
      }));

      // 9c) Si la orden pasó a 'received', emitir evento específico
      if (updatedOrder.status === 'received' && order.status !== 'received') {
        await uow.outbox.add(orderReceivedEvent(updatedOrder));
      }

      return { order: updatedOrder, receiptId, receiptNumber };
    });
  }
}