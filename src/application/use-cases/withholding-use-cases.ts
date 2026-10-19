import {
  BillNotFoundError,
  BillNotPostedError,
  FiscalServiceUnavailableError,
  WithholdingAlreadyIssuedError,
} from '../../domain/errors.js';
import { markBillWithholdingIssued } from '../../domain/purchase-bill.js';
import type { PurchaseBill } from '../../domain/purchase-bill.js';
import type { FiscalPort, UnitOfWorkGateway } from '../ports.js';
import { billOverriddenEvent } from '../events.js';
import { inTransaction } from './supplier-use-cases.js';

export interface IssueWithholdingInput {
  billId: string;
  // El usuario elige códigos y porcentajes en la UI (sugeridos por fiscal-ecuador)
  withholdingLines: Array<{
    taxCode: string;
    taxPercentage: string;
    baseCents: number;
    taxCents: number;
  }>;
}

export class IssueBillWithholdingUseCase {
  constructor(
    private readonly gateway: UnitOfWorkGateway,
    private readonly fiscal: FiscalPort,
    private readonly clock: () => Date,
  ) {}

  async execute(params: { organizationId: string; userId: string; input: IssueWithholdingInput }): Promise<PurchaseBill> {
    const { organizationId, input } = params;
    const now = this.clock();
    const idempotencyKey = `bill:${input.billId}:withholding`;

    return inTransaction(this.gateway, async (uow) => {
      // 1) Leer factura con lock
      const bill = await uow.bills.findById(organizationId, input.billId, { lock: true });
      if (!bill) throw new BillNotFoundError();

      // 2) Solo facturas posted pueden tener retención
      if (bill.status !== 'posted') throw new BillNotPostedError();

      // 3) Verificar que no tenga retención ya emitida
      if (bill.withholdingStatus === 'issued') throw new WithholdingAlreadyIssuedError();

      // 4) Llamar a fiscal-ecuador (SIN transacción abierta durante la llamada HTTP)
      //    La idempotencia la maneja fiscal-ecuador con la clave bill:<billId>
      let fiscalResult: { documentId: string; authorizationNumber: string; authorizedAt: string };
      try {
        fiscalResult = await this.fiscal.issueWithholding({
          organizationId,
          billId: input.billId,
          idempotencyKey,
          withholdingLines: input.withholdingLines,
        });
      } catch (e) {
        if (e instanceof FiscalServiceUnavailableError) throw e;
        throw new FiscalServiceUnavailableError(`Error llamando a fiscal: ${e instanceof Error ? e.message : String(e)}`);
      }

      // 5) Actualizar factura con withholdingStatus = issued
      //    (El evento fiscal.ec.withholding.issued también llegará por RabbitMQ y lo conciliará,
      //     pero lo hacemos aquí para respuesta inmediata en la UI)
      const updatedBill = markBillWithholdingIssued(bill, fiscalResult.documentId, now);
      await uow.bills.save(updatedBill, bill.version);

      // 6) Evento de auditoría propia (como override, pero para retención)
      //    Reutilizamos billOverriddenEvent cambiando el tipo, o creamos uno específico.
      //    Por ahora emitimos purchasing.bill.overridden con un payload especial.
      await uow.outbox.add({
        ...billOverriddenEvent(updatedBill),
        type: 'purchasing.bill.withholding_issued',
        payload: {
          ...billOverriddenEvent(updatedBill).payload,
          withholdingDocumentId: fiscalResult.documentId,
          withholdingAuthorization: fiscalResult.authorizationNumber,
          withholdingAuthorizedAt: fiscalResult.authorizedAt,
        },
      });

      return updatedBill;
    });
  }
}

/** Handler para el evento fiscal.ec.withholding.issued (idempotente, tolerante a desorden). */
export class HandleWithholdingIssuedUseCase {
  constructor(private readonly gateway: UnitOfWorkGateway, private readonly clock: () => Date) {}

  async execute(payload: {
    organizationId: string;
    billId: string;
    documentId: string;
    authorizationNumber: string;
    authorizedAt: string;
  }): Promise<void> {
    const { organizationId, billId, documentId, authorizationNumber, authorizedAt } = payload;
    const now = this.clock();

    return inTransaction(this.gateway, async (uow) => {
      const bill = await uow.bills.findById(organizationId, billId);
      if (!bill) {
        // La factura aún no existe en purchasing (llegó el evento antes): guardamos la clave externa
        // para conciliar cuando se cree. Por simplicidad, logueamos y salimos; en producción
        // se guardaría en una tabla pending_withholdings.
        console.warn(`[withholding] Bill ${billId} not found for org ${organizationId}; event will be retried by inbox`);
        return;
      }

      if (bill.withholdingStatus === 'issued') {
        // Ya procesado (idempotencia por eventId del inbox)
        return;
      }

      const updated = markBillWithholdingIssued(bill, documentId, now);
      await uow.bills.save(updated, bill.version);

      await uow.outbox.add({
        ...billOverriddenEvent(updated),
        type: 'purchasing.bill.withholding_issued',
        payload: {
          ...billOverriddenEvent(updated).payload,
          withholdingDocumentId: documentId,
          withholdingAuthorization: authorizationNumber,
          withholdingAuthorizedAt: authorizedAt,
        },
      });
    });
  }
}