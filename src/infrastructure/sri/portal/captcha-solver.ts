import { setTimeout as sleep } from 'node:timers/promises';
import { config } from '../../config.js';
import type { CaptchaSolveRequest, CaptchaSolver } from '../../../application/ports.js';

class ManualCaptchaSolver implements CaptchaSolver {
  async solve(_req: CaptchaSolveRequest): Promise<string> {
    throw new Error('CAPTCHA_MANUAL_REQUIRED: Resuelve el reCAPTCHA manualmente en el navegador del portal SRI.');
  }
}

class TwoCaptchaSolver implements CaptchaSolver {
  async solve(req: CaptchaSolveRequest): Promise<string> {
    if (!config.CAPTCHA_API_KEY) throw new Error('CAPTCHA_API_KEY no configurado para 2captcha');
    const pageUrl = req.pageUrl || 'https://srienlinea.sri.gob.ec/';
    const siteKey = req.siteKey;
    if (!siteKey) throw new Error('siteKey requerido para resolver reCAPTCHA');

    const body = new URLSearchParams({
      key: config.CAPTCHA_API_KEY,
      method: 'userrecaptcha',
      googlekey: siteKey,
      pageurl: pageUrl,
      json: '1',
    });
    // El portal del SRI usa reCAPTCHA Enterprise invisible: sin estos parámetros
    // 2captcha devuelve un token v2 normal que el siteverify de Enterprise rechaza.
    if (req.invisible) body.set('invisible', '1');
    if (req.type === 'recaptcha_v2_enterprise') body.set('enterprise', '1');
    if (req.action) body.set('action', req.action);

    const inRes = await fetch('http://2captcha.com/in.php', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body,
    });
    const inJson: any = await inRes.json();
    if (inJson.status !== 1 || !inJson.request) throw new Error(`2captcha error: ${inJson.request}`);

    const id = inJson.request;
    const deadline = Date.now() + config.CAPTCHA_TIMEOUT_MS;
    while (Date.now() < deadline) {
      await sleep(config.CAPTCHA_POLL_INTERVAL_MS);
      const res = await fetch(`http://2captcha.com/res.php?key=${config.CAPTCHA_API_KEY}&action=get&id=${id}&json=1`);
      const json: any = await res.json();
      if (json.status === 1 && json.request) return json.request;
      if (json.request !== 'CAPCHA_NOT_READY') throw new Error(`2captcha: ${json.request}`);
    }
    throw new Error('Timeout resolviendo captcha con 2captcha');
  }
}

class AntiCaptchaSolver implements CaptchaSolver {
  async solve(req: CaptchaSolveRequest): Promise<string> {
    if (!config.CAPTCHA_API_KEY) throw new Error('CAPTCHA_API_KEY no configurado para anticaptcha');
    const pageUrl = req.pageUrl || 'https://srienlinea.sri.gob.ec/';
    const siteKey = req.siteKey;
    if (!siteKey) throw new Error('siteKey requerido para resolver reCAPTCHA');

    const enterprise = req.type === 'recaptcha_v2_enterprise';
    const createRes = await fetch('https://api.anti-captcha.com/createTask', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        clientKey: config.CAPTCHA_API_KEY,
        task: {
          type: enterprise ? 'RecaptchaV2EnterpriseTaskProxyless' : 'RecaptchaV2TaskProxyless',
          websiteURL: pageUrl,
          websiteKey: siteKey,
          // En la tarea Enterprise la acción va dentro de enterprisePayload; `pageAction` es de la v3.
          ...(enterprise && req.action ? { enterprisePayload: { action: req.action } } : {}),
          ...(!enterprise && req.action ? { pageAction: req.action } : {}),
          ...(req.invisible ? { isInvisible: true } : {}),
        },
      }),
    });
    const createJson: any = await createRes.json();
    if (createJson.errorId !== 0) throw new Error(`anticaptcha: ${createJson.errorDescription}`);
    const taskId = createJson.taskId;

    const deadline = Date.now() + config.CAPTCHA_TIMEOUT_MS;
    while (Date.now() < deadline) {
      await sleep(config.CAPTCHA_POLL_INTERVAL_MS);
      const res = await fetch('https://api.anti-captcha.com/getTaskResult', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ clientKey: config.CAPTCHA_API_KEY, taskId }),
      });
      const json: any = await res.json();
      if (json.errorId !== 0) throw new Error(`anticaptcha: ${json.errorDescription}`);
      if (json.status === 'ready') return json.solution.gRecaptchaResponse;
    }
    throw new Error('Timeout resolviendo captcha con anticaptcha');
  }
}

export function createCaptchaSolver(): CaptchaSolver {
  if (config.CAPTCHA_SOLVER === '2captcha') return new TwoCaptchaSolver();
  if (config.CAPTCHA_SOLVER === 'anticaptcha') return new AntiCaptchaSolver();
  return new ManualCaptchaSolver();
}
