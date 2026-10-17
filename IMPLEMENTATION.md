# purchasing-service — Compras

Servicio de compras del plan ERP (Fase 2, ver `PLAN-ERP.md`). **Fase 2.1 construida y verificada en local, sin desplegar:** proveedores y órdenes de compra con aprobación. Las fases siguientes (recepción, factura de compra con conciliación a tres vías, retención en la compra y su asiento) cuelgan de este mismo servicio.

- Puerto 3017 · base `purchasing_db` · rama `main` · repo `facturero/purchasing-service` (por crear).
- Plugins: `inventory.suppliers` (proveedores) y `purchasing.purchase_orders` (órdenes y política de aprobación). El gateway exige el plugin de cada ruta.
- Hono + Sequelize + MySQL, Clean Architecture, outbox con `@facturero/outbox-relay` (publica; todavía no consume nada).

## Qué hace

| Recurso | Rutas (`/purchasing/…`) | Permiso |
|---|---|---|
| Proveedores | `GET/POST suppliers`, `GET/PUT suppliers/:id`, `POST suppliers/:id/(de)activate` | `supplier:read` / `supplier:manage` |
| Órdenes | `GET/POST orders`, `GET/PUT orders/:id` (solo borrador), `POST orders/:id/submit` | `purchase:read` / `purchase:create` |
| Decisión | `POST orders/:id/approve`, `POST orders/:id/reject` | `purchase:approve` |
| Cancelar | `POST orders/:id/cancel` (lo aprobado exige además `purchase:cancel`), `POST orders/:id/reopen` (rechazada → borrador) | `purchase:create` |
| Política | `GET/PUT settings` | `purchase:read` / `purchase:approve` |

Ciclo de la orden: `draft → pending_approval → approved → (partially_received → received → closed)`; `rejected` vuelve a borrador; `cancelled` es final. Lo que va entre paréntesis es de la Fase 2.2.

## Decisiones que importan

1. **Importes en centavos enteros; cantidades en millonésimas (`bigint`).** Hasta 6 decimales sin pérdida (kilos, litros). cantidad × costo se calcula en `bigint` y se redondea UNA vez, a la mitad hacia arriba; el IVA se calcula por línea sobre su subtotal. La API devuelve las cantidades como TEXTO (`"10.5"`): un `number` perdería decimales y `bigint` no cabe en JSON. El costo unitario es en centavos enteros, igual que billing e inventario (limitación conocida: un costo de 0,0375 no cabe; se revisa en la Fase 5 junto con el costeo).
2. **Solo un borrador se edita.** Una orden enviada es un compromiso con el proveedor: se cancela con motivo y se hace otra; si la rechazaron, se reabre como borrador. Editar usa `version` (bloqueo optimista) y lee la fila con bloqueo, así que dos ediciones a la vez se aplican en orden y una escritura con versión vieja se rechaza (`409 CONCURRENT_UPDATE`).
3. **Numeración `OC-AAAA-NNNNNN` al ENVIAR**, no al crear (los borradores no gastan secuencial). Contador por (organización, año): `INSERT … ON DUPLICATE KEY UPDATE` + `SELECT … FOR UPDATE` en una transacción, la misma forma que numera retenciones en fiscal-ecuador. Verificado: 30 envíos simultáneos dan 30 números seguidos, sin interbloqueos.
4. **Aprobación por monto, con separación de funciones.** `purchasing_settings.approval_threshold_cents`: `NULL` = nunca se pide (la orden queda aprobada al enviarla, «por política», sin aprobador y así se ve); `0` = siempre; `N` = desde N centavos. Quien preparó la orden NO la aprueba ni la rechaza (`SELF_APPROVAL_NOT_ALLOWED`); cancelar lo YA aprobado es un permiso aparte. **Esto sustituye provisionalmente al `workflow-service` del plan** (regla 7: ningún módulo programa su propio «¿quién aprueba?»): cuando exista, la política se mueve allá y `purchasing-service` solo declara el tipo de documento y el monto.
5. **Los catálogos se consultan FUERA de la transacción de base de datos** (producto, tarifa de IVA, bodega, por HTTP server-to-server). Si uno no responde, 502 `CATALOG_UNAVAILABLE`: nunca se da por inexistente algo que no se pudo consultar. La línea guarda nombre, SKU y porcentaje de IVA del momento: renombrar el producto o cambiar la tarifa no altera una orden vieja.
6. **La identificación del proveedor no se edita** (las órdenes y retenciones la citan; una retención al RUC equivocado no se corrige editando el maestro). Si estaba mal, se desactiva el proveedor y se crea otro. Los proveedores no se borran. Único por (organización, identificación).
7. **Solo IVA en la orden.** Otros impuestos (ICE, IRBPNR) llegan con la factura de compra. La tarifa de una línea debe ser de tipo `vat`.
8. **Aislamiento por organización en todo:** toda consulta filtra `organization_id`; probado por HTTP, en los casos de uso y contra MySQL.
9. **El esquema impide importes incoherentes:** `CHECK total = subtotal + impuesto` en la orden y en cada línea, cantidades positivas.

## Eventos

Publica (outbox → `crm.events`): `purchasing.supplier.upserted`, `purchasing.order.created|updated|submitted|approved|rejected|cancelled|reopened`, `purchasing.settings.updated`. Todos llevan `organizationId` y el actor (la bitácora los recoge por el comodín). `purchasing.order.approved` lleva las líneas (`productId`, `quantity` como texto, `unitCostCents`) y `approvedByPolicy`. Detalle en `asyncapi.yaml`.

**Contrato ya listo con inventario (Fase 2.2):** `inventory-service` consume `purchase.purchase_order.received` (`purchaseOrderId`, `organizationId`, `warehouseId`, `lines[{productId, quantity, unitCostCents, currencyCode}]`) y registra la entrada con su costo; la contabilidad NO asienta esa entrada (`purchase_in` se ignora allí): la asentará la factura de compra contra proveedores, para no duplicar el inventario.

## Verificación

- 89 pruebas: dominio (dinero, estados, proveedor), casos de uso con repos en memoria (incluidos aislamiento, concurrencia por versión y fallos a mitad), HTTP (permisos por ruta, validación 422 con campo, 404 entre organizaciones, 502) y guardianes de persistencia/auditoría.
- `scripts/verify-purchasing.mjs` contra **MySQL real y los catálogos reales** (product, tax e inventory del stack): orden con importes exactos, aprobación con otra persona, dos aprobaciones simultáneas (una gana, otra 409), 30 envíos simultáneos con números seguidos, 4 ediciones simultáneas, cancelación con permisos, aislamiento entre organizaciones, listado con filtros.
- En el navegador (CRM completo por el gateway): proveedores, nueva orden con producto buscado en el servidor, totales idénticos a los del servidor, envío («aprobada por política») y detalle.

## Límites conocidos / siguiente

- Sin recepción de mercadería, factura de compra, retención en la compra ni asiento contable: es la Fase 2.2–2.4.
- Sin solicitudes de compra ni comparación de cotizaciones (`purchasing.requests`, `purchasing.quote_comparison`): son pasos opcionales previos a la orden.
- La política de aprobación es un solo umbral por organización; reglas por proveedor, categoría o centro de costo llegan con el `workflow-service`.
- Moneda: solo se probó USD; el modelo ya lleva `currency_code`.
