import type { SriAuthorizationPort, SriFetchResult } from '../../application/ports.js';
import { SriUnavailableError } from '../../domain/errors.js';

function tag(xml: string, name: string): string | undefined {
  return xml.match(new RegExp(String.raw`<(?:\w+:)?${name}>([\s\S]*?)</(?:\w+:)?${name}>`))?.[1]?.trim();
}

function decodeEntities(value: string): string {
  return value.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');
}

const envelope = (accessKey: string) => `<?xml version="1.0" encoding="UTF-8"?>
<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/" xmlns:ec="http://ec.gob.sri.ws.autorizacion">
  <soapenv:Header/>
  <soapenv:Body>
    <ec:autorizacionComprobante>
      <claveAccesoComprobante>${accessKey}</claveAccesoComprobante>
    </ec:autorizacionComprobante>
  </soapenv:Body>
</soapenv:Envelope>`;

/** Mensajes de la respuesta, unidos en una línea legible. */
function messagesOf(block: string): string {
  const parts: string[] = [];
  for (const m of block.matchAll(/<mensaje>\s*<identificador>([\s\S]*?)<\/identificador>\s*<mensaje>([\s\S]*?)<\/mensaje>(?:\s*<informacionAdicional>([\s\S]*?)<\/informacionAdicional>)?/g)) {
    parts.push(`[${m[1]!.trim()}] ${decodeEntities(m[2]!.trim())}${m[3] ? `: ${decodeEntities(m[3].trim())}` : ''}`);
  }
  return parts.join('; ');
}

/**
 * Lee la respuesta SOAP de `autorizacionComprobante`. Separada del `fetch` para probarla con respuestas reales sin red.
 *
 * Tres respuestas que NO son «autorizado» y que el cliente de emisión de fiscal-ecuador no distingue porque allí no hacen falta:
 * `RECHAZADA` con identificador 80 («fecha de emisión fuera del rango», un comprobante viejo: no es un error, hay que ir al portal),
 * `RECHAZADA` por otro motivo, y cero autorizaciones (el SRI aún no lo tiene).
 */
export function parseAuthorizationResponse(soapXml: string): SriFetchResult {
  if (/<(?:\w+:)?Fault>/.test(soapXml)) {
    throw new SriUnavailableError(`SRI: SOAP Fault (${decodeEntities(tag(soapXml, 'faultstring') ?? 'sin detalle')})`);
  }
  if (!/RespuestaAutorizacionComprobante/.test(soapXml)) throw new SriUnavailableError('SRI: la respuesta no es de autorización.');

  const blocks = soapXml.match(/<autorizacion>[\s\S]*?<\/autorizacion>/g) ?? [];
  if (blocks.length === 0) return { state: 'not_found' };

  // Puede haber varias para la misma clave (intentos anteriores): manda la autorizada si existe.
  const chosen = blocks.find((b) => tag(b, 'estado') === 'AUTORIZADO') ?? blocks[0]!;
  const estado = tag(chosen, 'estado');

  if (estado === 'AUTORIZADO') {
    const raw = chosen.match(/<comprobante>([\s\S]*?)<\/comprobante>/)?.[1]?.trim();
    if (!raw) throw new SriUnavailableError('SRI: comprobante autorizado sin XML.');
    const xml = raw.startsWith('<![CDATA[') ? raw.slice('<![CDATA['.length, -']]>'.length) : decodeEntities(raw);
    return {
      state: 'authorized',
      xml,
      authorizationNumber: tag(chosen, 'numeroAutorizacion') ?? null,
      authorizedAt: tag(chosen, 'fechaAutorizacion') ?? null,
    };
  }
  if (estado === 'EN PROCESAMIENTO') return { state: 'not_found' };

  const messages = messagesOf(chosen);
  if (/<identificador>80<\/identificador>/.test(chosen) || /fuera del rango/i.test(messages)) return { state: 'out_of_range' };
  return { state: 'not_authorized', reason: (messages || estado || 'sin detalle').slice(0, 500) };
}

/** Cliente real del web service «AutorizacionComprobantesOffline». Toda llamada tiene tiempo máximo: el SRI a veces acepta y no contesta. */
export class HttpSriAuthorizationClient implements SriAuthorizationPort {
  constructor(private readonly endpoint: string, private readonly timeoutMs: number) {}

  async fetchByAccessKey(accessKey: string): Promise<SriFetchResult> {
    let response: Response;
    try {
      response = await fetch(this.endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'text/xml; charset=utf-8', SOAPAction: '' },
        body: envelope(accessKey),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (err) {
      const timedOut = err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError');
      throw new SriUnavailableError(`SRI: ${timedOut ? `sin respuesta en ${Math.round(this.timeoutMs / 1000)} s` : (err as Error).message}`);
    }
    const text = await response.text();
    // Un Fault llega con HTTP 500: se lee antes de mirar el código para dar el motivo real.
    if (!response.ok && !/<(?:\w+:)?Fault>/.test(text)) throw new SriUnavailableError(`SRI: HTTP ${response.status}`);
    return parseAuthorizationResponse(text);
  }
}
