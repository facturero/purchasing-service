import type { FetchSummary } from '../../application/use-cases/received-document-use-cases.js';

/**
 * Corre `run` cada `intervalMinutes`, sin solaparse: si una corrida tarda más que el intervalo (el SRI contesta lento), la siguiente
 * se salta en vez de apilarse. Un fallo no mata el temporizador. Asume UNA réplica del servicio; con varias, la relectura con bloqueo
 * del caso de uso evita que dos procesen el mismo documento, pero ambos consultarían al SRI.
 * Devuelve la función que lo detiene.
 */
export function startReceivedDocumentsJob(params: { run: () => Promise<FetchSummary>; intervalMinutes: number }): () => void {
  let running = false;
  const tick = async (): Promise<void> => {
    if (running) return;
    running = true;
    try {
      const s = await params.run();
      if (s.attempted > 0) {
        console.log(`[purchasing-service] comprobantes recibidos: ${s.downloaded} bajados, ${s.retrying} por reintentar, ${s.needsPortal} para el portal, ${s.notAuthorized} no autorizados, ${s.failed} fallidos`);
      }
    } catch (err) {
      console.error('[purchasing-service] falló la corrida de comprobantes recibidos:', err);
    } finally {
      running = false;
    }
  };
  // La primera a los 60 s: deja arrancar el servicio y la base antes de hablar con el SRI.
  const first = setTimeout(() => void tick(), 60_000);
  const timer = setInterval(() => void tick(), params.intervalMinutes * 60_000);
  return () => {
    clearTimeout(first);
    clearInterval(timer);
  };
}
