# purchasing-service — Compras

Servicio de compras del plan ERP (Fase 2, ver `PLAN-ERP.md`). **Fases 2.1 y 2.2 construidas y verificadas en local, sin commitear y sin desplegar:** proveedores y órdenes de compra con aprobación, recepción de mercadería contra orden aprobada y factura de compra con conciliación a tres vías. La **retención** en la compra y su **asiento** contable están construidos, pero el dueño **no autorizó subirlos**; la **liquidación de compra (03)** no se hizo porque falta el XSD oficial del SRI.

- Puerto 3017 · base `purchasing_db` · rama `main` · repo `facturero/purchasing-service` (por crear).
- Plugins: `inventory.suppliers` (proveedores) y `purchasing.purchase_orders` (órdenes, recepciones, facturas y política de aprobación). El gateway exige el plugin de cada ruta.
- Hono + Sequelize + MySQL, Clean Architecture, outbox con `@facturero/outbox-relay` (publica; todavía no consume nada).

## Qué hace

| Recurso | Rutas (`/purchasing/…`) | Permiso |
|---|---|---|
| Proveedores | `GET/POST suppliers`, `GET/PUT suppliers/:id`, `POST suppliers/:id/(de)activate` | `supplier:read` / `supplier:manage` |
| Órdenes | `GET/POST orders`, `GET/PUT orders/:id` (solo borrador), `POST orders/:id/submit` | `purchase:read` / `purchase:create` |
| Decisión | `POST orders/:id/approve`, `POST orders/:id/reject` | `purchase:approve` |
| Cancelar / cerrar | `POST orders/:id/cancel` (lo aprobado exige además `purchase:cancel`), `POST orders/:id/reopen` (rechazada → borrador), `POST orders/:id/close` (da por terminado lo pendiente, con motivo) | `purchase:create` / `purchase:close` |
| Recepciones | `GET receipts`, `GET receipts/:id`, `POST orders/:id/receipts`, `GET orders/:id/receiving` (pedido/recibido/pendiente/facturado por línea) | `purchase:read` / `receipt:create` |
| Facturas de compra | `GET/POST bills`, `GET/PUT bills/:id`, `POST bills/:id/post\|override\|void`, `POST bills/:id/withholding` | `purchase_bill:read\|create\|update\|post\|override\|void` |
| Política | `GET/PUT settings` (umbral de aprobación, bodega por defecto y tolerancias en puntos básicos) | `purchase:read` / `purchase:approve` |

Ciclo de la orden: `draft → pending_approval → approved → partially_received → received → closed`; `rejected` vuelve a borrador; `cancelled` es final. Recibir no cambia el estado hasta cubrir todas las líneas con producto; el cierre manual (`close`, con motivo) da por terminado lo que el proveedor ya no enviará.

Ciclo de la factura: `draft → posted` | `blocked` (no cuadró la conciliación) `→ posted` por override `| → draft` (corregir) ; `posted → voided` (con motivo). `posted` y `voided` son inmutables. Una factura sin orden queda `not_applicable` y exige `purchase_bill:create_unmatched`.

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
10. **Una recepción es inmutable** (no se edita ni se borra): un error se corrige con un ajuste de inventario o, en la Fase 5, con una devolución a proveedor. Solo se recibe contra una orden `approved` o `partially_received`, y el **costo de la entrada es el de la línea de la orden** —no se escribe otro—: el costo real lo fija la factura y la diferencia aparece como `PRICE_VARIANCE`. Numeración `RM-AAAA-NNNNNN` con su propio contador. El inventario recibe **por evento** (asíncrono, outbox + inbox idempotente): la recepción no espera a inventario.
11. **La tolerancia de sobre-recepción se mide sobre lo PEDIDO y es acumulada:** `recibido + esta ≤ pedido + pedido × over_receipt_tolerance_bp / 10000`, con error `OVER_RECEIPT` nombrando el producto. Se bloquea la orden (`SELECT … FOR UPDATE`) y se recalcula dentro de la transacción: dos recepciones simultáneas no pueden pasarse del límite (probado con MySQL real).
12. **Facturación acumulada, no por factura:** lo facturado de una línea de la orden es la suma de sus líneas en facturas **contabilizadas o bloqueadas** (`billedByOrderLine(orgId, orderId, excludeBillId?)`, que al editar excluye la propia). Así dos facturas parciales no facturan de más entre ellas.
13. **Conciliación a tres vías por línea**, con la lista de razones guardada en la factura: `LINE_NOT_IN_ORDER` (la línea no es de la orden), `QTY_EXCEEDS_RECEIVED` (facturado > recibido + `qty_tolerance_bp`), `NO_RECEIPT` (hay factura y recibido 0) y `PRICE_VARIANCE` (`|costo factura − costo orden| > costo orden × price_tolerance_bp / 10000`, guarda la diferencia en centavos). Cualquier razón deja la factura `blocked`.
14. **Los totales de la factura los calcula el servidor** con las reglas de `money.ts` (IVA por línea, redondeo a la mitad hacia arriba). Si el cliente manda el total impreso del proveedor, se **compara**: más de 1 céntimo de diferencia → `TOTALS_MISMATCH` con ambas cifras. Se guardan los dos: lo calculado y lo que dice la factura (`supplier_total_cents`).
15. **Separación de funciones también en la factura:** quien la registró no puede desbloquear la suya (`SELF_OVERRIDE_NOT_ALLOWED`); el override exige `purchase_bill:override` y **otra** persona. El documento del proveedor es único por (organización, proveedor, tipo, establecimiento, punto, secuencial) y por autorización cuando existe (`DUPLICATE_SUPPLIER_DOCUMENT` → 409).
16. **Tolerancias ajustables por el administrador.** `over_receipt_tolerance_bp`, `price_tolerance_bp` y `qty_tolerance_bp` son enteros 0–5000 (puntos básicos, `100 = 1 %`) con defecto 0 (estricto); se cambian con un `PUT /purchasing/settings` **parcial** y permiso `purchase:approve`. La UI las pide directamente en bp y lo dice.
17. **Motivos con mínimo:** rechazar o cancelar una orden, 3 caracteres; desbloquear o anular una factura y cerrar una orden, 5.
18. **Editar una factura:** el servidor acepta `draft` **y** `blocked` (editar es la forma de corregir lo que la bloqueó); cualquier otro estado es inmutable salvo anular. `billActions(bill, can, userId)` decide qué botones ve cada quien, y el servidor vuelve a comprobarlo.

