import { Test, TestingModule } from '@nestjs/testing';
import { InternalServerErrorException } from '@nestjs/common';
import { RateLimitService } from './rate-limit.service';
import { RedisService } from '../../redis/redis.service';

describe('RateLimitService', () => {
  let service: RateLimitService;
  let redisService: { evalScript: jest.Mock };

  beforeEach(async () => {
    redisService = { evalScript: jest.fn() };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        RateLimitService,
        { provide: RedisService, useValue: redisService },
      ],
    }).compile();

    service = module.get(RateLimitService);
  });

  it('allows a request inside the limit and reports what is left', async () => {
    redisService.evalScript.mockResolvedValue([1, 4, 60]);

    const result = await service.checkRateLimit('1.2.3.4', '/auth/nonce');

    expect(result.allowed).toBe(true);
    expect(result.remaining).toBe(4);
    expect(result.resetAt.getTime()).toBeGreaterThan(Date.now());

    const [script, keys, args] = redisService.evalScript.mock.calls[0];
    expect(script).toContain('redis.call');
    expect(keys).toEqual(['rate_limit:/auth/nonce:1.2.3.4']);
    expect(args).toEqual(['5', '60']);
  });

  it('honours a custom limit and window', async () => {
    redisService.evalScript.mockResolvedValue([1, 0, 30]);

    await service.checkRateLimit('1.2.3.4', '/voice/tts', 1, 30);

    expect(redisService.evalScript.mock.calls[0][2]).toEqual(['1', '30']);
  });

  it('blocks when the script reports the limit as reached', async () => {
    redisService.evalScript.mockResolvedValue([0, 0, 12]);

    const result = await service.checkRateLimit('1.2.3.4', '/auth/login');

    expect(result.allowed).toBe(false);
    expect(result.remaining).toBe(0);
  });

  it('fails closed for sensitive routes when Redis errors', async () => {
    redisService.evalScript.mockRejectedValue(new Error('connection lost'));

    await expect(
      service.checkRateLimit('1.2.3.4', '/auth/login'),
    ).rejects.toThrow(InternalServerErrorException);
  });

  it('fails open for non-sensitive routes when Redis errors', async () => {
    redisService.evalScript.mockRejectedValue(new Error('connection lost'));

    const result = await service.checkRateLimit('1.2.3.4', '/market/news');

    expect(result.allowed).toBe(true);
    expect(result.remaining).toBe(1);
  });
});
