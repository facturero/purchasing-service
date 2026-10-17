import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

function leerCodigo(ruta: string): string {
  return readFileSync(ruta, 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');
}

const codigo = leerCodigo(join(process.cwd(), 'src', 'infrastructure', 'persistence', 'repositories.ts'));
const migracion = readFileSync(join(process.cwd(), 'migrations', '20261016120000-create-purchasing-tables.cjs'), 'utf8');

describe('los repositorios guardan por clave primaria', () => {
  it('no usan `upsert`: en MySQL reacciona a CUALQUIER índice único y pisaría en silencio la fila de otro', () => {
    expect(/\.upsert\(/.test(codigo)).toBe(false);
  });

  it('toda consulta a una tabla con datos de la organización la filtra por organization_id', () => {
    // Cada `findOne`/`findAndCountAll`/`update`/`count` sobre proveedores y órdenes lleva `organization_id`.
    const consultas = codigo.match(/(SupplierModel|OrderModel)\.(findOne|findAndCountAll|update|count)\(\s*\{[^}]*\}/g) ?? [];
    expect(consultas.length).toBeGreaterThan(5);
    for (const c of consultas) expect(c, c).toMatch(/organization_id|\bwhere\b/);
  });
});

describe('la numeración de órdenes', () => {
  it('sube el contador en UNA sentencia y lo lee con FOR UPDATE (nada de SELECT y luego UPDATE)', () => {
    const cuerpo = codigo.slice(codigo.indexOf('async nextSequence'));
    expect(cuerpo).toMatch(/ON DUPLICATE KEY UPDATE current_value = current_value \+ 1/);
    expect(cuerpo).toMatch(/FOR UPDATE/);
    expect(cuerpo).not.toMatch(/INSERT IGNORE/);
  });
});

describe('las órdenes se guardan sin pisarse', () => {
  it('el UPDATE de una orden existente exige la versión que se leyó', () => {
    const guardar = codigo.slice(codigo.indexOf('async save(order, expectedVersion)'), codigo.indexOf('async nextSequence'));
    expect(guardar).toMatch(/version:\s*expectedVersion/);
    expect(guardar).toMatch(/ConcurrentUpdateError/);
  });

  it('las decisiones (aprobar, cancelar) leen con bloqueo', () => {
    expect(codigo).toMatch(/lock: tx!\.LOCK\.UPDATE/);
    expect(codigo).toMatch(/\.\.\.\(lock && tx \? \{ lock: tx\.LOCK\.UPDATE \}/);
  });
});

describe('el esquema impide importes incoherentes', () => {
  it('la orden y sus líneas tienen CHECK de importes y cantidades', () => {
    expect(migracion).toMatch(/purchase_orders_amounts_chk[^']*total_cents = subtotal_cents \+ tax_cents/);
    expect(migracion).toMatch(/purchase_order_lines_chk[^']*quantity_micros > 0/);
  });

  it('el número de la orden es único por organización', () => {
    expect(migracion).toMatch(/\['organization_id', 'number'\], \{ unique: true/);
  });
});
