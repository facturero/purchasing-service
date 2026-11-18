import { beforeEach, describe, expect, it } from 'vitest';
import { InMemoryStore, ORG_A, ORG_B, USER_1, buildPurchasing } from './helpers.js';
import { accessKeyCheckDigit } from '../domain/sri-access-key.js';
import { ReceivedDocumentNotFoundError, ReceivedDocumentXmlMismatchError, ValidationError } from '../domain/errors.js';
import { MAX_FETCH_ATTEMPTS, retryDelayMs } from '../domain/received-document.js';
import { parseAuthorizationResponse } from '../infrastructure/sri/sri-authorization-client.js';
import { SriUnavailableError } from '../domain/errors.js';

// «Hoy» de las pruebas es 2026-10-20 (el reloj por defecto de buildPurchasing).
let store: InMemoryStore;
let now: Date;
let p: ReturnType<typeof buildPurchasing>;

beforeEach(() => {
  store = new InMemoryStore();
  now = new Date('2026-10-20T15:00:00Z');
  p = buildPurchasing(store, () => now);
});

/** Clave válida con el dígito calculado: las pruebas no cargan facturas reales de nadie. */
function key(date: string, seq: string, ruc = '1790012345001'): string {
  const base48 = `${date}01${ruc}2001002${seq}123456781`;
  return base48 + accessKeyCheckDigit(base48);
}
const RECENT = key('15102026', '000000001');
const RECENT_2 = key('16102026', '000000002');
const OLD = key('28022026', '000000003');

const HEADER = 'RUC_EMISOR\tRAZON_SOCIAL_EMISOR\tTIPO_COMPROBANTE\tSERIE_COMPROBANTE\tCLAVE_ACCESO\tFECHA_AUTORIZACION\tFECHA_EMISION\tIDENTIFICACION_RECEPTOR\tVALOR_SIN_IMPUESTOS\tIVA\tIMPORTE_TOTAL\tNUMERO_DOCUMENTO_MODIFICADO';
const row = (k: string, total = '115') => ['1790012345001', 'PROVEEDOR S.A.', 'Factura', '001-002-000000001', k, '15/10/2026 10:00:00', '15/10/2026', '0912345678', '100', '15', total, ''].join('\t');
const report = (...keys: string[]) => [HEADER, ...keys.map((k) => row(k))].join('\r\n');

const importReport = (text: string, org = ORG_A) => p.uc.importSriReport.execute({ organizationId: org, userId: USER_1, text });
const authorized = (k: string) => ({ state: 'authorized' as const, xml: `<factura><infoTributaria><claveAcceso>${k}</claveAcceso></infoTributaria></factura>`, authorizationNumber: k, authorizedAt: '2026-10-15T10:00:00-05:00' });

describe('importar el reporte', () => {
  it('registra las claves nuevas: las recientes quedan pendientes y las viejas esperan al portal', async () => {
    const r = await importReport(report(RECENT, OLD));
    expect(r).toMatchObject({ total: 2, created: 2, duplicates: 0, needsPortal: 1 });
    const page = await p.uc.listReceivedDocuments.execute({ organizationId: ORG_A, filters: { page: 1, pageSize: 25 } });
    expect(page.items.map((d) => [d.accessKey, d.status])).toEqual([[RECENT, 'pending'], [OLD, 'needs_portal']]);
    expect(page.items.find((d) => d.accessKey === OLD)!.nextAttemptAt).toBeNull();
    expect(store.eventTypes()).toEqual(['purchasing.sri_document.imported']);
  });

  it('reimportar el mismo reporte no duplica nada ni vuelve a poner en cola lo ya bajado', async () => {
    await importReport(report(RECENT, RECENT_2));
    p.sri.results.set(RECENT, authorized(RECENT));
    await p.uc.fetchReceivedDocuments.execute();

    const again = await importReport(report(RECENT, RECENT_2, key('17102026', '000000004')));
    expect(again).toMatchObject({ total: 3, created: 1, duplicates: 2 });
    const downloaded = await p.uc.listReceivedDocuments.execute({ organizationId: ORG_A, filters: { page: 1, pageSize: 25, status: 'downloaded' } });
    expect(downloaded.items.map((d) => d.accessKey)).toEqual([RECENT]);
  });

  it('una clave repetida dentro del archivo cuenta una sola vez', async () => {
    const r = await importReport(report(RECENT, RECENT));
    expect(r).toMatchObject({ total: 2, created: 1, duplicates: 1 });
  });

  it('la misma clave en dos organizaciones son dos registros independientes', async () => {
    await importReport(report(RECENT), ORG_A);
    const b = await importReport(report(RECENT), ORG_B);
    expect(b.created).toBe(1);
    expect((await p.uc.listReceivedDocuments.execute({ organizationId: ORG_A, filters: { page: 1, pageSize: 25 } })).total).toBe(1);
  });

  it('una fila mala se informa y las demás se registran', async () => {
    const bad = RECENT.slice(0, 48) + (RECENT[48] === '9' ? '0' : String(Number(RECENT[48]) + 1));
    const r = await importReport([HEADER, row(RECENT_2), row(bad)].join('\n'));
    expect(r.created).toBe(1);
    expect(r.rejected).toHaveLength(1);
    expect(r.rejected[0]!.line).toBe(3);
  });

  it('un archivo que no es el reporte da 422 y no registra nada', async () => {
    await expect(importReport('esto no es un reporte')).rejects.toBeInstanceOf(ValidationError);
    expect(store.receivedMap.size).toBe(0);
    expect(store.outboxEvents).toHaveLength(0);
  });
});

