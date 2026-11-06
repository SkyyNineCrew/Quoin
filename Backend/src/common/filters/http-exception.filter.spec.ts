import { ArgumentsHost, BadRequestException, HttpStatus } from '@nestjs/common';
import { HttpExceptionFilter } from './http-exception.filter';
import { ApiErrorCode, NotFoundError } from '../exceptions/api-error.exception';

function createHost(request: Record<string, unknown>) {
  const json = jest.fn();
  const status = jest.fn().mockReturnValue({ json });
  const host = {
    switchToHttp: () => ({
      getRequest: () => request,
      getResponse: () => ({ status }),
    }),
  } as unknown as ArgumentsHost;

  return { host, status, json };
}

function bodyOf(json: jest.Mock) {
  return json.mock.calls[0][0];
}

describe('HttpExceptionFilter', () => {
  it('reuses the correlation id assigned by CorrelationMiddleware', () => {
    const { host, json } = createHost({
      url: '/api/orders/42',
      correlationId: 'req-abc-123',
      headers: {},
    });

    new HttpExceptionFilter().catch(new BadRequestException('bad input'), host);

    const body = bodyOf(json);
    expect(body.success).toBe(false);
    expect(body.statusCode).toBe(HttpStatus.BAD_REQUEST);
    expect(body.errorCode).toBe(ApiErrorCode.VALIDATION_ERROR);
    expect(body.message).toBe('bad input');
    expect(body.correlationId).toBe('req-abc-123');
    expect(body.path).toBe('/api/orders/42');
  });

  it('falls back to the x-request-id header when middleware did not run', () => {
    const { host, json } = createHost({
      url: '/api/orders/42',
      headers: { 'x-request-id': 'header-id-456' },
    });

    new HttpExceptionFilter().catch(new BadRequestException('bad input'), host);

    expect(bodyOf(json).correlationId).toBe('header-id-456');
  });

  it('generates a correlation id when the request has none', () => {
    const { host, json } = createHost({ url: '/health', headers: {} });

    new HttpExceptionFilter().catch(new Error('boom'), host);

    const body = bodyOf(json);
    expect(body.statusCode).toBe(HttpStatus.INTERNAL_SERVER_ERROR);
    expect(typeof body.correlationId).toBe('string');
    expect(body.correlationId.length).toBeGreaterThan(0);
  });

  it('keeps an ApiError correlation id when the caller supplied one', () => {
    const { host, json } = createHost({
      url: '/api/orders/42',
      correlationId: 'request-id',
      headers: {},
    });

    const error = new NotFoundError('missing');
    Object.defineProperty(error, 'correlationId', {
      value: 'domain-id-789',
    });

    new HttpExceptionFilter().catch(error, host);

    expect(bodyOf(json).correlationId).toBe('domain-id-789');
  });

  it('joins validation messages and exposes them as details', () => {
    const { host, json } = createHost({ url: '/api/users', headers: {} });

    new HttpExceptionFilter().catch(
      new BadRequestException({
        message: ['email must be an email', 'age must be an integer'],
        statusCode: 400,
        error: 'Bad Request',
      }),
      host,
    );

    const body = bodyOf(json);
    expect(body.message).toBe('email must be an email; age must be an integer');
    expect(body.details).toEqual([
      'email must be an email',
      'age must be an integer',
    ]);
  });
});
