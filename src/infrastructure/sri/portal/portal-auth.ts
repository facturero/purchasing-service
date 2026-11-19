import { connect } from 'puppeteer-real-browser';
import fs from 'node:fs';
import path from 'node:path';
import { config } from '../../config.js';
import { SriPortalAuthError } from '../../../domain/sri-portal.js';
import { killOrphanBrowsers, resolveProfileDir, wipePortalProfile } from './profile-store.js';

/** Espera a que el proceso libere el perfil; no hay `sleep` síncrono portable. */
const wait = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * `http://usuario:clave@host:puerto` (o `host:puerto`) → opciones de proxy del navegador.
 * El paquete arma `--proxy-server=host:puerto` y autentica por `page.authenticate`, así
 * que el esquema se ignora (sirve para proxies HTTP, que es el caso habitual).
 */
function parseProxy(raw: string | undefined): { host: string; port: number; username?: string; password?: string } | undefined {
  if (!raw) return undefined;
  try {
    const u = new URL(raw.includes('://') ? raw : `http://${raw}`);
    const port = Number(u.port || (u.protocol === 'https:' ? 443 : 80));
    if (!u.hostname || !port) return undefined;
    return {
      host: u.hostname,
      port,
      ...(u.username ? { username: decodeURIComponent(u.username) } : {}),
      ...(u.password ? { password: decodeURIComponent(u.password) } : {}),
    };
  } catch {
    return undefined;
  }
}

export interface PortalSession {
  browser: any;
  page: any;
  username?: string;
  password?: string;
}

export const randomDelay = (min: number, max: number): Promise<void> => {
  const ms = Math.floor(Math.random() * (max - min + 1)) + min;
  return new Promise((r) => setTimeout(r, ms));
};

async function humanType(page: any, selector: string, text: string): Promise<void> {
  const el = await page.$(selector);
  if (!el) throw new Error(`Elemento no encontrado: ${selector}`);
  await el.click({ clickCount: 3 }).catch(async () => {
    await page.focus(selector).catch(() => {});
  });
  await randomDelay(80, 220);
  for (const char of text) {
    await page.type(selector, char, { delay: Math.floor(Math.random() * 90) + 40 });
    if (Math.random() < 0.04) await randomDelay(120, 350);
  }
  await randomDelay(120, 320);
}

async function humanClick(page: any, selector: string): Promise<void> {
  const el = await page.$(selector);
  if (!el) throw new Error(`Elemento no encontrado: ${selector}`);
  await el.hover().catch(() => {});
  await randomDelay(120, 350);
  const box = await el.boundingBox().catch(() => null);
  if (box) {
    const x = box.x + box.width * (0.3 + Math.random() * 0.4);
    const y = box.y + box.height * (0.3 + Math.random() * 0.4);
    await page.mouse.move(x, y, { steps: 8 + Math.floor(Math.random() * 8) }).catch(() => {});
    await randomDelay(60, 180);
  }
  await el.click({ delay: Math.floor(Math.random() * 80) + 30 }).catch(async () => {
    await page.evaluate((sel: string) => {
      const n = document.querySelector(sel) as HTMLElement | null;
      n?.click();
    }, selector);
  });
  await randomDelay(150, 400);
}

/**
 * Lanza el navegador con la misma configuración que usaba el repo
 * JordanNoah/sri-copy-invoice: puppeteer-real-browser + headful (Xvfb en Linux).
 */
