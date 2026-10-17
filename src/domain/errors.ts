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
