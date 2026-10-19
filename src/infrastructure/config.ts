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
  // fiscal-ecuador: emite las retenciones (E.1) y llama de vuelta cuando autoriza.
  FISCAL_SERVICE_URL: z.string().default('http://fiscal-ecuador-node:3010'),
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