## Lo que el contrato admite pero NO persiste (a propósito)

- La factura de compra acepta `notes` en la entrada (`BillInput`) y el caso de uso lo arma, pero **no hay columna ni campo en el dominio**: se descarta. Por eso el esquema de salida `Bill` no lo publica y la UI no lo ofrece (ofrecer un campo que el servidor tira sería pérdida de datos silenciosa). Si el dueño lo quiere, hace falta una migración nueva.

## Eventos

Publica (outbox → `crm.events`): `purchasing.supplier.upserted`; `purchasing.order.created|updated|submitted|approved|rejected|cancelled|reopened|received|closed`; `purchasing.receipt.posted`; `purchasing.bill.created|updated|posted|blocked|overridden|voided|withholding_issued`; `purchasing.settings.updated`. Todos llevan `organizationId` y el actor (la bitácora los recoge por el comodín). `purchasing.order.approved` lleva las líneas (`productId`, `quantity` como texto, `unitCostCents`) y `approvedByPolicy`. `purchasing.order.partially_received` **no** existe: el estado parcial se ve en `purchasing.receipt.posted`. Detalle en `asyncapi.yaml`.

**Contrato con inventario:** `inventory-service` consume `purchase.purchase_order.received` (`purchaseOrderId`, `organizationId`, `warehouseId`, `receiptId`, `receiptNumber`, `lines[{productId, quantity, unitCostCents, currencyCode}]`) y registra la entrada con su costo, con `referenceType: 'goods_receipt'` y `referenceId: receiptId` (`receiptId`/`receiptNumber` son campos nuevos; sin ellos, el comportamiento anterior con `purchase_order` sigue igual). La contabilidad **no** asienta esa entrada (`purchase_in` se ignora allí): la asienta la factura de compra contra proveedores, para no duplicar el inventario. Una recepción deja **dos** entradas en la bitácora (el evento del contrato y el propio): están etiquetadas distinto para que se entienda.

**Retención y asiento (construidos, sin autorización de subida):** `POST bills/:id/withholding` emite la retención sobre una factura contabilizada y publica `purchasing.bill.withholding_issued`; el asiento de la compra y el de la retención los consume `accounting-service`.

## Verificación

- **138 pruebas** (7 archivos): dominio (dinero, estados, proveedor, conciliación a tres vías, retención), casos de uso con repos en memoria (incluidos aislamiento, concurrencia por versión, facturación acumulada entre facturas y fallos a mitad sin dejar basura), HTTP (permisos por ruta, validación 422 con campo, 404 entre organizaciones, 502) y guardianes de persistencia/auditoría.
- `scripts/verify-receiving-billing.mjs` contra **MySQL real, RabbitMQ y los catálogos reales** del stack Docker: cantidad recibida en el evento, delta de stock en inventario, totales de la recepción contabilizada, **rechazo de la sobre-recepción**, dos recepciones simultáneas (no se pasa del límite), conciliación de la factura, asiento contable y eventos en la bitácora. Este script **sustituye** a los antiguos `verify-receiving.mjs` y `verify-bills.mjs`.
- `scripts/verify-purchasing.mjs` (Fase 2.1) contra **MySQL real y los catálogos reales**: orden con importes exactos, aprobación con otra persona, dos aprobaciones simultáneas (una gana, otra 409), 30 envíos simultáneos con números seguidos, 4 ediciones simultáneas, cancelación con permisos, aislamiento entre organizaciones, listado con filtros.
- En el navegador (CRM completo por el gateway): proveedores, nueva orden con producto buscado en el servidor, totales idénticos a los del servidor, envío y detalle; seguimiento por línea, recepción y factura con su panel de conciliación.
- `seed/steps/purchasing.ts` (semilla, por la API del gateway) siembra proveedor → orden aprobada → recepción parcial → factura contabilizada, y es idempotente: de la segunda corrida en adelante salta cada etapa.

## Límites conocidos / siguiente

- **Sin autorización para subir:** la retención en la compra y los asientos de compra/retención (construidos y probados, se quedan en el árbol hasta que el dueño diga).
- **Sin liquidación de compra (03):** falta el XSD oficial del SRI; sin él no se valida el XML y no se inventa.
- **La factura de compra no persiste `notes`** (ver arriba): si se quiere, va con migración nueva.
- Sin importación del XML de la factura del proveedor (hoy se teclea); sin solicitudes de compra ni comparación de cotizaciones (`purchasing.requests`, `purchasing.quote_comparison`): son pasos opcionales previos a la orden.
- Sin devolución a proveedor ni anulación de recepción (Fase 5); la recepción es inmutable a propósito.
- Una factura cubre **una** orden (varias órdenes por factura queda pendiente).
- La política de aprobación es un solo umbral por organización; reglas por proveedor, categoría o centro de costo llegan con el `workflow-service`.
- Moneda distinta a la base → `CURRENCY_MISMATCH` (pendiente en contabilidad); solo se probó USD.