export async function createPortalSession(profileKey?: string): Promise<PortalSession> {
  // Google Chrome antes que Chromium: el binario de Google reporta la marca
  // «Google Chrome» en los client hints y trae los componentes propios (visor de
  // PDF, Safe Browsing). Chromium solo declara «Chromium» y eso es una señal más
  // de navegador embebido/automatizado para reCAPTCHA Enterprise. Ojo: no se falsea
  // el User-Agent; se elige el binario real.
  const explicit =
    config.PUPPETEER_EXECUTABLE_PATH || process.env.PUPPETEER_EXECUTABLE_PATH || process.env.CHROME_BIN || process.env.CHROMIUM_PATH;
  let executablePath = explicit;
  if (!executablePath) {
    for (const candidate of ['/usr/bin/google-chrome-stable', '/usr/bin/google-chrome', '/usr/bin/chromium-browser', '/usr/bin/chromium']) {
      try {
        fs.accessSync(candidate, fs.constants.X_OK);
        executablePath = candidate;
        break;
      } catch {}
    }
  }
  if (!executablePath) throw new Error('No se encontró un navegador para el portal del SRI');

  // Perfil de Chrome por RUC. Por defecto arranca **limpio en cada corrida**: un perfil
  // usado deja de pasar el captcha al cabo de un rato (comprobado el 2026-11-18: uno que
  // pasó 3 corridas seguidas falló 30 min después, y ni siquiera borrarle las cookies lo
  // revivió). Con `SRI_PORTAL_PROFILE_MODE=persistent` se conserva y solo se borra al
  // fallar (ver `wipePortalProfile`).
  let userDataDir: string | undefined;
  if (profileKey) {
    userDataDir = resolveProfileDir(profileKey);
    if (config.SRI_PORTAL_PROFILE_MODE === 'fresh') {
      wipePortalProfile(profileKey);
    }
    try {
      fs.mkdirSync(userDataDir, { recursive: true });
    } catch {
      userDataDir = undefined;
    }
  }

  /**
   * Deja el perfil listo para un arranque limpio.
   *
   * Lo que rompía: `chrome-launcher` (lo que usa `puppeteer-real-browser` por dentro)
   * descubre el puerto de depuración leyendo `chrome-err.log`, y se queda con la
   * PRIMERA línea «DevTools listening on …» que ve. Como el perfil es persistente, ese
   * archivo ya traía el puerto de la corrida anterior —muerto—, así que `connect()`
   * fallaba con ECONNREFUSED contra un puerto que nadie escuchaba, dejando además un
   * Chrome huérfano. Borrar los archivos de arranque lo deja determinista.
   */
  const prepareProfile = async (): Promise<void> => {
    if (!userDataDir) return;
    const killed = killOrphanBrowsers(userDataDir);
    if (killed > 0) {
      console.warn(`[portal] ${killed} Chrome huérfano(s) del perfil ${path.basename(userDataDir)}; se matan antes de arrancar`);
      // El kernel tarda en reapear; si se relanza de inmediato el perfil sigue tomado.
      await wait(1500);
    }
    for (const f of [
      // Locks del perfil (un cierre abrupto los deja y el arranque siguiente falla).
      'SingletonLock', 'SingletonCookie', 'SingletonSocket',
      // Rastro del arranque anterior: el log confunde la detección del puerto y el
      // archivo del puerto apunta al proceso muerto.
      'chrome-err.log', 'chrome-out.log', 'chrome.pid', 'DevToolsActivePort',
    ]) {
      try { fs.rmSync(path.join(userDataDir, f), { force: true }); } catch {}
    }
  };

  const proxy = parseProxy(config.SRI_PORTAL_PROXY || process.env.SRI_PORTAL_PROXY);

  const launch = async () => connect({
    headless: false,
    args: [
      '--disable-blink-features=AutomationControlled',
      '--window-size=1920,1080',
      '--no-first-run',
      '--no-default-browser-check',
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--lang=es-EC',
      // `--accept-lang` es el que fija `navigator.languages` y la cabecera
      // Accept-Language de Chrome. Sin él, `navigator.language` salía 'en-US' mientras
      // la cabecera decía es-EC: esa incoherencia es una señal de automatización.
      '--accept-lang=es-EC,es,en',
      // Chrome apaga el WebGL por software cuando no hay GPU. Sin WebGL el contexto
      // del canvas es `null`, que es una de las señales clásicas de navegador de
      // laboratorio. El flag reactiva el SwiftShader que Chrome trae; el resultado
      // ("Google Inc. (Google)" / ANGLE SwiftShader) es el de un Chrome real en una VM.
      '--enable-unsafe-swiftshader',
    ],
    customConfig: {
      chromePath: executablePath,
      ...(userDataDir ? { userDataDir } : {}),
    },
    ...(proxy ? { proxy } : {}),
    disableXvfb: false,
  } as any);

  await prepareProfile();
  let browser: any;
  let page: any;
  try {
    ({ browser, page } = await launch());
  } catch (err: any) {
    // El fallo típico de `connect` es ECONNREFUSED al puerto de depuración que nunca
    // llegó a abrirse, dejando el navegador vivo. Se limpia y se reintenta UNA vez:
    // más reintentos solo retrasan la corrida horaria, que ya reintenta sola.
    console.warn(`[portal] connect falló (${err?.message}); se limpia el perfil y se reintenta una vez`);
    await prepareProfile();
    await wait(1000);
    try {
      ({ browser, page } = await launch());
    } catch (err2: any) {
      await prepareProfile();
      throw err2;
    }
  }

  await page.setViewport({ width: 1920, height: 1080 }).catch(() => {});
  // No se falsea el User-Agent: reCAPTCHA Enterprise compara la cadena con las
  // cabeceras Sec-CH-UA reales del binario y con navigator.platform. Un UA de
  // Windows Chrome 120 sobre un Chromium Linux hacía que todo token saliera con
  // riesgo alto ("Captcha incorrecta"). El repo viejo tampoco lo falseaba.
  if (process.env.SRI_PORTAL_USER_AGENT) {
    await page.setUserAgent(process.env.SRI_PORTAL_USER_AGENT).catch(() => {});
  }
  // El Accept-Language lo pone Chrome desde `--accept-lang`; forzarlo aparte dejaba la
  // cabecera en es-EC mientras `navigator.language` decía otra cosa.
  await page.emulateTimezone('America/Guayaquil').catch(() => {});
  return { browser, page };
}

