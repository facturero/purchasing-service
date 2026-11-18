import fs from 'node:fs';
import path from 'node:path';
import { config } from '../../config.js';

/**
 * Mata los Chrome que quedaron colgados con este perfil.
 *
 * `puppeteer-real-browser` lanza Chrome con `--remote-debugging-port=0` y luego lee el
 * puerto del `DevToolsActivePort`; si esa lectura falla (o el proceso muere a destiempo)
 * el navegador sigue vivo, `connect()` revienta con ECONNREFUSED y el siguiente arranque
 * se encuentra el perfil retenido por el SingletonLock. Con el proceso muerto, el perfil
 * vuelve a abrirse limpio.
 *
 * Se recorre /proc en vez de llamar a `pkill` porque la imagen es slim y ese applet puede
 * no estar. En Windows/macOS no hay /proc y no hace nada.
 */
export function killOrphanBrowsers(userDataDir: string): number {
  if (process.platform !== 'linux') return 0;
  const needle = `--user-data-dir=${userDataDir}`;
  let killed = 0;
  let entries: string[] = [];
  try {
    entries = fs.readdirSync('/proc');
  } catch {
    return 0;
  }
  for (const entry of entries) {
    if (!/^\d+$/.test(entry)) continue;
    const pid = Number(entry);
    if (pid === process.pid) continue;
    let cmdline = '';
    try {
      cmdline = fs.readFileSync(`/proc/${entry}/cmdline`, 'utf8');
    } catch {
      continue;
    }
    const args = cmdline.split('\0');
    // Solo el proceso PRINCIPAL del navegador: sus hijos (renderer, gpu, zygote) también
    // llevan `--user-data-dir`, pero matan el árbol entero del padre. El binario puede
    // llamarse google-chrome-stable, chromium-browser, chrome…
    const exe = (args[0] ?? '').split('/').pop() ?? '';
    const isBrowserMain = /^(google-chrome(-stable|-beta|-unstable)?|chromium(-browser)?|chrome)$/.test(exe);
    if (!isBrowserMain || !args.includes(needle)) continue;
    try {
      process.kill(pid, 'SIGKILL');
      killed++;
    } catch {}
  }
  return killed;
}

/**
 * Ruta del perfil de Chrome de un RUC/usuario. Una sola normalización para todo el
 * módulo, para que crear y borrar el perfil no se desalineen.
 */
export function resolveProfileDir(profileKey: string): string {
  const base = process.env.SRI_PORTAL_PROFILE_DIR || config.SRI_PORTAL_PROFILE_DIR;
  return path.join(base, profileKey.replace(/[^A-Za-z0-9._-]/g, '_'));
}

/**
 * Borra el perfil de Chrome de un RUC.
 *
 * Por qué: el perfil persistente acumula estado (cookies de sesión del portal, señales
 * de reCAPTCHA) que un día deja de pasar el captcha —o incluso de llegar a «recibidos»—
 * de forma **permanente para ese perfil**, aunque la misma IP y la misma cuenta sí pasan
 * con un perfil recién creado. Comprobado el 2026-11-18: el perfil del 16 falló 3/3
 * veces; los perfiles nuevos pasaron 6/6 consultas (3 de ellas reutilizando el mismo
 * perfil nuevo, o sea que un perfil sano aguanta varias corridas). En vez de averiguar
 * qué archivo envenena el perfil, la corrida que falla lo tira y la siguiente arranca
 * limpia.
 */
export function wipePortalProfile(profileKey?: string): void {
  if (!profileKey) return;
  const dir = resolveProfileDir(profileKey);
  try {
    killOrphanBrowsers(dir);
  } catch {}
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {}
}
