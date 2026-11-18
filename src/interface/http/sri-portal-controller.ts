import type { Context } from 'hono';
import type {
  GetSriPortalConfigUseCase,
  SaveSriPortalCredentialsUseCase,
  SetSriPortalEnabledUseCase,
} from '../../application/use-cases/sri-portal-config-use-cases.js';


type Vars = { Variables: { organizationId: string; userId: string; permissions: string[] } };
type Ctx = Context<Vars>;

export class SriPortalController {
  constructor(
    private readonly getConfig: GetSriPortalConfigUseCase,
    private readonly saveCreds: SaveSriPortalCredentialsUseCase,
    private readonly setEnabled: SetSriPortalEnabledUseCase,
  ) {}

  getConfigHandler = async (c: Ctx) => {
    const orgId = c.get('organizationId');
    const res = await this.getConfig.execute({ organizationId: orgId });
    return c.json(res);
  };

  saveCredentials = async (c: Ctx) => {
    const orgId = c.get('organizationId');
    const userId = c.get('userId');
    const body = await c.req.json();
    await this.saveCreds.execute({ organizationId: orgId, userId, username: body.username, password: body.password });
    return c.json({ ok: true });
  };

  enable = async (c: Ctx) => {
    const orgId = c.get('organizationId');
    const userId = c.get('userId');
    const res = await this.setEnabled.execute({ organizationId: orgId, userId, enabled: true });
    return c.json(res);
  };

  disable = async (c: Ctx) => {
    const orgId = c.get('organizationId');
    const userId = c.get('userId');
    const res = await this.setEnabled.execute({ organizationId: orgId, userId, enabled: false });
    return c.json(res);
  };
}
