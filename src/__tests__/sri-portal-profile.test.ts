import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// `profile-store` importa `config`, que exige estas variables (el repo no trae `.env` y
// `config` hace `process.exit(1)` si faltan). Se fijan ANTES del import dinámico; un
// `import` estático se evaluaría antes que este código.
process.env.DB_HOST ??= '127.0.0.1';
process.env.DB_USER ??= 'root';
process.env.DB_NAME ??= 'test';
const { resolveProfileDir, wipePortalProfile } = await import('../infrastructure/sri/portal/profile-store.js');

/**
 * El perfil de Chrome es lo que se "envenena" cuando el portal deja de pasar el captcha
 * (ver IMPLEMENTATION.md). Lo que se prueba aquí es que la ruta se normaliza siempre
 * igual y que el borrado es real y selectivo, sin tocar el perfil de otro RUC.
 */
describe('perfil del portal SRI', () => {
  const original = process.env.SRI_PORTAL_PROFILE_DIR;
  let base: string;

  beforeEach(() => {
    base = fs.mkdtempSync(path.join(os.tmpdir(), 'sri-profile-test-'));
    process.env.SRI_PORTAL_PROFILE_DIR = base;
  });

  afterEach(() => {
    if (original === undefined) delete process.env.SRI_PORTAL_PROFILE_DIR;
    else process.env.SRI_PORTAL_PROFILE_DIR = original;
    fs.rmSync(base, { recursive: true, force: true });
  });

  it('normaliza la ruta del perfil del RUC', () => {
    expect(resolveProfileDir('0922362595001')).toBe(path.join(base, '0922362595001'));
    // Nada raro se cuela como subruta: los caracteres no permitidos se sustituyen.
    expect(path.basename(resolveProfileDir('../../etc/passwd'))).toBe('.._.._etc_passwd');
    expect(resolveProfileDir('../../etc/passwd').startsWith(base + path.sep)).toBe(true);
  });

  it('borra el perfil del RUC y deja intactos los demás', () => {
    const sucio = resolveProfileDir('0922362595001');
    const sano = resolveProfileDir('1790012345001');
    fs.mkdirSync(path.join(sucio, 'Default'), { recursive: true });
    fs.writeFileSync(path.join(sucio, 'Default', 'Cookies'), 'x');
    fs.mkdirSync(sano, { recursive: true });

    wipePortalProfile('0922362595001');

    expect(fs.existsSync(sucio)).toBe(false);
    expect(fs.existsSync(sano)).toBe(true);
  });

  it('no hace nada si no hay clave o si el perfil no existe', () => {
    expect(() => wipePortalProfile(undefined)).not.toThrow();
    expect(() => wipePortalProfile('')).not.toThrow();
    expect(() => wipePortalProfile('0922362595001')).not.toThrow();
    expect(fs.existsSync(resolveProfileDir('0922362595001'))).toBe(false);
  });
});
