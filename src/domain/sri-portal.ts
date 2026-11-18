import { AppError } from './errors.js';

export class SriPortalAuthError extends AppError {
  readonly code = 'SRI_PORTAL_AUTH_ERROR';
  readonly httpStatus = 401;
  constructor(message = 'No se pudo iniciar sesión en el portal del SRI.') {
    super(message);
  }
}

export class SriPortalCaptchaError extends AppError {
  readonly code = 'SRI_PORTAL_CAPTCHA_ERROR';
  readonly httpStatus = 409;
  constructor(message = 'Se requiere resolver el captcha para consultar en el portal del SRI.') {
    super(message);
  }
}

export class SriPortalNotConfiguredError extends AppError {
  readonly code = 'SRI_PORTAL_NOT_CONFIGURED';
  readonly httpStatus = 400;
  constructor(message = 'El portal del SRI no está configurado para esta organización.') {
    super(message);
  }
}

export class SriPortalDisabledError extends AppError {
  readonly code = 'SRI_PORTAL_DISABLED';
  readonly httpStatus = 400;
  constructor(message = 'La sincronización con el portal del SRI está desactivada.') {
    super(message);
  }
}

export class SriPortalBadCredentialsError extends AppError {
  readonly code = 'SRI_PORTAL_BAD_CREDENTIALS';
  readonly httpStatus = 400;
  constructor(message: string) {
    super(message);
  }
}

export class SriPortalBlockedError extends AppError {
  readonly code = 'SRI_PORTAL_BLOCKED';
  readonly httpStatus = 403;
  constructor(message = 'La sincronización con el portal del SRI está bloqueada por intentos fallidos.') {
    super(message);
  }
}

export interface SriPortalConfig {
  organizationId: string;
  username: string | null;
  hasPassword: boolean;
  enabled: boolean;
  lastRunAt: Date | null;
  lastStatus: string | null;
  lastError: string | null;
  updatedAt: Date;
}

export interface SriPortalCredentials {
  username: string;
  password: string;
}

export interface PortalReportDownload {
  text: string;
  filename: string | null;
}

export interface PortalDocumentFile {
  content: Buffer | string;
  mimeType: string;
  filename: string | null;
}
