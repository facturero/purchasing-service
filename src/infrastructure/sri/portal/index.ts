import { createCaptchaSolver } from './captcha-solver.js';
import { PuppeteerSriPortalClient } from './portal-client.js';
import type { SriPortalPort } from '../../../application/ports.js';

export { wipePortalProfile } from './profile-store.js';

export function createSriPortalClient(): SriPortalPort {
  const solver = createCaptchaSolver();
  return new PuppeteerSriPortalClient(solver);
}
