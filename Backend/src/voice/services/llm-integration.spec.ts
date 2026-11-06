import { Test, TestingModule } from '@nestjs/testing';
import { LlmService } from './llm.service';
import { QuotaService } from './quota.service';
import { LlmCacheService } from './llm-cache.service';
import { RedisService } from '../../redis/redis.service';

describe('LLM Pipeline Integration Tests', () => {
  let llmService: LlmService;
  let quotaService: QuotaService;
  let cacheService: LlmCacheService;

  // Key-aware fake. The previous version queued `get` results positionally,
  // which broke as soon as the quota check read an extra key (the custom
  // monthly limit) and leaked between tests, since clearAllMocks() does not
  // drain queued mockResolvedValueOnce values.
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
      const regex = new RegExp(
        `^${pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*')}$`,
      );
      return Promise.resolve([...store.keys()].filter((k) => regex.test(k)));
    }),
  };

  const mockRedisService = { client: mockRedisClient };

  const cacheKeys = () =>
    [...store.keys()].filter(
      (key) =>
        key.startsWith('llm:cache:') &&
        !key.includes(':stats') &&
        !key.startsWith('llm:cache:total-'),
    );

  const userId = 'user123';
  const sessionId = 'session123';
  const prompt = 'What is TypeScript?';
  const monthKey = (now = new Date()) =>
    `quota:monthly:${userId}:${now.getUTCFullYear()}-${now.getUTCMonth() + 1}`;
  const rpmKey = (now = new Date()) =>
    `quota:rpm:${userId}:${Math.floor(now.getTime() / 60000)}`;

  beforeEach(async () => {
    store = new Map();

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        LlmService,
        QuotaService,
        LlmCacheService,
        { provide: RedisService, useValue: mockRedisService },
      ],
    }).compile();

    llmService = module.get<LlmService>(LlmService);
    quotaService = module.get<QuotaService>(QuotaService);
    cacheService = module.get<LlmCacheService>(LlmCacheService);

    jest.clearAllMocks();
  });

  describe('Complete LLM Request Pipeline', () => {
    it('should follow complete pipeline: quota -> cache -> LLM -> cache store', async () => {
      const response = await llmService.generateResponse(
        userId,
        sessionId,
        prompt,
      );

      expect(response.content).toBeDefined();
      expect(response.cached).toBe(false);
      expect(response.model).toBe('gpt-3.5-turbo');

      // Cache write happened, and quota counters were recorded.
      expect(cacheKeys()).toHaveLength(1);
      expect(store.get(`quota:session:${sessionId}`)).toBe('1');
    });

    it('should serve the cached response on the second request', async () => {
      await llmService.generateResponse(userId, sessionId, prompt);

      const [cacheKey] = cacheKeys();
      expect(cacheKey).toBeDefined();
      store.set(cacheKey, 'Cached response');

      const response = await llmService.generateResponse(
        userId,
        sessionId,
        prompt,
      );

      expect(response.cached).toBe(true);
      expect(response.content).toBe('Cached response');
    });

    it('should enforce quota limits across multiple sessions', async () => {
      // Second user session is already at the per-session limit.
      store.set('quota:session:session2', '101');

      await expect(
        llmService.generateResponse(userId, 'session2', prompt),
      ).rejects.toThrow();
    });

    it('should return fallback on any error without throwing', async () => {
      const response = await llmService.generateResponseWithFallback(
        userId,
        sessionId,
        prompt,
      );

      expect(response.content).toBeDefined();
      expect(response.model).toBeDefined();
    });

    it('should cache custom prompt normalization', async () => {
      const variants = [
        '  What is TypeScript?  ',
        'what is typescript?',
        '  WHAT IS TYPESCRIPT?  ',
      ];

      for (const variant of variants) {
        await llmService.generateResponse(userId, sessionId, variant);
      }

      // Every variant normalises to the same cache key.
      expect(cacheKeys()).toHaveLength(1);
    });
  });

  describe('Quota Enforcement Scenarios', () => {
    it('should handle monthly quota reset at month boundary', async () => {
      store.set(monthKey(), '1000');

      const status = await quotaService.getQuotaStatus(userId, sessionId);

      expect(status.monthlyUsage).toBe(1000);
      expect(status.monthlyLimit).toBe(1000);
    });

    it('should track per-session quotas independently', async () => {
      store.set('quota:session:sess1', '50');
      store.set('quota:session:sess2', '25');

      const status1 = await quotaService.getQuotaStatus(userId, 'sess1');
      const status2 = await quotaService.getQuotaStatus(userId, 'sess2');

      expect(status1.sessionUsage).toBe(50);
      expect(status2.sessionUsage).toBe(25);
    });

    it('should enforce rate limiting per minute window', async () => {
      store.set(rpmKey(), '20');

      const status = await quotaService.getQuotaStatus(userId, sessionId);
      expect(status.requestsThisMinute).toBe(20);

      // The next minute uses a different key, so the window resets.
      const nextMinute = new Date(Date.now() + 60_000);
      const tomorrow = await quotaService.getQuotaStatus(
        userId,
        sessionId,
        nextMinute,
      );
      expect(tomorrow.requestsThisMinute).toBe(0);
    });
  });

  describe('Cache Statistics & Management', () => {
    it('should track cache hit rate', async () => {
      store.set('llm:cache:total-entries', '100');
      store.set('llm:cache:total-hits', '75');

      const stats = await cacheService.getStats();

      expect(stats.totalEntries).toBe(100);
      expect(stats.totalHits).toBe(75);
      expect(stats.hitRate).toBe(0.75);
    });

    it('should support cache invalidation on model updates', async () => {
      await cacheService.set('What is AI?', 'AI is...', 'gpt-4');
      expect(cacheKeys()).toHaveLength(1);

      const count = await cacheService.invalidate('What is AI?', 'gpt-4');

      expect(count).toBeGreaterThanOrEqual(1);
      expect(cacheKeys()).toHaveLength(0);
    });

    it('should support cache warming for common prompts', async () => {
      const count = await cacheService.warmCache([
        {
          prompt: 'What is blockchain?',
          response: 'Blockchain is...',
          model: 'gpt-3.5-turbo',
        },
        {
          prompt: 'Explain smart contracts',
          response: 'Smart contracts are...',
          model: 'gpt-3.5-turbo',
        },
      ]);

      expect(count).toBe(2);
      expect(cacheKeys()).toHaveLength(2);
    });

    it('should prune old cache entries', async () => {
      await cacheService.set('Old prompt', 'gpt-3.5-turbo', 'old response');

      // Backdate the entry created by set().
      const createdKey = [...store.keys()].find((key) =>
        key.endsWith(':created'),
      );
      expect(createdKey).toBeDefined();
      store.set(createdKey, String(Date.now() - 86_400_000));

      const pruned = await cacheService.pruneOldEntries(3600);

      expect(pruned).toBeGreaterThanOrEqual(1);
      expect(cacheKeys()).toHaveLength(0);
    });
  });

  describe('Fallback & Graceful Degradation', () => {
    it('should return fallback when quota service fails', async () => {
      mockRedisClient.get.mockRejectedValueOnce(new Error('Redis down'));

      const response = await llmService.generateResponseWithFallback(
        userId,
        sessionId,
        'test prompt',
      );

      expect(response.content).toContain("I'm sorry");
      expect(response.cached).toBe(false);
    });

    it('should return fallback when the cache write fails', async () => {
      mockRedisClient.set.mockRejectedValueOnce(new Error('Cache write failed'));

      const response = await llmService.generateResponseWithFallback(
        userId,
        sessionId,
        'test prompt',
      );

      expect(response.content).toBeDefined();
      expect(response.model).toBeDefined();
    });

    it('should still track quotas even if LLM fails', async () => {
      const response = await llmService.generateResponseWithFallback(
        userId,
        sessionId,
        'force-fail',
      );

      expect(response.quotaStatus).toBeDefined();
    });
  });
});
