import { Test, TestingModule } from '@nestjs/testing';
import { QuotaService } from './quota.service';
import { RedisService } from '../../redis/redis.service';
import { HttpException } from '@nestjs/common';

describe('QuotaService', () => {
  let service: QuotaService;

  // Key-aware fake. The previous spec queued a sequence of `get` results with
  // mockResolvedValueOnce and relied on call order, which silently rotted every
  // time the service added a read — and leaked between tests, because
  // jest.clearAllMocks() does not drain queued "once" implementations.
  let store: Map<string, string>;
  const mockRedisClient = {
    get: jest.fn((key: string) => Promise.resolve(store.get(key) ?? null)),
    set: jest.fn((key: string, value: string) => {
      store.set(key, value);
      return Promise.resolve('OK');
    }),
    incr: jest.fn((key: string) => {
      const next = parseInt(store.get(key) ?? '0', 10) + 1;
      store.set(key, String(next));
      return Promise.resolve(next);
    }),
    expire: jest.fn(() => Promise.resolve(1)),
    del: jest.fn((keys: string | string[]) => {
      const list = Array.isArray(keys) ? keys : [keys];
      list.forEach((key) => store.delete(key));
      return Promise.resolve(list.length);
    }),
    keys: jest.fn((pattern: string) => {
      const prefix = pattern.replace(/\*$/, '');
      return Promise.resolve(
        [...store.keys()].filter((key) => key.startsWith(prefix)),
      );
    }),
  };

  const mockRedisService = {
    client: mockRedisClient,
  };

  const userId = 'user123';
  const sessionId = 'session123';

  const monthKey = (now = new Date()) =>
    `quota:monthly:${userId}:${now.getUTCFullYear()}-${now.getUTCMonth() + 1}`;
  const sessionKey = () => `quota:session:${sessionId}`;
  const rpmKey = (now = new Date()) =>
    `quota:rpm:${userId}:${Math.floor(now.getTime() / 60000)}`;

  beforeEach(async () => {
    store = new Map();

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        QuotaService,
        {
          provide: RedisService,
          useValue: mockRedisService,
        },
      ],
    }).compile();

    service = module.get<QuotaService>(QuotaService);
    jest.clearAllMocks();
  });

  describe('enforceQuota', () => {
    it('should allow request when within all quotas', async () => {
      const status = await service.enforceQuota(userId, sessionId);

      expect(status.monthlyUsage).toBe(0);
      expect(status.monthlyLimit).toBe(1000);
      expect(status.requestsPerMinuteLimit).toBe(20);
      // Enforcement is read-only; usage is recorded separately.
      expect(mockRedisClient.incr).not.toHaveBeenCalled();
    });

    it('should throw when monthly quota exceeded', async () => {
      store.set(monthKey(), '1000');

      await expect(service.enforceQuota(userId, sessionId)).rejects.toThrow(
        HttpException,
      );
    });

    it('should honour a custom monthly quota', async () => {
      store.set(`${monthKey().replace(/:\d+-\d+$/, '')}:limit`, '3');
      store.set(monthKey(), '3');

      await expect(service.enforceQuota(userId, sessionId)).rejects.toThrow(
        /Monthly LLM quota exceeded \(3\/3\)/,
      );
    });

    it('should throw when session quota exceeded', async () => {
      store.set(sessionKey(), '100');

      await expect(service.enforceQuota(userId, sessionId)).rejects.toThrow(
        /Session LLM quota exceeded/,
      );
    });

    it('should throw when rate limit exceeded', async () => {
      store.set(rpmKey(), '20');

      await expect(service.enforceQuota(userId, sessionId)).rejects.toThrow(
        /Rate limit exceeded/,
      );
    });
  });

  describe('getQuotaStatus', () => {
    it('should return current quota status', async () => {
      store.set(monthKey(), '50');
      store.set(sessionKey(), '25');
      store.set(rpmKey(), '10');

      const status = await service.getQuotaStatus(userId, sessionId);

      expect(status.monthlyUsage).toBe(50);
      expect(status.monthlyLimit).toBe(1000);
      expect(status.sessionUsage).toBe(25);
      expect(status.sessionLimit).toBe(100);
      expect(status.requestsThisMinute).toBe(10);
    });

    it('should handle missing values as zero', async () => {
      const status = await service.getQuotaStatus(userId, sessionId);

      expect(status.monthlyUsage).toBe(0);
      expect(status.sessionUsage).toBe(0);
      expect(status.requestsThisMinute).toBe(0);
    });
  });

  describe('recordRequest', () => {
    it('should increment all quota counters', async () => {
      await service.recordRequest(userId, sessionId);

      expect(mockRedisClient.incr).toHaveBeenCalledTimes(3);
      expect(store.get(monthKey())).toBe('1');
      expect(store.get(sessionKey())).toBe('1');
      expect(store.get(rpmKey())).toBe('1');
    });

    it('should set the expiry on first increment only', async () => {
      await service.recordRequest(userId, sessionId);

      expect(mockRedisClient.expire).toHaveBeenCalledTimes(3);
      expect(mockRedisClient.expire).toHaveBeenCalledWith(
        monthKey(),
        expect.any(Number),
      );
      expect(mockRedisClient.expire).toHaveBeenCalledWith(sessionKey(), 604800);
      expect(mockRedisClient.expire).toHaveBeenCalledWith(rpmKey(), 60);

      jest.clearAllMocks();
      await service.recordRequest(userId, sessionId);

      // Counters already exist, so no further expiry writes are needed.
      expect(mockRedisClient.expire).not.toHaveBeenCalled();
    });

    it('should not throw when Redis fails', async () => {
      mockRedisClient.incr.mockRejectedValueOnce(new Error('redis down'));

      await expect(
        service.recordRequest(userId, sessionId),
      ).resolves.toBeUndefined();
    });
  });

  describe('resetUserQuota', () => {
    it('should delete all user quota keys', async () => {
      store.set(monthKey(), '10');

      await service.resetUserQuota(userId);

      expect(mockRedisClient.keys).toHaveBeenCalledWith(
        `quota:monthly:${userId}:*`,
      );
      expect(mockRedisClient.del).toHaveBeenCalledWith([monthKey()]);
      expect(store.has(monthKey())).toBe(false);
    });

    it('should handle when no keys exist', async () => {
      await service.resetUserQuota(userId);

      expect(mockRedisClient.del).not.toHaveBeenCalled();
    });
  });

  describe('setUserMonthlyQuota', () => {
    it('should set custom monthly quota', async () => {
      await service.setUserMonthlyQuota(userId, 500);

      expect(mockRedisClient.set).toHaveBeenCalledWith(
        `quota:monthly:${userId}:limit`,
        '500',
        { EX: expect.any(Number) },
      );
    });
  });

  describe('getUserMonthlyQuota', () => {
    it('should return custom quota if set', async () => {
      store.set(`quota:monthly:${userId}:limit`, '500');

      await expect(service.getUserMonthlyQuota(userId)).resolves.toBe(500);
    });

    it('should return default quota if not set', async () => {
      await expect(service.getUserMonthlyQuota(userId)).resolves.toBe(1000);
    });
  });

  describe('resetSessionQuota', () => {
    it('should delete session quota key', async () => {
      store.set(sessionKey(), '4');

      await service.resetSessionQuota(sessionId);

      expect(mockRedisClient.del).toHaveBeenCalledWith(sessionKey());
      expect(store.has(sessionKey())).toBe(false);
    });
  });
});
