/**
 * La retención de una compra NO la emite este servicio: la emite fiscal-ecuador desde su propia pantalla (Fase 1.4), a la que la
 * factura de compra lleva con los datos precargados. Aquí solo se ENTERA, por evento, de que la retención quedó autorizada.
 * (Hubo un emisor síncrono que llamaba a fiscal con un contrato inventado —campos, cabeceras y un endpoint que fiscal no tiene—;
 * se quitó: acoplaba dos servicios por HTTP para algo que ya resuelve el evento.)
 */
import { markBillWithholdingIssued } from '../../domain/purchase-bill.js';
import type { UnitOfWorkGateway } from '../ports.js';
import { billWithholdingIssuedEvent } from '../events.js';
import { inTransaction } from './supplier-use-cases.js';

/**
 * Lo que de verdad publica fiscal-ecuador en `fiscal.ec.withholding.issued` (ver `withholdingIssuedPayload` en su `stores.ts`).
 * NO trae ningún id de factura de compra: fiscal no sabe que existe este servicio. La retención cita su documento sustento por
 * número (`support.number`, 000-000-000000000) y al proveedor por su identificación; con eso se encuentra la factura.
 */
export interface WithholdingIssuedPayload {
  organizationId: string;
  withholdingId: string;
  number?: string | null;
  authorizationNumber?: string | null;
  supplier?: { identification?: string | null } | null;
  support?: { documentCode?: string | null; number?: string | null } | null;
}

export type WithholdingIssuedOutcome =
  | { outcome: 'marked'; billId: string }
  | { outcome: 'ignored'; reason: string };

const SUPPORT_NUMBER = /^(\d{3})-(\d{3})-(\d{9})$/;
const BILL_DOC_TYPES: readonly string[] = ['01', '03', '41'];

/**
 * Marca como «con retención» la factura de compra que una retención autorizada cita (idempotente, tolerante a desorden).
 *
 * Nunca lanza por «no encuentro la factura»: casi todas las retenciones se emiten sobre compras que no pasaron por este módulo
 * (o llegan antes de que la factura se contabilice), y lanzar mandaría el mensaje a reintentos y a la cola de errores por algo
 * que no es un fallo. Se ignora y queda dicho en el resultado. Solo se marca una factura CONTABILIZADA: una anulada o en
 * borrador no es el sustento de una retención válida.
 */
export class HandleWithholdingIssuedUseCase {
  constructor(private readonly gateway: UnitOfWorkGateway, private readonly clock: () => Date) {}

  async execute(payload: WithholdingIssuedPayload): Promise<WithholdingIssuedOutcome> {
    const { organizationId, withholdingId } = payload;
    const identification = payload.supplier?.identification?.trim();
    const documentCode = payload.support?.documentCode?.trim();
    const match = SUPPORT_NUMBER.exec(payload.support?.number?.trim() ?? '');
    if (!organizationId || !withholdingId) return { outcome: 'ignored', reason: 'evento sin organización o sin id de retención' };
    if (!identification || !match) return { outcome: 'ignored', reason: 'la retención no cita proveedor y número de documento sustento' };
    if (!documentCode || !BILL_DOC_TYPES.includes(documentCode)) {
      return { outcome: 'ignored', reason: `el documento sustento (${documentCode ?? 'sin código'}) no es una factura de compra` };
    }
    const [, establishment, emissionPoint, sequential] = match as unknown as [string, string, string, string];
    const now = this.clock();

    return inTransaction(this.gateway, async (uow): Promise<WithholdingIssuedOutcome> => {
      const found = await uow.bills.findBySupplierIdentificationDocument(
        organizationId, identification, documentCode as '01' | '03' | '41', establishment, emissionPoint, sequential,
      );
      if (!found) return { outcome: 'ignored', reason: 'no hay factura de compra con ese proveedor y documento' };

      // Se bloquea y se recarga: el listado por documento no trae las líneas y otra transacción puede estar contabilizándola.
      const bill = await uow.bills.findById(organizationId, found.id, { lock: true });
      if (!bill) return { outcome: 'ignored', reason: 'la factura ya no existe' };
      if (bill.status !== 'posted') return { outcome: 'ignored', reason: `la factura está ${bill.status}: solo se marca una contabilizada` };
      if (bill.withholdingStatus === 'issued') return { outcome: 'ignored', reason: 'la factura ya tiene una retención registrada' };

      const updated = markBillWithholdingIssued(bill, withholdingId, now);
      await uow.bills.save(updated, bill.version);
      await uow.outbox.add(billWithholdingIssuedEvent(updated, {
        withholdingId,
        number: payload.number ?? null,
        authorizationNumber: payload.authorizationNumber ?? null,
      }));
      return { outcome: 'marked', billId: updated.id };
    });
  }
}
