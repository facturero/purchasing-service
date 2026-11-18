import { Sequelize } from 'sequelize';
import type { SriPortalConfigRecord, SriPortalConfigRepository } from '../../application/ports.js';

interface Row {
  organization_id: string;
  username: string | null;
  password_enc: string | null;
  enabled: number | boolean;
  last_run_at: Date | null;
  last_status: string | null;
  last_error: string | null;
  updated_at: Date;
  updated_by: string | null;
  login_fail_count: number;
  login_blocked_until: Date | null;
  last_login_test_at: Date | null;
  last_login_test_ok: number | boolean;
  blocked_by_sri: number | boolean;
  blocked_reason: string | null;
  sync_cursor_period: string | null;
}

export class SequelizeSriPortalConfigRepository implements SriPortalConfigRepository {
  constructor(private readonly sequelize: Sequelize) {}

  private map(r: Row): SriPortalConfigRecord {
    return {
      organizationId: r.organization_id,
      username: r.username,
      passwordEnc: r.password_enc,
      enabled: !!r.enabled,
      lastRunAt: r.last_run_at,
      lastStatus: r.last_status,
      lastError: r.last_error,
      updatedAt: r.updated_at,
      updatedBy: r.updated_by,
      loginFailCount: Number(r.login_fail_count || 0),
      loginBlockedUntil: r.login_blocked_until,
      lastLoginTestAt: r.last_login_test_at,
      lastLoginTestOk: !!r.last_login_test_ok,
      blockedBySri: !!r.blocked_by_sri,
      blockedReason: r.blocked_reason,
      syncCursorPeriod: r.sync_cursor_period ?? null,
    };
  }

  async get(organizationId: string): Promise<SriPortalConfigRecord | null> {
    const [rows] = await this.sequelize.query('SELECT * FROM purchasing_sri_portal_config WHERE organization_id = ?', { replacements: [organizationId] }) as any;
    const list = Array.isArray(rows) ? rows : [];
    const r = list[0] as Row | undefined;
    if (!r) return null;
    return this.map(r);
  }

  async upsert(organizationId: string, patch: Partial<Omit<SriPortalConfigRecord, 'organizationId'>> & { updatedBy?: string | null }): Promise<SriPortalConfigRecord> {
    const existing = await this.get(organizationId);
    const enabled = patch.enabled === undefined ? (existing?.enabled ? 1 : 0) : (patch.enabled ? 1 : 0);
    await this.sequelize.query(
      `INSERT INTO purchasing_sri_portal_config (organization_id, username, password_enc, enabled, last_run_at, last_status, last_error, updated_by, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, NOW())
       ON DUPLICATE KEY UPDATE
         username = COALESCE(VALUES(username), username),
         password_enc = COALESCE(VALUES(password_enc), password_enc),
         enabled = COALESCE(VALUES(enabled), enabled),
         last_run_at = COALESCE(VALUES(last_run_at), last_run_at),
         last_status = COALESCE(VALUES(last_status), last_status),
         last_error = COALESCE(VALUES(last_error), last_error),
         updated_by = COALESCE(VALUES(updated_by), updated_by),
         updated_at = NOW()`,
      { replacements: [
        organizationId,
        (patch as any).username ?? existing?.username ?? null,
        (patch as any).passwordEnc ?? existing?.passwordEnc ?? null,
        enabled,
        patch.lastRunAt ?? existing?.lastRunAt ?? null,
        patch.lastStatus ?? existing?.lastStatus ?? null,
        patch.lastError ?? existing?.lastError ?? null,
        patch.updatedBy ?? existing?.updatedBy ?? null,
      ] }
    );
    const r = await this.get(organizationId);
    return r!;
  }

  async incrementFail(organizationId: string, reason?: string): Promise<SriPortalConfigRecord> {
    await this.sequelize.query(
      `INSERT INTO purchasing_sri_portal_config (organization_id, login_fail_count, last_login_test_at, last_login_test_ok, updated_at)
       VALUES (?, 1, NOW(), 0, NOW())
       ON DUPLICATE KEY UPDATE
         login_fail_count = login_fail_count + 1,
         last_login_test_at = NOW(),
         last_login_test_ok = 0,
         blocked_reason = ?,
         updated_at = NOW()`,
      { replacements: [organizationId, reason ?? 'Usuario o contraseña incorrectos'] }
    );
    const r = await this.get(organizationId);
    return r!;
  }

  async markBlocked(organizationId: string, reason: string): Promise<SriPortalConfigRecord> {
    await this.sequelize.query(
      `INSERT INTO purchasing_sri_portal_config (organization_id, blocked_by_sri, enabled, blocked_reason, login_blocked_until, last_login_test_at, last_login_test_ok, updated_at)
       VALUES (?, 1, 0, ?, NOW(), NOW(), 0, NOW())
       ON DUPLICATE KEY UPDATE
         blocked_by_sri = 1,
         enabled = 0,
         blocked_reason = ?,
         login_blocked_until = NOW(),
         last_login_test_at = NOW(),
         last_login_test_ok = 0,
         updated_at = NOW()`,
      { replacements: [organizationId, reason, reason] }
    );
    const r = await this.get(organizationId);
    return r!;
  }

  async resetOnSuccess(organizationId: string, username: string, passwordEnc: string, updatedBy?: string | null): Promise<SriPortalConfigRecord> {
    await this.sequelize.query(
      `INSERT INTO purchasing_sri_portal_config (organization_id, username, password_enc, enabled, login_fail_count, blocked_by_sri, login_blocked_until, last_login_test_at, last_login_test_ok, blocked_reason, updated_by, updated_at)
       VALUES (?, ?, ?, 0, 0, 0, NULL, NOW(), 1, NULL, ?, NOW())
       ON DUPLICATE KEY UPDATE
         username = ?,
         password_enc = ?,
         login_fail_count = 0,
         blocked_by_sri = 0,
         login_blocked_until = NULL,
         last_login_test_at = NOW(),
         last_login_test_ok = 1,
         blocked_reason = NULL,
         enabled = 0,
         updated_by = ?,
         updated_at = NOW()`,
      { replacements: [organizationId, username, passwordEnc, updatedBy ?? null, username, passwordEnc, updatedBy ?? null] }
    );
    const r = await this.get(organizationId);
    return r!;
  }

  async markRunOk(organizationId: string): Promise<SriPortalConfigRecord> {
    // No toca `enabled`: encender o apagar la sincronización es decisión del usuario,
    // no un efecto secundario de una corrida correcta (antes se apagaba sola).
    await this.sequelize.query(
      `UPDATE purchasing_sri_portal_config
          SET login_fail_count = 0,
              login_blocked_until = NULL,
              blocked_by_sri = 0,
              blocked_reason = NULL,
              last_login_test_at = NOW(),
              last_login_test_ok = 1,
              last_run_at = NOW(),
              last_status = 'ok',
              last_error = NULL,
              updated_at = NOW()
        WHERE organization_id = ?`,
      { replacements: [organizationId] }
    );
    const r = await this.get(organizationId);
    return r!;
  }

  async setSyncCursor(organizationId: string, period: string | null): Promise<void> {
    await this.sequelize.query(
      `UPDATE purchasing_sri_portal_config SET sync_cursor_period = ?, updated_at = NOW() WHERE organization_id = ?`,
      { replacements: [period, organizationId] }
    );
  }
}