function isAuthUrl(url: string): boolean {
  return url.includes('auth/realms') || url.includes('openid-connect');
}

async function hasLoginForm(page: any): Promise<boolean> {
  return await page.evaluate(
    () => !!(document.getElementById('usuario') || document.getElementById('username') || document.getElementById('password')),
  ).catch(() => false);
}

async function hasCredentialError(page: any): Promise<boolean> {
  const lower = (await page.content().catch(() => '')).toLowerCase();
  return (
    lower.includes('usuario o contraseña incorrectos') ||
    lower.includes('clave incorrecta') ||
    lower.includes('credenciales inválidas') ||
    lower.includes('datos incorrectos')
  );
}

async function clearLoginFields(page: any): Promise<void> {
  await page.evaluate(() => {
    for (const id of ['username', 'usuario', 'ciAdicional', 'password']) {
      const el = document.getElementById(id) as HTMLInputElement | null;
      if (el) el.value = '';
    }
  }).catch(() => {});
}

async function fillCredentials(page: any, username: string, password: string): Promise<void> {
  await clearLoginFields(page);
  await randomDelay(200, 500);
  if (await page.$('#usuario')) {
    await humanType(page, '#usuario', username);
  } else if (await page.$('#username')) {
    await humanType(page, '#username', username);
  }
  await page.evaluate(() => {
    const c = document.getElementById('ciAdicional') as HTMLInputElement | null;
    if (c) c.value = '';
  }).catch(() => {});
  await randomDelay(200, 500);
  if (await page.$('#password')) {
    await humanType(page, '#password', password);
  } else {
    await page.evaluate((p: string) => {
      const el = document.getElementById('password') as HTMLInputElement | null;
      if (el) el.value = p;
    }, password);
  }
  await randomDelay(250, 650);
}

async function submitLogin(page: any): Promise<void> {
  await randomDelay(300, 800);
  if (await page.$('#kc-login')) {
    await humanClick(page, '#kc-login');
  } else {
    const btn = await page.$('#btnIngresar, button[type="submit"], input[type="submit"]');
    if (btn) {
      await btn.hover().catch(() => {});
      await randomDelay(120, 300);
      await btn.click({ delay: Math.floor(Math.random() * 60) + 20 }).catch(() => {});
    }
  }
}

