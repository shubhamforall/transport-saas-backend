import type { ErrorRequestHandler, RequestHandler } from 'express';
import { ZodError } from 'zod';
import { AppError, type FieldErrors } from '../utils/app-error.js';
import { logger } from '../utils/logger.js';

export interface ErrorBody {
  error: {
    code: string;
    message: string;
    fieldErrors?: FieldErrors;
    requestId: string;
  };
}

export const notFoundHandler: RequestHandler = (req, _res, next) => {
  next(AppError.notFound(`Route ${req.method} ${req.path} not found`));
};

function zodToFieldErrors(error: ZodError): FieldErrors {
  const out: FieldErrors = {};
  for (const issue of error.issues) {
    const key = issue.path.join('.') || '_';
    (out[key] ??= []).push(issue.message);
  }
  return out;
}

/** Central error handler. Never sends stack traces or internal details to clients. */
export const errorHandler: ErrorRequestHandler = (err, req, res, _next) => {
  let appError: AppError;

  if (err instanceof AppError) {
    appError = err;
  } else if (err instanceof ZodError) {
    appError = AppError.badRequest('Validation failed', zodToFieldErrors(err));
  } else if (err?.type === 'entity.parse.failed') {
    appError = AppError.badRequest('Malformed JSON body');
  } else if (err?.type === 'entity.too.large') {
    appError = new AppError(413, 'PAYLOAD_TOO_LARGE', 'Request body is too large');
  } else {
    logger.error({ err, requestId: req.id }, 'Unhandled error');
    appError = new AppError(500, 'INTERNAL_ERROR', 'Something went wrong. Please try again.');
  }

  const body: ErrorBody = {
    error: {
      code: appError.code,
      message: appError.message,
      ...(appError.fieldErrors ? { fieldErrors: appError.fieldErrors } : {}),
      requestId: String(req.id),
    },
  };
  res.status(appError.status).json(body);
};
