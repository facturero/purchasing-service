import { describe, expect, it, vi } from 'vitest';
import { runSyncWithRetry } from '../infrastructure/sri/portal/sync-retry.js';

/** Cubre la decisión de reintentar, que es lo único no trivial del bucle de la corrida. */
describe('runSyncWithRetry', () => {
  const noSleep = () => Promise.resolve();
  const isAuthError = (e: unknown) => e instanceof Error && e.message === 'auth';
  const options = { maxAttempts: 2, sleep: noSleep };

  it('no llama a onFailure si el primer intento pasa', async () => {
    const runOnce = vi.fn().mockResolvedValue({ synced: 2 });
    const onFailure = vi.fn().mockResolvedValue(undefined);
    await runSyncWithRetry(runOnce, isAuthError, onFailure, options);
    expect(runOnce).toHaveBeenCalledTimes(1);
    expect(onFailure).not.toHaveBeenCalled();
  });

  it('reintenta una vez si falla sin haber hecho periodos, y se recupera', async () => {
    const runOnce = vi.fn()
      .mockResolvedValueOnce({ synced: 0, error: new Error('boom') })
      .mockResolvedValueOnce({ synced: 1 });
    const onFailure = vi.fn().mockResolvedValue(undefined);
    await runSyncWithRetry(runOnce, isAuthError, onFailure, options);
    expect(runOnce).toHaveBeenCalledTimes(2);
    expect(onFailure).toHaveBeenCalledTimes(1);
    expect(onFailure).toHaveBeenCalledWith(expect.any(Error), 0, true);
  });

  it('no reintenta si ya hizo algún periodo (el cursor ya avanzó)', async () => {
    const runOnce = vi.fn().mockResolvedValue({ synced: 1, error: new Error('boom') });
    const onFailure = vi.fn().mockResolvedValue(undefined);
    await runSyncWithRetry(runOnce, isAuthError, onFailure, options);
    expect(runOnce).toHaveBeenCalledTimes(1);
    expect(onFailure).toHaveBeenCalledWith(expect.any(Error), 1, false);
  });

  it('no reintenta un fallo de credenciales', async () => {
    const runOnce = vi.fn().mockResolvedValue({ synced: 0, error: new Error('auth') });
    const onFailure = vi.fn().mockResolvedValue(undefined);
    await runSyncWithRetry(runOnce, isAuthError, onFailure, options);
    expect(runOnce).toHaveBeenCalledTimes(1);
    expect(onFailure).toHaveBeenCalledWith(expect.any(Error), 0, false);
  });

  it('se rinde tras agotar los intentos', async () => {
    const runOnce = vi.fn().mockResolvedValue({ synced: 0, error: new Error('boom') });
    const onFailure = vi.fn().mockResolvedValue(undefined);
    await runSyncWithRetry(runOnce, isAuthError, onFailure, options);
    expect(runOnce).toHaveBeenCalledTimes(2);
    expect(onFailure).toHaveBeenLastCalledWith(expect.any(Error), 0, false);
  });
});
