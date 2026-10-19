import { FiscalServiceUnavailableError } from '../../domain/errors.js';
import type { FiscalPort } from '../../application/ports.js';

/** Respuesta de fiscal-ecuador al crear/recuperar un documento de retención. */
interface FiscalWithholdingDoc {
  id: string;
  authorizationNumber: string;
  authorizedAt: string;
}

/** Cliente HTTP simple con timeout y reintentos acotados para fiscal-ecuador. */
export class HttpFiscalPort implements FiscalPort {
  constructor(
    private readonly baseUrl: string,
    private readonly timeoutMs = 15_000,
    private readonly maxRetries = 2,
  ) {}

  async issueWithholding(params: {
    organizationId: string;
    billId: string;
    idempotencyKey: string;
    withholdingLines: Array<{ taxCode: string; taxPercentage: string; baseCents: number; taxCents: number }>;
  }): Promise<{ documentId: string; authorizationNumber: string; authorizedAt: string }> {
    const url = `${this.baseUrl}/fiscal/withholdings`;

    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), this.timeoutMs);

      try {
        const response = await fetch(url, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-Organization-Id': params.organizationId,
            'X-Idempotency-Key': params.idempotencyKey,
          },
          body: JSON.stringify({
            // fiscal-ecuador espera este formato (ver su direct-documents)
            documentType: '07', // retención
            // La factura de compra es el "sustento"
            sustento: {
              tipoComprobante: '01', // factura
              establecimiento: '', // se rellena en fiscal desde la factura
              puntoEmision: '',
              secuencial: '',
            },
            // Líneas de retención elegidas por el usuario
            lines: params.withholdingLines.map((l) => ({
              taxCode: l.taxCode,
              taxPercentage: l.taxPercentage,
              baseImponible: (l.baseCents / 100).toFixed(2),
              valorRetenido: (l.taxCents / 100).toFixed(2),
            })),
          }),
          signal: controller.signal,
        });

        clearTimeout(timeout);

        if (!response.ok) {
          const err = (await response.json().catch(() => ({ message: 'Error fiscal' }))) as { code?: string; message?: string };
          // Si es 409 por duplicado (idempotency), devolvemos el existente
          if (response.status === 409 && err.code === 'DUPLICATE_DOCUMENT') {
            // fiscal-ecuador debería devolver el documento existente
            const existing = (await fetch(`${url}/by-idempotency/${params.idempotencyKey}`, {
              headers: { 'X-Organization-Id': params.organizationId },
            }).then((r) => r.json())) as FiscalWithholdingDoc;
            return {
              documentId: existing.id,
              authorizationNumber: existing.authorizationNumber,
              authorizedAt: existing.authorizedAt,
            };
          }
          throw new FiscalServiceUnavailableError(`Fiscal error ${response.status}: ${err.message ?? 'Error desconocido'}`);
        }

        const data = (await response.json()) as FiscalWithholdingDoc;
        return {
          documentId: data.id,
          authorizationNumber: data.authorizationNumber,
          authorizedAt: data.authorizedAt,
        };
      } catch (e) {
        clearTimeout(timeout);
        if (attempt === this.maxRetries) {
          if (e instanceof FiscalServiceUnavailableError) throw e;
          throw new FiscalServiceUnavailableError(`Fiscal service unreachable after ${this.maxRetries + 1} attempts: ${e instanceof Error ? e.message : String(e)}`);
        }
        // Backoff exponencial simple
        await new Promise((r) => setTimeout(r, 500 * Math.pow(2, attempt)));
      }
    }
    throw new FiscalServiceUnavailableError('Max retries exceeded');
  }
}