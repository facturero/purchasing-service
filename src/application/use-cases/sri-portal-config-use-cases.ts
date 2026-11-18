import { encrypt } from '../../infrastructure/crypto/encrypt.js';
import { SriPortalBadCredentialsError, SriPortalBlockedError, SriPortalNotConfiguredError } from '../../domain/sri-portal.js';
import type { SriPortalConfigRepository, UnitOfWorkGateway } from '../ports.js';
import { createSriPortalClient } from '../../infrastructure/sri/portal/index.js';
import { config } from '../../infrastructure/config.js';
import { sriPortalCredentialsInvalidEvent } from '../events.js';
import { inTransaction } from './supplier-use-cases.js';

export class GetSriPortalConfigUseCase {
  constructor(private readonly repo: SriPortalConfigRepository) {}

  async execute(params: { organizationId: string }) {
    const cfg = await this.repo.get(params.organizationId);
    if (!cfg) {
      return {
        organizationId: params.organizationId,
        username: null,
        hasPassword: false,
        enabled: false,
        lastRunAt: null,
        lastStatus: null,
        lastError: null,
        updatedAt: new Date(),
        loginFailCount: 0,
        maxAttempts: config.SRI_PORTAL_MAX_LOGIN_ATTEMPTS,
        attemptsLeft: config.SRI_PORTAL_MAX_LOGIN_ATTEMPTS,
        blockedBySri: false,
        blockedReason: null,
      };
    }
    const attemptsLeft = Math.max(0, config.SRI_PORTAL_MAX_LOGIN_ATTEMPTS - cfg.loginFailCount);
    return {
      organizationId: cfg.organizationId,
      username: cfg.username,
      hasPassword: !!cfg.passwordEnc,
      enabled: cfg.enabled && !cfg.blockedBySri,
      lastRunAt: cfg.lastRunAt,
      lastStatus: cfg.lastStatus,
      lastError: cfg.lastError,
      updatedAt: cfg.updatedAt,
      loginFailCount: cfg.loginFailCount,
      maxAttempts: config.SRI_PORTAL_MAX_LOGIN_ATTEMPTS,
      attemptsLeft,
      blockedBySri: cfg.blockedBySri,
      blockedReason: cfg.blockedReason,
      lastLoginTestOk: cfg.lastLoginTestOk,
    };
  }
}

export class SaveSriPortalCredentialsUseCase {
  constructor(private readonly repo: SriPortalConfigRepository, private readonly gateway: UnitOfWorkGateway) {}

  async execute(params: { organizationId: string; userId: string; username: string; password: string }) {
    const current = await this.repo.get(params.organizationId);
    if (current?.blockedBySri && current.loginFailCount >= config.SRI_PORTAL_MAX_LOGIN_ATTEMPTS) {
      throw new SriPortalBlockedError('La cuenta está bloqueada por intentos fallidos. Guarda credenciales correctas para desbloquear.');
    }

    const client = createSriPortalClient();
    try {
      await client.login(params.username, params.password);
      await client.close();
    } catch (err: any) {
      await client.close();
      const currentState = await this.repo.get(params.organizationId);
      if (currentState?.blockedBySri && (currentState.loginFailCount || 0) >= config.SRI_PORTAL_MAX_LOGIN_ATTEMPTS) {
        const formUrl = `${config.CRM_BASE_URL}/purchasing/received-documents`;
        throw new SriPortalBlockedError(`La cuenta está bloqueada por intentos fallidos. Guarda credenciales correctas para desbloquear. ${formUrl}`);
      }
      const updated = await this.repo.incrementFail(params.organizationId, 'Usuario o contraseña incorrectos');
      const attemptsLeft = Math.max(0, config.SRI_PORTAL_MAX_LOGIN_ATTEMPTS - updated.loginFailCount);
      
      if (updated.loginFailCount >= config.SRI_PORTAL_MAX_LOGIN_ATTEMPTS) {
        await this.repo.markBlocked(params.organizationId, 'Usuario o contraseña incorrectos - límite de intentos alcanzado');
        const formUrl = `${config.CRM_BASE_URL}/purchasing/received-documents`;
        try {
          await inTransaction(this.gateway, async (uow) => {
            await uow.outbox.add(sriPortalCredentialsInvalidEvent({
              organizationId: params.organizationId,
              username: params.username,
              attemptsLeft: 0,
              maxAttempts: config.SRI_PORTAL_MAX_LOGIN_ATTEMPTS,
              blocked: true,
              formUrl,
            }));
          });
        } catch {}
        throw new SriPortalBlockedError(`Usuario o contraseña incorrectos. Se alcanzó el límite de ${config.SRI_PORTAL_MAX_LOGIN_ATTEMPTS} intentos. La sincronización ha sido bloqueada para proteger la cuenta del SRI. Vuelva a escribir sus credenciales correctas en: ${formUrl}`);
      }

      const formUrl = `${config.CRM_BASE_URL}/purchasing/received-documents`;
      try {
        await inTransaction(this.gateway, async (uow) => {
          await uow.outbox.add(sriPortalCredentialsInvalidEvent({
            organizationId: params.organizationId,
            username: params.username,
            attemptsLeft,
            maxAttempts: config.SRI_PORTAL_MAX_LOGIN_ATTEMPTS,
            blocked: false,
            formUrl,
          }));
        });
      } catch {}
      throw new SriPortalBadCredentialsError(`Usuario o contraseña incorrectos. Le quedan ${attemptsLeft} intento(s) antes de que el portal del SRI se bloquee y nosotros bloqueemos la sincronización. Actualice sus credenciales en: ${formUrl}`);
    }

    const passwordEnc = encrypt(params.password);
    await this.repo.resetOnSuccess(params.organizationId, params.username, passwordEnc, params.userId);
    return { ok: true, message: 'Login correcto. Credenciales guardadas.' };
  }
}

export class SetSriPortalEnabledUseCase {
  constructor(private readonly repo: SriPortalConfigRepository) {}

  async execute(params: { organizationId: string; userId: string; enabled: boolean }) {
    const cfg = await this.repo.get(params.organizationId);
    if (params.enabled) {
      if (!cfg?.username || !cfg?.passwordEnc) throw new SriPortalNotConfiguredError('Configura usuario y contraseña antes de activar el cron.');
      if (cfg?.blockedBySri) throw new SriPortalBlockedError('La sincronización está bloqueada por intentos fallidos. Vuelve a guardar credenciales correctas.');
    }
    await this.repo.upsert(params.organizationId, { enabled: params.enabled, updatedBy: params.userId });
    return { ok: true, enabled: params.enabled };
  }
}
