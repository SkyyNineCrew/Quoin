import { Test, TestingModule } from '@nestjs/testing';
import { PresenceService } from './presence.service';
import { RedisService } from '../redis/redis.service';

describe('PresenceService', () => {
  let service: PresenceService;
  let redisService: RedisService;
  let moduleRef: TestingModule;

  beforeEach(async () => {
    moduleRef = await Test.createTestingModule({
      providers: [
        PresenceService,
        {
          provide: RedisService,
          useValue: {
            evalScript: jest.fn(),
            scanKeys: jest.fn().mockResolvedValue([]),
            client: {
              sAdd: jest.fn(),
              sRem: jest.fn(),
              sCard: jest.fn(),
              del: jest.fn(),
              sMembers: jest.fn(),
              expire: jest.fn(),
              multi: jest.fn(),
              set: jest.fn(),
              get: jest.fn(),
              incr: jest.fn(),
            },
          },
        },
      ],
    }).compile();

    redisService = moduleRef.get(RedisService);
    service = moduleRef.get(PresenceService);
  });

  afterEach(async () => {
    await moduleRef.close();
  });

  describe('userConnected', () => {
    it('registers socket, presence, version and heartbeat in one script', async () => {
      const client = redisService.client as any;
      const evalScript = redisService.evalScript as jest.Mock;
      evalScript.mockResolvedValue(1);
      client.set.mockResolvedValue('OK');

      const version = await service.userConnected('user-1', 'socket-1', 'corr-1');

      expect(evalScript).toHaveBeenCalledTimes(1);
      const [script, keys, args] = evalScript.mock.calls[0];
      expect(script).toContain('SADD');
      expect(keys).toEqual([
        'user:user-1:sockets',
        'presence:online',
        'user:user-1:version',
        'user:user-1:heartbeat',
      ]);
      // socketId, presence TTL, heartbeat TTL, userId, timestamp
      expect(args.slice(0, 4)).toEqual(['socket-1', 300, 120, 'user-1']);
      expect(typeof args[4]).toBe('string');

      // Per-socket heartbeat key, used by orphan detection.
      expect(client.set).toHaveBeenCalledWith(
        'socket:socket-1:lastSeen',
        expect.any(String),
        { EX: 180 },
      );
      expect(version).toBe(1);
    });

    it('should increment version on subsequent connections', async () => {
      const evalScript = redisService.evalScript as jest.Mock;
      evalScript.mockResolvedValueOnce(1).mockResolvedValueOnce(2);

      await expect(service.userConnected('user-1', 'socket-1')).resolves.toBe(1);
      await expect(service.userConnected('user-1', 'socket-2')).resolves.toBe(2);

      expect(evalScript).toHaveBeenCalledTimes(2);
    });
  });

  describe('userDisconnected', () => {
    it('should fully clean up user when no sockets remain', async () => {
      const client = redisService.client as any;
      const evalScript = redisService.evalScript as jest.Mock;
      evalScript.mockResolvedValue(1);

      await expect(
        service.userDisconnected('user-1', 'socket-1', 'corr-1'),
      ).resolves.toBe(true);

      // Per-socket heartbeat is dropped before the script runs.
      expect(client.del).toHaveBeenCalledWith('socket:socket-1:lastSeen');

      const [script, keys, args] = evalScript.mock.calls[0];
      expect(script).toContain('SCARD');
      expect(keys).toEqual([
        'user:user-1:sockets',
        'presence:online',
        'user:user-1:version',
        'user:user-1:heartbeat',
        'user:user-1:rooms',
        'user-1',
      ]);
      expect(args).toEqual(['socket-1', 300]);
    });

    it('should only remove socket and refresh TTL if other sockets remain', async () => {
      const evalScript = redisService.evalScript as jest.Mock;
      evalScript.mockResolvedValue(0);

      await expect(
        service.userDisconnected('user-1', 'socket-1', 'corr-1'),
      ).resolves.toBe(false);

      expect(evalScript).toHaveBeenCalledTimes(1);
    });
  });

  describe('joinRoom / leaveRoom', () => {
    it('should join room with a single script and refresh TTLs', async () => {
      const evalScript = redisService.evalScript as jest.Mock;
      evalScript.mockResolvedValue(1);

      await service.joinRoom('user-1', 'room-1', 'corr-1');

      expect(evalScript).toHaveBeenCalledTimes(1);
      const [script, keys, args] = evalScript.mock.calls[0];
      expect(script).toContain('SADD');
      expect(keys).toEqual(['user:user-1:rooms', 'room:room-1:users']);
      expect(args).toEqual(['room-1', 'user-1', 3600]);
    });

    it('should leave room with a single script', async () => {
      const evalScript = redisService.evalScript as jest.Mock;
      evalScript.mockResolvedValue(1);

      await service.leaveRoom('user-1', 'room-1', 'corr-1');

      const [script, keys, args] = evalScript.mock.calls[0];
      expect(script).toContain('SREM');
      expect(keys).toEqual(['user:user-1:rooms', 'room:room-1:users']);
      expect(args).toEqual(['room-1', 'user-1']);
    });
  });

  describe('heartbeat', () => {
    it('should update heartbeat with current timestamp', async () => {
      const client = redisService.client as any;
      client.set.mockResolvedValue('OK');

      await service.heartbeat('user-1');

      expect(client.set).toHaveBeenCalledWith(
        'user:user-1:heartbeat',
        expect.any(String),
        { EX: 120 },
      );
    });
  });

  describe('cleanupStaleUsers', () => {
    it('should remove users with stale or missing heartbeats', async () => {
      const client = redisService.client as any;
      client.sMembers.mockResolvedValue(['user-1', 'user-2', 'user-3']);
      client.get
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce((Date.now() - 400000).toString())
        .mockResolvedValueOnce((Date.now() - 10000).toString());

      const mockPipeline = {
        sRem: jest.fn().mockReturnThis(),
        del: jest.fn().mockReturnThis(),
        exec: jest.fn().mockResolvedValue([]),
      };
      client.multi.mockReturnValue(mockPipeline);

      const stale = await service.cleanupStaleUsers(300);

      expect(stale).toContain('user-1');
      expect(stale).toContain('user-2');
      expect(stale).not.toContain('user-3');
      expect(mockPipeline.sRem).toHaveBeenCalledWith('presence:online', 'user-1');
      expect(mockPipeline.sRem).toHaveBeenCalledWith('presence:online', 'user-2');
    });
  });
});
