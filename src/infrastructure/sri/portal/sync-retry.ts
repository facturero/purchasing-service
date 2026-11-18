/**
 * Orquesta los intentos de una corrida del portal: ejecuta `runOnce` y, si falla **sin
 * haber hecho ningún periodo**, reintenta una vez con estado limpio (el perfil de Chrome
 * se borra en `onFailure`). Ver «El captcha: el perfil de Chrome» en IMPLEMENTATION.md.
 *
 * Vive aparte del job para poder probar la decisión —cuándo reintentar y cuándo no— sin
 * levantar navegador ni base de datos.
 */
export interface SyncAttemptResult {
  /** Periodos completados en el intento (el cursor ya avanzó por ellos). */
  synced: number;
  /** Error del intento, si lo hubo. */
  error?: unknown;
}

export interface SyncRetryOptions {
  /** Total de intentos permitidos (por defecto 2). */
  maxAttempts?: number;
  /** Espera entre intentos (por defecto 5 s). */
  delayMs?: number;
  /** Inyectable en pruebas para no esperar de verdad. */
  sleep?: (ms: number) => Promise<void>;
}

export async function runSyncWithRetry(
  runOnce: () => Promise<SyncAttemptResult>,
  isAuthError: (error: unknown) => boolean,
  onFailure: (error: unknown, synced: number, willRetry: boolean) => Promise<void>,
  options: SyncRetryOptions = {},
): Promise<void> {
  const maxAttempts = Math.max(1, options.maxAttempts ?? 2);
  const delayMs = options.delayMs ?? 5_000;
  const sleep = options.sleep ?? ((ms) => new Promise<void>((r) => setTimeout(r, ms)));

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const { synced, error } = await runOnce();
    if (!error) return;
    // Un fallo de credenciales no se arregla con un perfil limpio.
    if (isAuthError(error)) {
      await onFailure(error, synced, false);
      return;
    }
    // Solo se reintenta si no se avanzó nada: con el cursor ya movido, rehacer la corrida
    // solo castiga al portal, que limita las consultas repetidas.
    const willRetry = synced === 0 && attempt < maxAttempts;
    await onFailure(error, synced, willRetry);
    if (!willRetry) return;
    await sleep(delayMs);
  }
}
