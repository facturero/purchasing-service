import { CatalogUnavailableError } from '../../domain/errors.js';
import type {
  ProductCatalogPort,
  ProductInfo,
  TaxRateInfo,
  TaxRatePort,
  WarehouseCatalogPort,
  WarehouseInfo,
} from '../../application/ports.js';

const TIMEOUT_MS = 8_000;

/**
 * purchasing-service llama a product-service, tax-service e inventory-service directo (server-to-server, sin pasar por el gateway),
 * así que pone ella misma las cabeceras que cada servicio espera del gateway. Si un catálogo no responde se LANZA
 * `CatalogUnavailableError` (502): jamás se da por inexistente un producto que simplemente no se pudo consultar.
 */
async function getJson<T>(url: string, headers: Record<string, string>, what: string): Promise<T | null> {
  let response: Response;
  try {
    response = await fetch(url, { headers, signal: AbortSignal.timeout(TIMEOUT_MS) });
  } catch (err) {
    console.warn(`[purchasing-service] no se pudo consultar ${what}: ${(err as Error).message}`);
    throw new CatalogUnavailableError();
  }
  if (response.status === 404) return null;
  if (!response.ok) {
    console.warn(`[purchasing-service] ${what} respondió ${response.status}`);
    throw new CatalogUnavailableError();
  }
  return (await response.json()) as T;
}

export class HttpProductCatalog implements ProductCatalogPort {
  constructor(private readonly baseUrl: string) {}

  async findById(organizationId: string, productId: string): Promise<ProductInfo | null> {
    const data = await getJson<{ id: string; name: string; sku: string | null; status: string; trackStock?: boolean; taxes?: { taxRateId: string; kind: string }[] }>(
      `${this.baseUrl}/products/${encodeURIComponent(productId)}`,
      { 'X-Organization-Id': organizationId, 'X-Permissions': 'product:read' },
      'el producto',
    );
    if (!data) return null;
    return { id: data.id, name: data.name, sku: data.sku ?? null, status: data.status, tracksStock: data.trackStock === true, taxes: (data.taxes ?? []).map((t) => ({ taxRateId: t.taxRateId, kind: t.kind })) };
  }
}

/** tax-service solo lista por país: se trae la lista y se busca el id, con una caché corta para no repetirla en cada línea. */
export class HttpTaxRateCatalog implements TaxRatePort {
  private cache = new Map<string, { rates: TaxRateInfo[]; expiresAt: number }>();

  constructor(private readonly baseUrl: string, private readonly ttlMs = 60_000) {}

  async findRate(countryCode: string, taxRateId: string): Promise<TaxRateInfo | null> {
    return (await this.ratesFor(countryCode)).find((r) => r.id === taxRateId) ?? null;
  }

  private async ratesFor(countryCode: string): Promise<TaxRateInfo[]> {
    const cached = this.cache.get(countryCode);
    if (cached && cached.expiresAt > Date.now()) return cached.rates;
    const data = await getJson<{ id: string; percentage: string | number; kind: string }[]>(
      `${this.baseUrl}/countries/${encodeURIComponent(countryCode)}/tax-rates`,
      { 'X-User-Id': 'purchasing-service' },
      'las tarifas de impuesto',
    );
    const rates = (data ?? []).map((r) => ({ id: r.id, percentage: String(r.percentage), kind: r.kind }));
    this.cache.set(countryCode, { rates, expiresAt: Date.now() + this.ttlMs });
    return rates;
  }
}

export class HttpWarehouseCatalog implements WarehouseCatalogPort {
  constructor(private readonly baseUrl: string) {}

  async findById(organizationId: string, warehouseId: string): Promise<WarehouseInfo | null> {
    const data = await getJson<{ id: string; name: string; status: string }>(
      `${this.baseUrl}/warehouses/${encodeURIComponent(warehouseId)}`,
      { 'X-Organization-Id': organizationId, 'X-Permissions': 'inventory:read' },
      'la bodega',
    );
    return data ? { id: data.id, name: data.name, status: data.status } : null;
  }
}
