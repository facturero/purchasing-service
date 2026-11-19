import type { CaptchaSolver, SriPortalPeriodResult, SriPortalPort } from '../../../application/ports.js';
import type { PortalSession } from './portal-auth.js';
import { createPortalSession, hasLoginForm, isAuthUrl, loginToPortal, randomDelay } from './portal-auth.js';
import { SriPortalCaptchaError } from '../../../domain/sri-portal.js';
import { config } from '../../config.js';

/** Una fila de la tabla de comprobantes recibidos, tal como la muestra el portal. */
interface PortalTableRow {
  accessKey: string;
  issuerRuc: string;
  issuerName: string;
  /** TIPO_COMPROBANTE + serie, p. ej. "Factura 001-001-000000123". */
  document: string;
  authorizedAt: string;
  emissionDate: string;
  subtotal: string;
  tax: string;
  total: string;
  xmlButtonId: string | null;
  pdfButtonId: string | null;
}

/**
 * Cliente del portal SRI (SRI en línea) basado en la lógica probada del repo
 * https://github.com/JordanNoah/sri-copy-invoice:
 * - puppeteer-real-browser headful (Xvfb en el contenedor)
 * - navegación menú PrimeFaces a "Comprobantes electrónicos recibidos"
 * - filtros (#frmPrincipal:ano / :mes / :dia = 0), Consultar, espera de tabla
 * - descarga de XML/PDF por POST JSF con javax.faces.ViewState + cookies
 * - descarga de "reporte" (importación masiva)
 *
 * El portal usa reCAPTCHA **v2 Enterprise invisible** (`enterprise.js?render=<sitekey>`,
 * `grecaptcha.enterprise.render(..., { size: 'invisible', callback: onSubmit })`) y el
 * botón Consultar llama a `executeRecaptcha('consulta_cel_recibidos','SI')` antes del
 * submit de PrimeFaces. El token lo escribe el propio widget en `g-recaptcha-response`.
 * El puntaje que asigna Google a un Chromium dentro de un contenedor es inestable: a
 * veces acepta y a veces responde "Captcha incorrecta". Con `CAPTCHA_SOLVER` distinto de
 * `manual` el token se pide a 2captcha/Anti-Captcha y se envía por `rcBuscar()`.
 */
export class PuppeteerSriPortalClient implements SriPortalPort {
  private session: PortalSession | null = null;
  private loggedIn = false;

  constructor(private readonly solver: CaptchaSolver) {}

  async isLoggedIn(): Promise<boolean> {
    return this.loggedIn && !!this.session;
  }

  async login(username: string, password: string): Promise<void> {
    if (!this.session) this.session = await createPortalSession(username);
    await loginToPortal(this.session, username, password);
    this.loggedIn = true;
  }

  private async delay(ms: number): Promise<void> {
    await new Promise((r) => setTimeout(r, ms));
  }

  private async humanPause(min = 400, max = 1200): Promise<void> {
    await randomDelay(min, max);
  }

  private requirePage(): any {
    // Estado interno, no credenciales: un error normal para que no cuente como intento
    // de login fallido (ver `loginToPortal`).
    if (!this.session || !this.loggedIn) throw new Error('No hay sesión activa en el portal del SRI');
    return this.session.page;
  }

  /** Vuelve a autenticarse si el portal redirigió a Keycloak. */
  private async ensureLoggedIn(): Promise<void> {
    const page = this.requirePage();
    if (!isAuthUrl(page.url()) && !(await hasLoginForm(page))) return;
    if (!this.session?.username || !this.session?.password) {
      throw new Error('Sesión del portal SRI expirada y sin credenciales para reintentar');
    }
    await loginToPortal(this.session, this.session.username, this.session.password);
  }

