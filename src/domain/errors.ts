export interface ErrorDetail {
  field: string;
  message: string;
}

export abstract class AppError extends Error {
  abstract readonly code: string;
  abstract readonly httpStatus: number;
  readonly details?: ErrorDetail[];

  constructor(message: string, details?: ErrorDetail[]) {
    super(message);
    this.name = new.target.name;
    this.details = details;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

export class ValidationError extends AppError {
  readonly code = 'VALIDATION_ERROR';
  readonly httpStatus = 422;
  /** El mensaje resume los problemas (así se lee en un log o en una alerta); `details` dice cuál campo falló. */
  constructor(details: ErrorDetail[], message?: string) {
    super(message ?? (details.map((d) => d.message).join(' ') || 'La petición no es válida.'), details);
  }
}

export class OrganizationContextRequiredError extends AppError {
  readonly code = 'ORG_CONTEXT_REQUIRED';
  readonly httpStatus = 401;
  constructor(message = 'Falta el contexto de organización.') { super(message); }
}

export class UserContextRequiredError extends AppError {
  readonly code = 'USER_CONTEXT_REQUIRED';
  readonly httpStatus = 401;
  constructor(message = 'Falta el contexto de usuario.') { super(message); }
}

export class ForbiddenError extends AppError {
  readonly code = 'FORBIDDEN';
  readonly httpStatus = 403;
  constructor(message = 'Permiso insuficiente.') { super(message); }
}

// ── Proveedores ─────────────────────────────────────────────────────────────

export class SupplierNotFoundError extends AppError {
  readonly code = 'SUPPLIER_NOT_FOUND';
  readonly httpStatus = 404;
  constructor(message = 'Proveedor no encontrado.') { super(message); }
}

export class SupplierIdentificationExistsError extends AppError {
  readonly code = 'SUPPLIER_IDENTIFICATION_EXISTS';
  readonly httpStatus = 409;
  constructor(message = 'Ya existe un proveedor con esa identificación.') { super(message); }
}

export class SupplierInactiveError extends AppError {
  readonly code = 'SUPPLIER_INACTIVE';
  readonly httpStatus = 409;
  constructor(message = 'El proveedor está inactivo: no se le pueden hacer pedidos.') { super(message); }
}

// ── Órdenes de compra ───────────────────────────────────────────────────────

export class OrderNotFoundError extends AppError {
  readonly code = 'ORDER_NOT_FOUND';
  readonly httpStatus = 404;
  constructor(message = 'Orden de compra no encontrada.') { super(message); }
}

export class InvalidOrderStateError extends AppError {
  readonly code = 'INVALID_ORDER_STATE';
  readonly httpStatus = 409;
  constructor(message: string) { super(message); }
}

export class ApprovalRequiredError extends AppError {
  readonly code = 'APPROVAL_REQUIRED';
  readonly httpStatus = 409;
  constructor(message = 'La orden necesita aprobación antes de continuar.') { super(message); }
}

/** Quien preparó la orden no la aprueba: separación de funciones. */
export class SelfApprovalError extends AppError {
  readonly code = 'SELF_APPROVAL_NOT_ALLOWED';
  readonly httpStatus = 403;
  constructor(message = 'Quien preparó la orden no puede aprobarla: la aprueba otra persona.') { super(message); }
}

export class CatalogUnavailableError extends AppError {
  readonly code = 'CATALOG_UNAVAILABLE';
  readonly httpStatus = 502;
  constructor(message = 'No se pudo consultar el catálogo de productos o de impuestos. Reintenta en un momento.') { super(message); }
}

export class ConcurrentUpdateError extends AppError {
  readonly code = 'CONCURRENT_UPDATE';
  readonly httpStatus = 409;
  constructor(message = 'Otra persona modificó esto a la vez. Vuelve a cargarlo.') { super(message); }
}

// ── Recepción de mercadería ───────────────────────────────────────────────────

export class OrderNotReceivableError extends AppError {
  readonly code = 'ORDER_NOT_RECEIVABLE';
  readonly httpStatus = 422;
  constructor(message = 'La orden no está en estado que permita recibir mercadería (solo approved o partially_received).') { super(message); }
}

export class OverReceiptError extends AppError {
  readonly code = 'OVER_RECEIPT';
  readonly httpStatus = 422;
  constructor(productName: string, received: string, ordered: string, toleranceBp: number) {
    super(`Sobre-recepción en "${productName}": recibido ${received} supera pedido ${ordered} + tolerancia ${toleranceBp} bp.`);
  }
}

export class LineNotInOrderError extends AppError {
  readonly code = 'LINE_NOT_IN_ORDER';
  readonly httpStatus = 422;
  constructor(message = 'La línea de recepción no pertenece a la orden.') { super(message); }
}

export class DuplicateReceiptLineError extends AppError {
  readonly code = 'DUPLICATE_RECEIPT_LINE';
  readonly httpStatus = 422;
  constructor(message = 'La misma línea de orden no puede recibirse dos veces en una misma recepción.') { super(message); }
}

// ── Factura de compra (conciliación a tres vías) ────────────────────────────────

export class BillNotFoundError extends AppError {
  readonly code = 'BILL_NOT_FOUND';
  readonly httpStatus = 404;
  constructor(message = 'Factura de compra no encontrada.') { super(message); }
}

export class BillNotEditableError extends AppError {
  readonly code = 'BILL_NOT_EDITABLE';
  readonly httpStatus = 409;
  constructor(message = 'Solo los borradores y facturas bloqueadas se pueden editar.') { super(message); }
}

export class BillNotPostableError extends AppError {
  readonly code = 'BILL_NOT_POSTABLE';
  readonly httpStatus = 409;
  constructor(message = 'Solo los borradores se pueden contabilizar.') { super(message); }
}

export class BillAlreadyPostedError extends AppError {
  readonly code = 'BILL_ALREADY_POSTED';
  readonly httpStatus = 409;
  constructor(message = 'La factura ya está contabilizada.') { super(message); }
}

export class BillNotOverridableError extends AppError {
  readonly code = 'BILL_NOT_OVERRIDABLE';
  readonly httpStatus = 409;
  constructor(message = 'Solo facturas bloqueadas se pueden aprobar con excepción.') { super(message); }
}

export class SelfOverrideError extends AppError {
  readonly code = 'SELF_OVERRIDE_NOT_ALLOWED';
  readonly httpStatus = 403;
  constructor(message = 'Quien registró la factura no puede aprobarla con excepción: lo hace otra persona.') { super(message); }
}

export class BillNotVoidableError extends AppError {
  readonly code = 'BILL_NOT_VOIDABLE';
  readonly httpStatus = 409;
  constructor(message = 'Solo facturas contabilizadas o bloqueadas se pueden anular.') { super(message); }
}

export class DuplicateSupplierDocumentError extends AppError {
  readonly code = 'DUPLICATE_SUPPLIER_DOCUMENT';
  readonly httpStatus = 409;
  constructor(message = 'Ya existe una factura con ese documento del proveedor.') { super(message); }
}

export class SupplierRucMismatchError extends AppError {
  readonly code = 'SUPPLIER_RUC_MISMATCH';
  readonly httpStatus = 422;
  constructor(message = 'El RUC del emisor en la clave de acceso no coincide con el proveedor.') { super(message); }
}

export class QtyExceedsReceivedError extends AppError {
  readonly code = 'QTY_EXCEEDS_RECEIVED';
  readonly httpStatus = 422;
  constructor(productName: string, billed: string, received: string, toleranceBp: number) {
    super(`Cantidad facturada en "${productName}" (${billed}) supera lo recibido (${received}) + tolerancia ${toleranceBp} bp.`);
  }
}

export class PriceVarianceError extends AppError {
  readonly code = 'PRICE_VARIANCE';
  readonly httpStatus = 422;
  constructor(productName: string, diffBp: number, toleranceBp: number) {
    super(`Variación de precio en "${productName}" (${diffBp} bp) supera tolerancia ${toleranceBp} bp.`);
  }
}

export class NoReceiptError extends AppError {
  readonly code = 'NO_RECEIPT';
  readonly httpStatus = 422;
  constructor(productName: string) {
    super(`Línea "${productName}" sin recepción previa.`);
  }
}

export class TotalsMismatchError extends AppError {
  readonly code = 'TOTALS_MISMATCH';
  readonly httpStatus = 422;
  constructor(supplierTotal: number, computedTotal: number) {
    super(`Total del proveedor (${supplierTotal}) difiere del calculado (${computedTotal}) en más de 1 céntimo.`);
  }
}

export class CurrencyMismatchError extends AppError {
  readonly code = 'CURRENCY_MISMATCH';
  readonly httpStatus = 422;
  constructor(message = 'Moneda de la factura distinta a la moneda base de la organización.') { super(message); }
}

// ── Retención en la compra (E.1) ────────────────────────────────────────────────

export class WithholdingAlreadyIssuedError extends AppError {
  readonly code = 'WITHHOLDING_ALREADY_ISSUED';
  readonly httpStatus = 409;
  constructor(message = 'Esta factura ya tiene una retención emitida.') { super(message); }
}

export class BillNotPostedError extends AppError {
  readonly code = 'BILL_NOT_POSTED';
  readonly httpStatus = 409;
  constructor(message = 'Solo facturas contabilizadas (posted) pueden tener retención.') { super(message); }
}

export class FiscalServiceUnavailableError extends AppError {
  readonly code = 'FISCAL_SERVICE_UNAVAILABLE';
  readonly httpStatus = 502;
  constructor(message = 'El servicio fiscal no responde. Reintenta en un momento.') { super(message); }
}
