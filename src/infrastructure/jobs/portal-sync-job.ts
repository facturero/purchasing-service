import { sequelize } from '../persistence/sequelize.js';
import { SequelizeSriPortalConfigRepository } from '../persistence/sri-portal-config-repository.js';

export function startPortalSyncJob(params: { runForOrg: (orgId: string) => Promise<void>; intervalMinutes: number }) {
  const repo = new SequelizeSriPortalConfigRepository(sequelize);
  let running = false;
  
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      const [rows] = await sequelize.query("SELECT organization_id FROM purchasing_sri_portal_config WHERE enabled = 1 AND blocked_by_sri = 0 AND (login_blocked_until IS NULL OR login_blocked_until < NOW())") as any;
      const list = Array.isArray(rows) ? rows : [];
      for (const r of list) {
        try {
          await params.runForOrg(r.organization_id);
        } catch (err: any) {
          console.error(`[portal-sync] error org ${r.organization_id}:`, err.message);
          await repo.upsert(r.organization_id, { lastStatus: 'error', lastError: err.message?.slice(0, 500) } as any);
        }
      }
    } catch (err) {
      console.error('[portal-sync] tick error:', err);
    } finally {
      running = false;
    }
  };

  const first = setTimeout(() => void tick(), 120_000);
  const timer = setInterval(() => void tick(), params.intervalMinutes * 60_000);
  return () => { clearTimeout(first); clearInterval(timer); };
}
