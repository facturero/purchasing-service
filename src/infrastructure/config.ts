import 'dotenv/config';
import { z } from 'zod';

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  // 3017: 3016 es accounting; ningún otro servicio lo ocupa.
  PORT: z.coerce.number().int().positive().default(3017),
  DB_HOST: z.string().min(1),
  DB_PORT: z.coerce.number().int().positive().default(3306),
  DB_USER: z.string().min(1),
  DB_PASSWORD: z.string().default(''),
  DB_NAME: z.string().min(1),
  RABBITMQ_URL: z.string().optional(),
  CORS_ORIGIN: z.string().default('*'),
  INTERNAL_USER_ID: z.string().default('00000000-0000-0000-0000-000000000000'),
  // Servicios que se consultan para validar productos, tarifas de impuesto y bodegas (server-to-server, sin pasar por el gateway).
  PRODUCT_SERVICE_URL: z.string().default('http://product-service:3006'),
  TAX_SERVICE_URL: z.string().default('http://tax-service:3005'),
  INVENTORY_SERVICE_URL: z.string().default('http://inventory-service:3013'),
  // Web service de autorización del SRI (producción). Solo contesta por comprobantes de los últimos ~6 meses.
  SRI_AUTHORIZATION_URL: z.string().default('https://cel.sri.gob.ec/comprobantes-electronicos-ws/AutorizacionComprobantesOffline'),
  SRI_TIMEOUT_MS: z.coerce.number().int().positive().default(30_000),
  // Cada cuántos minutos se buscan los XML de los comprobantes recibidos pendientes. 0 apaga el trabajo.
  RECEIVED_DOCS_FETCH_INTERVAL_MINUTES: z.coerce.number().int().min(0).default(30),
  // SRI Portal sync
  SRI_PORTAL_ENABLED: z.coerce.boolean().default(false),
  SRI_PORTAL_CRON_INTERVAL_MINUTES: z.coerce.number().int().min(5).default(60),
  // Ventana de meses hacia atrás que se recorre (incluye el mes actual). El cursor
  // guardado en la base avanza un periodo por corrida hasta cubrirla y vuelve a empezar.
  SRI_PORTAL_SYNC_MONTHS: z.coerce.number().int().min(1).max(36).default(12),
  // Periodos que intenta cada corrida. Cada periodo gasta un captcha: con el solver en
  // `manual` conviene 1-2 y espaciar las corridas (el portal castiga la repetición).
  SRI_PORTAL_PERIODS_PER_RUN: z.coerce.number().int().min(1).max(12).default(2),
  SRI_PORTAL_ENCRYPTION_KEY: z.string().min(16).default('dev-sri-portal-key-change-me-32bytes'),
  // Opcional: si se define se falsea el UA, y reCAPTCHA Enterprise lo detecta como
  // incoherente con Sec-CH-UA/navigator.platform. Solo para depurar; en serio, vacío.
  SRI_PORTAL_USER_AGENT: z.string().optional(),
  PUPPETEER_EXECUTABLE_PATH: z.string().optional(),
  // Opcional: proxy del navegador del portal, `http://usuario:clave@host:puerto` (o
  // `host:puerto`). La IP de salida ya es residencial; esto sirve para *cambiar* de IP
  // (una nueva, no quemada por los captchas rechazados), no para "parecer residencial".
  SRI_PORTAL_PROXY: z.string().optional(),
  // Perfil de navegador por RUC (cookies e historial). Vacío = perfil efímero.
  SRI_PORTAL_PROFILE_DIR: z.string().default('/tmp/sri-portal-profiles'),
  // `fresh`: el perfil de Chrome se borra al empezar cada corrida (recomendado — un perfil
  // usado deja de pasar el captcha en ~30 min, ver IMPLEMENTATION.md). `persistent`: se
  // conserva entre corridas y solo se borra si una corrida falla.
  SRI_PORTAL_PROFILE_MODE: z.enum(['fresh', 'persistent']).default('fresh'),
  CAPTCHA_SOLVER: z.enum(['manual', '2captcha', 'anticaptcha']).default('manual'),
  CAPTCHA_API_KEY: z.string().optional(),
  CAPTCHA_POLL_INTERVAL_MS: z.coerce.number().int().min(1000).default(5000),
  CAPTCHA_TIMEOUT_MS: z.coerce.number().int().min(60000).default(300000),
  SRI_PORTAL_MAX_LOGIN_ATTEMPTS: z.coerce.number().int().min(1).max(10).default(3),
  CRM_BASE_URL: z.string().default('https://crm.noahsolution.com'),
});

const parsed = schema.safeParse(process.env);

if (!parsed.success) {
  const issues = parsed.error.issues
    .map((i) => `  - ${i.path.join('.')}: ${i.message}`)
    .join('\n');
  console.error(`Configuración de entorno inválida:\n${issues}`);
  process.exit(1);
}

export type AppConfig = z.infer<typeof schema>;
export const config: AppConfig = parsed.data;