describe('traer los XML pendientes', () => {
  it('baja el XML autorizado, lo guarda y publica el evento; la segunda corrida no vuelve a pedirlo', async () => {
    await importReport(report(RECENT));
    p.sri.results.set(RECENT, authorized(RECENT));

    const first = await p.uc.fetchReceivedDocuments.execute();
    expect(first).toMatchObject({ attempted: 1, downloaded: 1, retrying: 0 });
    const doc = [...store.receivedMap.values()][0]!;
    expect(doc).toMatchObject({ status: 'downloaded', nextAttemptAt: null, lastError: null, attempts: 1 });
    expect(doc.xml).toContain(RECENT);
    expect(store.eventTypes()).toEqual(['purchasing.sri_document.imported', 'purchasing.sri_document.downloaded']);

    const second = await p.uc.fetchReceivedDocuments.execute();
    expect(second.attempted).toBe(0);
    expect(p.sri.calls).toEqual([RECENT]);
  });

  it('si el SRI no contesta, el documento sigue pendiente con espera creciente y no se pierde', async () => {
    await importReport(report(RECENT));
    p.sri.down = true;

    expect(await p.uc.fetchReceivedDocuments.execute()).toMatchObject({ attempted: 1, retrying: 1, downloaded: 0 });
    const doc = [...store.receivedMap.values()][0]!;
    expect(doc).toMatchObject({ status: 'pending', attempts: 1 });
    expect(doc.lastError).toMatch(/sin respuesta/);
    expect(doc.nextAttemptAt!.getTime() - now.getTime()).toBe(retryDelayMs(1));

    // Todavía no toca: no se le insiste al SRI.
    expect((await p.uc.fetchReceivedDocuments.execute()).attempted).toBe(0);

    // Pasa el tiempo y el SRI vuelve.
    now = new Date(now.getTime() + 20 * 60_000);
    p.sri.down = false;
    p.sri.results.set(RECENT, authorized(RECENT));
    expect(await p.uc.fetchReceivedDocuments.execute()).toMatchObject({ downloaded: 1 });
  });

  it('tras agotar los reintentos queda fallido y deja de intentarse', async () => {
    await importReport(report(RECENT));
    p.sri.down = true;
    for (let i = 0; i < MAX_FETCH_ATTEMPTS; i++) {
      await p.uc.fetchReceivedDocuments.execute();
      now = new Date(now.getTime() + 13 * 3_600_000);
    }
    const doc = [...store.receivedMap.values()][0]!;
    expect(doc).toMatchObject({ status: 'failed', attempts: MAX_FETCH_ATTEMPTS, nextAttemptAt: null });
    expect(store.eventTypes()).toContain('purchasing.sri_document.unavailable');
    p.sri.calls.length = 0;
    await p.uc.fetchReceivedDocuments.execute();
    expect(p.sri.calls).toEqual([]);
  });

  it('«fuera de rango» manda el documento al portal sin reintentar; «no autorizado» lo cierra', async () => {
    await importReport(report(RECENT, RECENT_2));
    p.sri.results.set(RECENT, { state: 'out_of_range' });
    p.sri.results.set(RECENT_2, { state: 'not_authorized', reason: '[70] CLAVE DE ACCESO EN PROCESAMIENTO' });
    expect(await p.uc.fetchReceivedDocuments.execute()).toMatchObject({ needsPortal: 1, notAuthorized: 1 });
    const byKey = new Map([...store.receivedMap.values()].map((d) => [d.accessKey, d]));
    expect(byKey.get(RECENT)).toMatchObject({ status: 'needs_portal', nextAttemptAt: null });
    expect(byKey.get(RECENT_2)).toMatchObject({ status: 'not_authorized', lastError: expect.stringContaining('PROCESAMIENTO') });
  });

  it('un XML que no cita la clave pedida no se guarda como bueno', async () => {
    await importReport(report(RECENT));
    p.sri.results.set(RECENT, { ...authorized(RECENT), xml: '<factura>de otro comprobante</factura>' });
    expect(await p.uc.fetchReceivedDocuments.execute()).toMatchObject({ downloaded: 0, retrying: 1 });
    expect([...store.receivedMap.values()][0]!.xml).toBeNull();
  });

  it('«aún no existe» se reintenta', async () => {
    await importReport(report(RECENT));
    expect(await p.uc.fetchReceivedDocuments.execute()).toMatchObject({ retrying: 1 });
  });
});

