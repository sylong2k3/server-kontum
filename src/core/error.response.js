const { StatusCodes, ReasonPhrases } = require("./http-status-code");
const { t } = require('../utils/i18n.util');

const getLang = () => process.env.APP_LANG || process.env.LANG || 'vi';

class BaseError extends Error {
  constructor(message, status, errors, isOperational) {
    super(message);
    Object.setPrototypeOf(this, new.target.prototype);
    this.status = status;
    this.errors = errors;
    this.isOperational = isOperational;
    Error.captureStackTrace(this, this.constructor);
  }
}

class Api409Error extends BaseError {
  constructor(
    message = ReasonPhrases.CONFLICT,
    errors = [],
    status = StatusCodes.CONFLICT,
    isOperational = true,
  ) {
    super(message, status, errors, isOperational);
  }
}

class Api429Error extends BaseError {
  constructor(
    message = ReasonPhrases.TOO_MANY_REQUESTS,
    errors = [],
    status = StatusCodes.TOO_MANY_REQUESTS,
    isOperational = true,
  ) {
    super(message, status, errors, isOperational);
  }
}

class Api400Error extends BaseError {
  constructor(
    message = ReasonPhrases.BAD_REQUEST,
    errors = [],
    status = StatusCodes.BAD_REQUEST,
    isOperational = true,
  ) {
    super(message, status, errors, isOperational);
  }
}

class Api403Error extends BaseError {
  constructor(
    message = ReasonPhrases.FORBIDDEN,
    errors = [],
    status = StatusCodes.FORBIDDEN,
    isOperational = true,
  ) {
    super(message, status, errors, isOperational);
  }
}

class Api401Error extends BaseError {
  constructor(
    message = ReasonPhrases.UNAUTHORIZED,
    errors = [],
    status = StatusCodes.UNAUTHORIZED,
    isOperational = true,
  ) {
    super(message, status, errors, isOperational);
  }
}

class BusinessLogicError extends BaseError {
  constructor(
    message = ReasonPhrases.INTERNAL_SERVER_ERROR,
    errors = [],
    status = StatusCodes.INTERNAL_SERVER_ERROR,
    isOperational = true,
  ) {
    super(message, status, errors, isOperational);
  }
}

class Api404Error extends BaseError {
  constructor(
    message = ReasonPhrases.NOT_FOUND,
    errors = [],
    status = StatusCodes.NOT_FOUND,
    isOperational = true,
  ) {
    super(message, status, errors, isOperational);
  }
}

class SatelliteError extends BaseError {
  constructor(
    message = t('satellite_processing_error', getLang()),
    errors = [],
    status = StatusCodes.INTERNAL_SERVER_ERROR,
    isOperational = true,
  ) {
    super(message, status, errors, isOperational);
  }
}

class EarthEngineError extends BaseError {
  constructor(
    message = t('earth_engine_error', getLang()),
    errors = [],
    status = StatusCodes.INTERNAL_SERVER_ERROR,
    isOperational = true,
  ) {
    super(message, status, errors, isOperational);
  }
}

class GeometryValidationError extends BaseError {
  constructor(
    message = t('invalid_geometry', getLang()),
    errors = [],
    status = StatusCodes.BAD_REQUEST,
    isOperational = true,
  ) {
    super(message, status, errors, isOperational);
  }
}

class DateRangeValidationError extends BaseError {
  constructor(
    message = t('invalid_date_range', getLang()),
    errors = [],
    status = StatusCodes.BAD_REQUEST,
    isOperational = true,
  ) {
    super(message, status, errors, isOperational);
  }
}

module.exports = {
  Api401Error,
  Api400Error,
  Api403Error,
  Api404Error,
  Api409Error,
  Api429Error,
  BusinessLogicError,
  BaseError,
  SatelliteError,
  EarthEngineError,
  GeometryValidationError,
  DateRangeValidationError,
};