/** Espera a salir de Keycloak; devuelve false si quedó atrapado en el formulario. */
async function waitLoginResult(page: any, timeoutMs = 45000): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    await randomDelay(800, 1200);
    const url = page.url();
    const hasForm = await hasLoginForm(page);
    if (!hasForm && !isAuthUrl(url)) return true;
    if (hasForm && (await hasCredentialError(page))) return false;
  }
  const hasForm = await hasLoginForm(page);
  return !hasForm && !isAuthUrl(page.url());
}

/**
 * Login con el mismo recorrido del repo viejo:
 * sri-en-linea → clic en iniciar sesión → credenciales → ingreso.
 * Keycloak a veces pide un segundo login (SSO app-sri-claves-angular); se reintenta.
 *
 * `SriPortalAuthError` se lanza **solo** con evidencia de credenciales inválidas
 * (`hasCredentialError`). Un fallo de Chrome (navegación, protocolo del DevTools) se
 * propaga como error normal: no debe contar para el bloqueo por intentos de login.
 */
export async function loginToPortal(session: PortalSession, username: string, password: string): Promise<void> {
  const { page } = session;
  session.username = username;
  session.password = password;

  await page.goto('https://srienlinea.sri.gob.ec/sri-en-linea/', { waitUntil: 'networkidle2', timeout: 90000 });
  await randomDelay(2000, 3500);

  // Si hay enlace de inicio de sesión (no autenticado), entrar al formulario.
  if (!(await hasLoginForm(page))) {
    const loginLink = await page.$('a[href="/sri-en-linea/contribuyente/perfil"]');
    if (loginLink) {
      await humanClick(page, 'a[href="/sri-en-linea/contribuyente/perfil"]').catch(() => {});
      await randomDelay(2500, 4500);
    }
  }

  if (!(await hasLoginForm(page))) {
    const cookieBtn = await page.$('button');
    if (cookieBtn) {
      // Aceptar banner de cookies si aparece
      await page.evaluate(() => {
        const btn = Array.from(document.querySelectorAll('button, a')).find((b: any) =>
          /aceptar|accept|entendido/i.test((b.textContent || '').trim()),
        );
        if (btn) (btn as any).click();
      }).catch(() => {});
      await randomDelay(500, 900);
    }
  }

  if (!(await hasLoginForm(page))) {
    // Ya había sesión iniciada.
    return;
  }

  await fillCredentials(page, username, password);
  await submitLogin(page);
  if (!(await waitLoginResult(page))) {
    if (await hasCredentialError(page)) throw new SriPortalAuthError('Usuario o contraseña incorrectos');
    // Segundo paso SSO
    for (let retry = 0; retry < 3; retry++) {
      if (!(await hasLoginForm(page)) || !isAuthUrl(page.url())) break;
      await randomDelay(800, 1600);
      await fillCredentials(page, username, password);
      await submitLogin(page);
      if (await waitLoginResult(page)) break;
      if (await hasCredentialError(page)) break;
    }
  }

  if ((await hasLoginForm(page)) || isAuthUrl(page.url())) {
    // Solo es un fallo de credenciales si el portal lo dice con un mensaje explícito.
    // Quedarse en el formulario también pasa por una navegación a medias o un Keycloak
    // lento; contar eso como credenciales malas bloqueó la sincronización por 3 fallos
    // transitorios de Chrome (visto el 2026-11-19). El resto de errores se propaga tal
    // cual (sin envolverlo en `SriPortalAuthError`), para que un fallo de Chrome no
    // cuente para el bloqueo por intentos de login (ver `main.ts`).
    if (await hasCredentialError(page)) throw new SriPortalAuthError('Usuario o contraseña incorrectos');
    throw new Error('No se completó el inicio de sesión en el portal del SRI');
  }
}

export { hasLoginForm, isAuthUrl };