describe('subir el XML a mano', () => {
  it('guarda el XML de un documento que el web service ya no contesta', async () => {
    await importReport(report(OLD));
    const id = [...store.receivedMap.values()][0]!.id;
    const doc = await p.uc.attachReceivedXml.execute({ organizationId: ORG_A, documentId: id, xml: `<autorizacion><estado>AUTORIZADO</estado><numeroAutorizacion>${OLD}</numeroAutorizacion></autorizacion>` });
    expect(doc).toMatchObject({ status: 'downloaded', source: 'manual' });
    expect(store.eventTypes()).toContain('purchasing.sri_document.downloaded');
  });

  it('rechaza un XML de otro comprobante o no autorizado', async () => {
    await importReport(report(OLD));
    const id = [...store.receivedMap.values()][0]!.id;
    await expect(p.uc.attachReceivedXml.execute({ organizationId: ORG_A, documentId: id, xml: `<factura>${RECENT}</factura>` })).rejects.toBeInstanceOf(ReceivedDocumentXmlMismatchError);
    await expect(p.uc.attachReceivedXml.execute({ organizationId: ORG_A, documentId: id, xml: `<autorizacion><estado>NO AUTORIZADO</estado>${OLD}</autorizacion>` })).rejects.toBeInstanceOf(ReceivedDocumentXmlMismatchError);
    expect([...store.receivedMap.values()][0]!.status).toBe('needs_portal');
  });

  it('no pisa un XML que ya estaba guardado', async () => {
    await importReport(report(RECENT));
    p.sri.results.set(RECENT, authorized(RECENT));
    await p.uc.fetchReceivedDocuments.execute();
    const doc = [...store.receivedMap.values()][0]!;
    const again = await p.uc.attachReceivedXml.execute({ organizationId: ORG_A, documentId: doc.id, xml: `<factura>${RECENT} distinto</factura>` });
    expect(again.xml).toBe(doc.xml);
  });

  it('un documento de otra organización no existe', async () => {
    await importReport(report(OLD), ORG_A);
    const id = [...store.receivedMap.values()][0]!.id;
    await expect(p.uc.attachReceivedXml.execute({ organizationId: ORG_B, documentId: id, xml: `<x>${OLD}</x>` })).rejects.toBeInstanceOf(ReceivedDocumentNotFoundError);
  });
});

describe('estado: ¿estoy al día?', () => {
  it('cuenta por estado y dice hasta qué fecha se tiene', async () => {
    expect(await p.uc.getReceivedDocumentsStatus.execute({ organizationId: ORG_A })).toMatchObject({ latestIssueDate: null });
    await importReport(report(RECENT, RECENT_2, OLD));
    p.sri.results.set(RECENT, authorized(RECENT));
    await p.uc.fetchReceivedDocuments.execute();
    const s = await p.uc.getReceivedDocumentsStatus.execute({ organizationId: ORG_A });
    expect(s.counts).toEqual({ pending: 1, needs_portal: 1, downloaded: 1, not_authorized: 0, failed: 0 });
    expect(s.latestIssueDate).toBe('2026-10-16');
  });
});