  /** Espera el formulario de recibidos; resuelve "Continuar Navegando" y re-login si hace falta. */
  private async waitForRecibidosForm(timeoutMs = 45000): Promise<void> {
    const page = this.requirePage();
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      const state = await page.evaluate(() => ({
        hasForm: !!document.getElementById('frmPrincipal'),
        hasContinue: Array.from(document.querySelectorAll('button, a, input[type="submit"]')).some(
          (b: any) => /continuar navegando/i.test((b.textContent || b.value || '').trim()) && b.offsetWidth > 0,
        ),
      })).catch(() => ({ hasForm: false, hasContinue: false }));
      if (state.hasForm) {
        await this.humanPause(600, 1200);
        return;
      }
      if (state.hasContinue) {
        await page.evaluate(() => {
          const btn = Array.from(document.querySelectorAll('button, a, input[type="submit"]')).find(
            (b: any) => /continuar navegando/i.test((b.textContent || b.value || '').trim()),
          );
          if (btn) (btn as any).click();
        }).catch(() => {});
        await this.humanPause(2500, 4500);
        continue;
      }
      if (isAuthUrl(page.url()) || (await hasLoginForm(page))) {
        await this.ensureLoggedIn();
        await this.humanPause(1500, 2500);
        continue;
      }
      await this.delay(1500);
    }
    throw new Error('No se cargó el formulario de Comprobantes electrónicos recibidos');
  }

  /** Navega a "Comprobantes electrónicos recibidos" (menú PrimeFaces, fallback a URL directa). */
  async goToRecibidos(): Promise<void> {
    const page = this.requirePage();
    await this.ensureLoggedIn();
    try {
      await page.goto('https://srienlinea.sri.gob.ec/sri-en-linea/', { waitUntil: 'networkidle2', timeout: 90000 });
      await this.humanPause(2000, 4000);
      await this.ensureLoggedIn();
      await page.mouse.move(120 + Math.random() * 300, 120 + Math.random() * 200, { steps: 10 }).catch(() => {});
      const expanded = await page.evaluate(() => {
        const links = Array.from(document.querySelectorAll('a.ui-panelmenu-header-link'));
        const link = links.find((a) => (a.textContent || '').includes('FACTURACIÓN ELECTRÓNICA'));
        if (link) { (link as any).click(); return true; }
        return false;
      });
      if (expanded) await this.humanPause(900, 1800);
      const clicked = await page.evaluate(() => {
        const links = Array.from(document.querySelectorAll('a.ui-menuitem-link'));
        const link = links.find((a) => {
          const href = (a as any).href || '';
          return (a.textContent || '').includes('Comprobantes electrónicos recibidos') || href.includes('redireccion=57');
        });
        if (link) { (link as any).click(); return true; }
        return false;
      });
      if (clicked) {
        await this.humanPause(2500, 4500);
        await this.waitForRecibidosForm();
        return;
      }
    } catch { /* fallback */ }

    const urls = [
      'https://srienlinea.sri.gob.ec/comprobantes-electronicos-internet/pages/consultas/recibidos/comprobantesRecibidos.jsf',
      'https://srienlinea.sri.gob.ec/sri-en-linea/contribuyente/comprobantes-recibidos',
    ];
    for (const url of urls) {
      try {
        await page.goto(url, { waitUntil: 'networkidle2', timeout: 90000 });
        await this.humanPause(2500, 4500);
        await this.ensureLoggedIn();
        await this.waitForRecibidosForm();
        return;
      } catch {
        try {
          await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 90000 });
          await this.humanPause(2500, 4500);
          await this.ensureLoggedIn();
          await this.waitForRecibidosForm();
          return;
        } catch {}
      }
    }
    throw new Error('No se pudo navegar a Comprobantes electrónicos recibidos');
  }

  /**
   * Datos que necesita el solver externo: sitekey del script enterprise.js?render=…,
   * acción del onclick del botón (executeRecaptcha('consulta_cel_recibidos','SI')) y que
   * el widget es invisible (cargarRecaptcha usa size:'invisible').
   */
  private async captchaParams(): Promise<{ siteKey: string | null; action: string | null }> {
    const page = this.requirePage();
    return await page.evaluate(() => {
      let siteKey: string | null = null;
      const script = Array.from(document.querySelectorAll('script[src]')).find((s) =>
        ((s as HTMLScriptElement).src || '').includes('enterprise.js'),
      ) as HTMLScriptElement | undefined;
      const m = script?.src.match(/[?&]render=([^&]+)/);
      if (m) siteKey = decodeURIComponent(m[1]!);
      if (!siteKey) {
        const el = document.querySelector('[data-sitekey]');
        if (el) siteKey = el.getAttribute('data-sitekey');
      }
      let action: string | null = null;
      const btn = document.getElementById('frmPrincipal:btnBuscar');
      const am = (btn?.getAttribute('onclick') || '').match(/executeRecaptcha\('([^']+)'/);
      if (am) action = am[1]!;
      return { siteKey, action };
    }).catch(() => ({ siteKey: null, action: null }));
  }

  /**
   * Token de un solver externo (2captcha / Anti-Captcha). Devuelve null cuando el
   * modo es `manual`: ahí el token lo produce el propio formulario al pulsar Consultar.
   */
  private async solveCaptchaExternally(): Promise<string | null> {
    if (config.CAPTCHA_SOLVER === 'manual') return null;
    const page = this.requirePage();
    const { siteKey, action } = await this.captchaParams();
    if (!siteKey) return null;
    try {
      const token = await this.solver.solve({
        type: 'recaptcha_v2_enterprise',
        siteKey,
        pageUrl: page.url(),
        action: action || undefined,
        invisible: true,
      });
      return token || null;
    } catch (e: any) {
      throw new SriPortalCaptchaError(`Solver (${config.CAPTCHA_SOLVER}): ${e.message}`);
    }
  }

  /**
   * Escribe el token externo en el textarea que lee `rcBuscar()`. No basta con el
   * textarea: el portal vuelve a llamar a `grecaptcha.enterprise.execute` si se pulsa
   * el botón, y eso generaría otro token y descartaría el del solver.
   */
  private async injectCaptchaToken(token: string): Promise<void> {
    const page = this.requirePage();
    await page.evaluate((t: string) => {
      document.querySelectorAll('textarea[name="g-recaptcha-response"], #g-recaptcha-response').forEach((ta) => {
        const el = ta as HTMLTextAreaElement;
        el.style.display = 'block';
        el.value = t;
      });
      try {
        if ((window as any).grecaptcha?.enterprise) (window as any).grecaptcha.enterprise.getResponse = () => t;
      } catch {}
    }, token);
  }

  private async readCaptchaMessage(): Promise<string | null> {
    const page = this.requirePage();
    return await page.evaluate(() => {
      const texts: string[] = [];
      document.querySelectorAll('.ui-messages, .ui-message, .ui-growl-item, [role=alert]').forEach((n) => {
        const t = (n as HTMLElement).innerText?.trim();
        if (t) texts.push(t);
      });
      const body = document.body.innerText || '';
      const m = body.match(/captcha[^\n]{0,80}/i);
      if (m) texts.push(m[0]);
      const joined = texts.join(' | ');
      return /captcha/i.test(joined) ? joined.slice(0, 300) : null;
    }).catch(() => null);
  }

  /**
   * Aplica filtros año/mes (+ día Todos) y consulta, dejando la tabla cargada.
   * El token de reCAPTCHA Enterprise invisible sale a veces con riesgo alto y el
   * portal responde "Captcha incorrecta"; se recarga el formulario (ViewState y
   * token nuevos) y se reintenta, que es lo único que lo resuelve sin humano.
   */
  async consultPeriod(year: number, month: number): Promise<void> {
    // Un solo intento sin solver: reintentar dentro de la misma corrida nunca lo
    // arregló (el portal puntúa el token igual de bajo) y sí suma consultas
    // rechazadas; la siguiente oportunidad es la corrida horaria del job.
    // Con solver cada intento cuesta dinero: dos como máximo.
    const attempts = config.CAPTCHA_SOLVER === 'manual' ? 1 : 2;
    let lastErr: Error | null = null;
    for (let attempt = 1; attempt <= attempts; attempt++) {
      try {
        const rows = await this.consultPeriodOnce(year, month);
        console.log(`[portal] periodo ${year}-${String(month).padStart(2, '0')} consultado (intento ${attempt}, ${rows} filas)`);
        return;
      } catch (err: any) {
        lastErr = err;
        if (!(err instanceof SriPortalCaptchaError) || attempt === attempts) throw err;
        console.warn(`[portal] captcha rechazado en ${year}-${String(month).padStart(2, '0')} (intento ${attempt}/${attempts}); reintentando`);
        await this.delay(4000 + attempt * 3000);
      }
    }
    throw lastErr ?? new Error('No se pudo consultar el periodo');
  }

  /** Un intento de consulta: filtros + Consultar + espera de tabla o mensaje de captcha. */
  private async consultPeriodOnce(year: number, month: number): Promise<number> {
    const page = this.requirePage();
    await this.goToRecibidos();
    await this.humanPause(800, 1600);

    // El id real del portal es "ano" (no "anio"): #frmPrincipal:ano / :mes / :dia
    try {
      await page.select('#frmPrincipal\\:ano', String(year));
      await this.humanPause(250, 600);
    } catch (e: any) {
      console.warn(`[portal] no se pudo seleccionar año ${year}: ${e.message}`);
    }
    try {
      await page.select('#frmPrincipal\\:mes', String(month));
      await this.humanPause(250, 600);
    } catch (e: any) {
      console.warn(`[portal] no se pudo seleccionar mes ${month}: ${e.message}`);
    }
    try {
      await page.select('#frmPrincipal\\:dia', '0');
      await this.humanPause(200, 500);
    } catch {}

    const externalToken = await this.solveCaptchaExternally();
    await this.humanPause(400, 900);

    if (externalToken) {
      // Con token externo se evita el botón: su onclick vuelve a ejecutar reCAPTCHA
      // y descartaría el token resuelto. rcBuscar() envía el formulario tal cual.
      await this.injectCaptchaToken(externalToken);
      await page.evaluate(() => {
        const fn = (window as any).rcBuscar;
        if (typeof fn === 'function') fn();
        else {
          const btn = document.getElementById('frmPrincipal:btnBuscar') as HTMLElement | null;
          btn?.click();
        }
      }).catch(() => {});
    } else {
      // Clic con ratón real (evento confiable): reCAPTCHA Enterprise puntúa la sesión y
      // un `.click()` desde `evaluate` llega con `isTrusted:false` y sin movimiento de
      // ratón, que es justo lo que mide. Se mueve el cursor al botón y se pulsa.
      const btn = await page.$('#frmPrincipal\\:btnBuscar');
      const box = btn ? await btn.boundingBox().catch(() => null) : null;
      if (box && box.width > 0) {
        const x = box.x + box.width * (0.35 + Math.random() * 0.3);
        const y = box.y + box.height * (0.35 + Math.random() * 0.3);
        await page.mouse.move(x - 60, y - 40, { steps: 8 }).catch(() => {});
        await this.humanPause(120, 300);
        await page.mouse.move(x, y, { steps: 10 }).catch(() => {});
        await this.humanPause(60, 180);
        await page.mouse.click(x, y, { delay: 40 + Math.floor(Math.random() * 70) }).catch(() => {});
      } else {
        const clicked = await page.evaluate(() => {
          const b = document.getElementById('frmPrincipal:btnBuscar') as HTMLElement | null;
          if (b) { b.click(); return true; }
          return false;
        }).catch(() => false);
        if (!clicked) await page.keyboard.press('Enter').catch(() => {});
      }
    }

    // esperar tabla o mensaje de captcha
    const start = Date.now();
    let rows = 0;
    let captchaMsg: string | null = null;
    while (Date.now() - start < 30000) {
      await this.delay(1200);
      const st = await page.evaluate(() => {
        const tbody = document.getElementById('frmPrincipal:tablaCompRecibidos_data');
        return tbody ? tbody.querySelectorAll('tr[data-ri]').length : 0;
      }).catch(() => 0);
      rows = st;
      if (rows > 0) break;
      captchaMsg = await this.readCaptchaMessage();
      if (captchaMsg) break;
      // si no hay resultados, el portal a veces deja la tabla vacía sin mensaje: seguir esperando un poco
    }
    if (captchaMsg) {
      throw new SriPortalCaptchaError(`Portal SRI rechazó el captcha (${captchaMsg})`);
    }
    await this.humanPause(400, 900);
    // rows === 0 sin mensaje: el periodo no tiene comprobantes, no es error
    return rows;
  }

  /** Lee una página de la tabla de recibidos con todas sus columnas (layout del repo viejo). */
  private async readRowsPage(): Promise<PortalTableRow[]> {
    const page = this.requirePage();
    return await page.evaluate(() => {
      const tbody =
        document.getElementById('frmPrincipal:tablaCompRecibidos_data') ||
        document.querySelector('tbody[id*="tablaCompRecibidos_data"]') ||
        document.querySelector('.ui-datatable-data');
      if (!tbody) return [];
      const rows = Array.from(tbody.querySelectorAll('tr[data-ri]'));
      return rows
        .map((row) => {
          const cells = row.querySelectorAll('td');
          const text = (i: number) => (cells[i] as HTMLElement | undefined)?.innerText || '';
          const issuer = text(1).split('\n').map((s) => s.trim()).filter(Boolean);
          const xmlLink = cells[9]?.querySelector('a') as HTMLElement | null;
          const pdfLink = cells[10]?.querySelector('a') as HTMLElement | null;
          return {
            accessKey: text(3).replace(/\s+/g, ''),
            issuerRuc: issuer[0] || '',
            issuerName: issuer.slice(1).join(' '),
            document: text(2).replace(/\s+/g, ' ').trim(),
            authorizedAt: text(4).replace(/\s+/g, ' ').trim(),
            emissionDate: text(5).replace(/\s+/g, ' ').trim(),
            subtotal: text(6).replace(/\s+/g, ''),
            tax: text(7).replace(/\s+/g, ''),
            total: text(8).replace(/\s+/g, ''),
            xmlButtonId: xmlLink?.id || null,
            pdfButtonId: pdfLink?.id || null,
          };
        })
        .filter((r) => r.accessKey.length >= 20);
    });
  }

  /** Avanza el paginador de la tabla si hay páginas pendientes. */
  private async nextPage(): Promise<boolean> {
    const page = this.requirePage();
    return await page.evaluate(() => {
      const table = document.getElementById('frmPrincipal:tablaCompRecibidos');
      const root = (table?.closest('.ui-datatable') as HTMLElement | null) || table?.parentElement || null;
      const next = root?.querySelector('.ui-paginator-next') as HTMLElement | null;
      if (!next) return false;
      if (next.classList.contains('ui-state-disabled') || next.getAttribute('aria-disabled') === 'true') return false;
      next.click();
      return true;
    }).catch(() => false);
  }

  /**
   * Todas las filas del periodo, recorriendo el paginador de PrimeFaces, y los XML
   * descargados página a página. El id del botón XML incluye el índice de fila DENTRO
   * de la página, así que hay que bajar los XML antes de avanzar: en otra página esos
   * botones ya no existen en el DOM (y el POST JSF no encontraría el componente).
   */
  private async readAllRowsAndXmls(): Promise<{ rows: PortalTableRow[]; xmls: Map<string, string> }> {
    const all: PortalTableRow[] = [];
    const xmls = new Map<string, string>();
    const seen = new Set<string>();
    for (let p = 0; p < 40; p++) {
      const rows = await this.readRowsPage();
      const fresh: PortalTableRow[] = [];
      for (const r of rows) {
        if (!seen.has(r.accessKey)) {
          seen.add(r.accessKey);
          all.push(r);
          fresh.push(r);
        }
      }
      if (fresh.length === 0) break;
      const pageXmls = await this.downloadXmlsForRows(fresh);
      for (const [key, xml] of pageXmls) xmls.set(key, xml);
      if (!(await this.nextPage())) break;
      await this.humanPause(1500, 2600);
    }
    return { rows: all, xmls };
  }

  /** `"1,234.56"` / `"1.234,56"` → `"1234.56"` (el parser sólo acepta punto decimal). */
  private static normalizeAmount(value: string): string {
    const v = value.replace(/[^\d.,-]/g, '');
    if (v.includes(',') && v.includes('.')) return v.replace(/,/g, '');
    if (v.includes(',')) return v.replace(',', '.');
    return v;
  }

  /**
   * Arma el TSV con las columnas que espera `parseSriReport`. La tabla del portal no
   * trae el número del documento modificado (notas de crédito): queda vacío.
   */
  private static buildReportText(rows: PortalTableRow[], receiverId: string): string {
    const header = [
      'CLAVE_ACCESO', 'RUC_EMISOR', 'RAZON_SOCIAL_EMISOR', 'TIPO_COMPROBANTE', 'SERIE_COMPROBANTE',
      'FECHA_AUTORIZACION', 'IDENTIFICACION_RECEPTOR', 'VALOR_SIN_IMPUESTOS', 'IVA', 'IMPORTE_TOTAL',
      'NUMERO_DOCUMENTO_MODIFICADO',
    ].join('\t');
    const lines = rows.map((r) => {
      const serie = r.document.match(/(\d+-\d+-\d+)/)?.[1] ?? '';
      const tipo = r.document.replace(/(\d+-\d+-\d+).*$/, '').trim();
      return [
        r.accessKey, r.issuerRuc, r.issuerName, tipo, serie, r.authorizedAt, receiverId,
        PuppeteerSriPortalClient.normalizeAmount(r.subtotal),
        PuppeteerSriPortalClient.normalizeAmount(r.tax),
        PuppeteerSriPortalClient.normalizeAmount(r.total),
        '',
      ].join('\t');
    });
    return [header, ...lines].join('\r\n');
  }

  /**
   * Descarga un archivo (XML/PDF) por POST JSF con ViewState + cookies, como downloadFile del repo viejo.
   * Requiere que la tabla de recibidos esté cargada en la página actual.
   */
  async downloadFileByButtonId(buttonId: string, fileType: 'xml' | 'pdf'): Promise<Buffer | null> {
    const page = this.requirePage();
    const pageData = await page.evaluate(() => {
      const viewStateInput = document.querySelector('input[name="javax.faces.ViewState"]') as HTMLInputElement | null;
      return { viewState: viewStateInput?.value || '', userAgent: navigator.userAgent };
    });
    if (!pageData.viewState) return null;
    const cookies = await page.cookies();
    const cookieString = cookies.map((c: any) => `${c.name}=${c.value}`).join('; ');

    const formData = new URLSearchParams();
    formData.append('frmPrincipal', 'frmPrincipal');
    formData.append('frmPrincipal:opciones', 'ruc');
    formData.append('javax.faces.ViewState', pageData.viewState);
    formData.append('g-recaptcha-response', '');
    formData.append(buttonId, buttonId);

    const downloadUrl = 'https://srienlinea.sri.gob.ec/comprobantes-electronicos-internet/pages/consultas/recibidos/comprobantesRecibidos.jsf';
    try {
      const response = await fetch(downloadUrl, {
        method: 'POST',
        headers: {
          'Cookie': cookieString,
          // El mismo UA del navegador que abrió la sesión: uno distinto hace que el
          // portal desconozca la sesión o devuelva HTML en vez del archivo.
          'User-Agent': pageData.userAgent,
          'Content-Type': 'application/x-www-form-urlencoded',
          'Referer': downloadUrl,
          'Origin': 'https://srienlinea.sri.gob.ec',
        },
        body: formData.toString(),
        redirect: 'follow',
      } as any);
      if (!response.ok) return null;
      const ab = await response.arrayBuffer();
      const buf = Buffer.from(ab);
      if (buf.length < 100) return null;
      const head = buf.toString('utf8', 0, 200).toLowerCase();
      if (head.includes('<html') || head.includes('<!doctype') || (fileType === 'xml' && !head.includes('<?xml') && !head.includes('<autorizacion') && !head.includes('<factura') && !head.includes('<comprobante'))) {
        if (!(fileType === 'xml' && buf.includes(Buffer.from('autorizacion')))) return null;
      }
      return buf;
    } catch {
      return null;
    }
  }

  /**
   * Estando en la página consultada del periodo, descarga los XML de las filas dadas.
   * Devuelve mapa accessKey -> xml (string).
   */
  private async downloadXmlsForRows(rows: PortalTableRow[]): Promise<Map<string, string>> {
    const out = new Map<string, string>();
    for (const row of rows) {
      if (!row.xmlButtonId) continue;
      const buf = await this.downloadFileByButtonId(row.xmlButtonId, 'xml');
      if (buf) {
        const xml = buf.toString('utf8');
        if (xml.includes(row.accessKey)) out.set(row.accessKey, xml);
        else out.set(row.accessKey, buf.toString('latin1'));
      }
      await this.delay(400 + Math.random() * 500);
    }
    return out;
  }

  /**
   * Un periodo completo con un solo captcha: consulta, lee la tabla (todas las páginas),
   * baja los XML página a página y devuelve el TSV para importar.
   */
  async syncPeriod(params: { year: number; month: number; receiverId: string }): Promise<SriPortalPeriodResult> {
    await this.consultPeriod(params.year, params.month);
    const { rows, xmls } = await this.readAllRowsAndXmls();
    return {
      reportText: PuppeteerSriPortalClient.buildReportText(rows, params.receiverId),
      rowCount: rows.length,
      xmls,
    };
  }

  async close(): Promise<void> {
    if (this.session?.browser) await this.session.browser.close().catch(() => {});
    this.session = null;
    this.loggedIn = false;
  }
}