describe('API', () => {
  const H = (perms: string[]) => ({ 'Content-Type': 'application/json', 'X-Organization-Id': ORG_A, 'X-User-Id': USER_1, 'X-Permissions': perms.join(',') });

  it('importa, lista, trae el XML y exige permiso en cada paso', async () => {
    const imp = await p.app.request('/purchasing/received-documents/import', { method: 'POST', headers: H(['purchase_bill:create']), body: JSON.stringify({ report: report(RECENT) }) });
    expect(imp.status).toBe(201);
    expect(await imp.json()).toMatchObject({ created: 1, duplicates: 0 });

    const noPerm = await p.app.request('/purchasing/received-documents/import', { method: 'POST', headers: H(['purchase_bill:read']), body: JSON.stringify({ report: report(RECENT) }) });
    expect(noPerm.status).toBe(403);

    const list = await p.app.request('/purchasing/received-documents?status=pending', { headers: H(['purchase_bill:read']) });
    const body = (await list.json()) as { items: { id: string; accessKey: string; xml?: unknown }[] };
    expect(body.items).toHaveLength(1);
    expect(body.items[0]).not.toHaveProperty('xml');

    const id = body.items[0]!.id;
    expect((await p.app.request(`/purchasing/received-documents/${id}/xml`, { headers: H(['purchase_bill:read']) })).status).toBe(404);

    const put = await p.app.request(`/purchasing/received-documents/${id}/xml`, { method: 'PUT', headers: H(['purchase_bill:create']), body: `<factura><claveAcceso>${RECENT}</claveAcceso></factura>` });
    expect(put.status).toBe(200);
    const xml = await p.app.request(`/purchasing/received-documents/${id}/xml`, { headers: H(['purchase_bill:read']) });
    expect(xml.status).toBe(200);
    expect(xml.headers.get('content-type')).toContain('application/xml');
    expect(await xml.text()).toContain(RECENT);

    const status = await p.app.request('/purchasing/received-documents/status', { headers: H(['purchase_bill:read']) });
    expect(((await status.json()) as { counts: Record<string, number> }).counts.downloaded).toBe(1);
  });

  it('un cuerpo de importación inválido es 422', async () => {
    const res = await p.app.request('/purchasing/received-documents/import', { method: 'POST', headers: H(['purchase_bill:create']), body: JSON.stringify({ report: '' }) });
    expect(res.status).toBe(422);
  });
});

describe('leer la respuesta SOAP del SRI', () => {
  const wrap = (inner: string) => `<soap:Envelope xmlns:soap="x"><soap:Body><ns2:autorizacionComprobanteResponse xmlns:ns2="y"><RespuestaAutorizacionComprobante><claveAccesoConsultada>${RECENT}</claveAccesoConsultada>${inner}</RespuestaAutorizacionComprobante></ns2:autorizacionComprobanteResponse></soap:Body></soap:Envelope>`;

  it('autorizado: devuelve el XML sin el envoltorio CDATA', () => {
    const r = parseAuthorizationResponse(wrap(`<autorizaciones><autorizacion><estado>AUTORIZADO</estado><numeroAutorizacion>${RECENT}</numeroAutorizacion><fechaAutorizacion>2026-10-15T10:00:00-05:00</fechaAutorizacion><comprobante><![CDATA[<factura><claveAcceso>${RECENT}</claveAcceso></factura>]]></comprobante></autorizacion></autorizaciones>`));
    expect(r).toMatchObject({ state: 'authorized', authorizationNumber: RECENT, authorizedAt: '2026-10-15T10:00:00-05:00' });
    expect(r.state === 'authorized' && r.xml).toBe(`<factura><claveAcceso>${RECENT}</claveAcceso></factura>`);
  });

  it('sin autorizaciones: el SRI aún no lo tiene', () => {
    expect(parseAuthorizationResponse(wrap('<numeroComprobantes>0</numeroComprobantes><autorizaciones/>'))).toEqual({ state: 'not_found' });
  });

  it('RECHAZADA con identificador 80: fuera del rango del web service (respuesta real del SRI)', () => {
    const r = parseAuthorizationResponse(wrap('<autorizaciones><autorizacion><estado>RECHAZADA</estado><mensajes><mensaje><identificador>80</identificador><mensaje>ERROR EN LA ESTRUCTURA DE LA CLAVE DE ACCESO</mensaje><informacionAdicional>No es posible validar la clave de acceso ya que la fecha de emision esta fuera del rango permitido.</informacionAdicional></mensaje></mensajes></autorizacion></autorizaciones>'));
    expect(r).toEqual({ state: 'out_of_range' });
  });

  it('RECHAZADA por otro motivo: no autorizado, con el motivo', () => {
    const r = parseAuthorizationResponse(wrap('<autorizaciones><autorizacion><estado>NO AUTORIZADO</estado><mensajes><mensaje><identificador>39</identificador><mensaje>FIRMA INVALIDA</mensaje></mensaje></mensajes></autorizacion></autorizaciones>'));
    expect(r).toMatchObject({ state: 'not_authorized', reason: expect.stringContaining('FIRMA INVALIDA') });
  });

  it('un SOAP Fault es indisponibilidad (se reintenta), no un rechazo', () => {
    expect(() => parseAuthorizationResponse('<soap:Envelope><soap:Body><soap:Fault><faultstring>boom</faultstring></soap:Fault></soap:Body></soap:Envelope>')).toThrow(SriUnavailableError);
    expect(() => parseAuthorizationResponse('<html>502</html>')).toThrow(SriUnavailableError);
  });
});
