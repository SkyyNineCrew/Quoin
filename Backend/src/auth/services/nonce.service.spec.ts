import { Test, TestingModule } from '@nestjs/testing';
import { getDataSourceToken, getRepositoryToken } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { NonceService } from './nonce.service';
import { LoginNonce } from '../entities/login-nonce.entity';
import { InvalidNonceError } from '../../common/exceptions/api-error.exception';

describe('NonceService', () => {
  let service: NonceService;
  let repository: Repository<LoginNonce>;

  const mockRepository = {
    create: jest.fn(),
    save: jest.fn(),
    findOne: jest.fn(),
    update: jest.fn(),
    delete: jest.fn(),
  };

  // validateNonce consumes the nonce inside dataSource.transaction(), so the
  // repository it talks to comes from the transaction manager rather than the
  // injected one.
  const mockQueryBuilder = {
    update: jest.fn().mockReturnThis(),
    set: jest.fn().mockReturnThis(),
    where: jest.fn().mockReturnThis(),
    returning: jest.fn().mockReturnThis(),
    execute: jest.fn(),
  };

  const mockTransactionalRepository = {
    findOne: jest.fn(),
    create: jest.fn((data) => data),
    createQueryBuilder: jest.fn(() => mockQueryBuilder),
  };

  const mockDataSource = {
    transaction: jest.fn((run: (manager: unknown) => unknown) =>
      run({ getRepository: () => mockTransactionalRepository }),
    ),
  };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        NonceService,
        {
          provide: getRepositoryToken(LoginNonce),
          useValue: mockRepository,
        },
        {
          provide: getDataSourceToken(),
          useValue: mockDataSource,
        },
      ],
    }).compile();

    service = module.get<NonceService>(NonceService);
    repository = module.get<Repository<LoginNonce>>(
      getRepositoryToken(LoginNonce),
    );
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  describe('generateNonce', () => {
    it('should generate a nonce successfully', async () => {
      const publicKey = 'GABC123TEST';
      const mockNonce = {
        id: '1',
        nonce: 'test-nonce-uuid',
        publicKey,
        expiresAt: new Date(),
        used: false,
        createdAt: new Date(),
      };

      mockRepository.create.mockReturnValue(mockNonce);
      mockRepository.save.mockResolvedValue(mockNonce);

      const result = await service.generateNonce(publicKey);

      expect(result).toHaveProperty('nonce');
      expect(result).toHaveProperty('expiresAt');
      expect(result).toHaveProperty('message');
      expect(result.message).toContain('Sign this message');
      expect(mockRepository.create).toHaveBeenCalled();
      expect(mockRepository.save).toHaveBeenCalled();
    });

    it('should set expiration 5 minutes in the future', async () => {
      const publicKey = 'GABC123TEST';
      const fiveMinutes = 5 * 60 * 1000;
      const before = Date.now();

      mockRepository.create.mockImplementation((data) => data);
      mockRepository.save.mockImplementation((data) => Promise.resolve(data));

      const result = await service.generateNonce(publicKey);
      const after = Date.now();

      // Window is exact to the millisecond; the previous bounds truncated the
      // seconds field and failed whenever the clock's second was >= 30.
      expect(result.expiresAt.getTime()).toBeGreaterThanOrEqual(
        before + fiveMinutes,
      );
      expect(result.expiresAt.getTime()).toBeLessThanOrEqual(
        after + fiveMinutes,
      );
    });
  });

  describe('validateNonce', () => {
    const publicKey = 'GABC123TEST';

    const nonceRow = (overrides: Partial<LoginNonce> = {}) => ({
      id: '1',
      nonce: 'valid-nonce',
      publicKey,
      expiresAt: new Date(Date.now() + 300000),
      used: false,
      createdAt: new Date(),
      ...overrides,
    });

    it('should validate and consume a valid nonce', async () => {
      const row = nonceRow();
      mockTransactionalRepository.findOne.mockResolvedValue(row);
      mockQueryBuilder.execute.mockResolvedValue({
        raw: [{ ...row, used: true }],
      });

      const result = await service.validateNonce('valid-nonce', publicKey);

      expect(mockDataSource.transaction).toHaveBeenCalledTimes(1);
      expect(mockTransactionalRepository.findOne).toHaveBeenCalledWith({
        where: { nonce: 'valid-nonce', publicKey },
      });
      expect(mockQueryBuilder.set).toHaveBeenCalledWith({
        used: true,
        consumedAt: expect.any(Date),
      });
      expect(mockQueryBuilder.where).toHaveBeenCalledWith(
        'nonce = :nonce AND publicKey = :publicKey AND used = false',
        { nonce: 'valid-nonce', publicKey },
      );
      expect(result.used).toBe(true);
    });

    it('should throw error if nonce not found', async () => {
      mockTransactionalRepository.findOne.mockResolvedValue(null);

      await expect(
        service.validateNonce('invalid-nonce', publicKey),
      ).rejects.toThrow(InvalidNonceError);

      expect(mockQueryBuilder.execute).not.toHaveBeenCalled();
    });

    it('should throw error if nonce already used', async () => {
      mockTransactionalRepository.findOne.mockResolvedValue(
        nonceRow({ nonce: 'used-nonce', used: true }),
      );

      await expect(
        service.validateNonce('used-nonce', publicKey),
      ).rejects.toThrow('Nonce already used');

      expect(mockQueryBuilder.execute).not.toHaveBeenCalled();
    });

    it('should throw error if nonce expired', async () => {
      mockTransactionalRepository.findOne.mockResolvedValue(
        nonceRow({ nonce: 'expired-nonce', expiresAt: new Date(Date.now() - 1000) }),
      );

      await expect(
        service.validateNonce('expired-nonce', publicKey),
      ).rejects.toThrow('Nonce expired');

      expect(mockQueryBuilder.execute).not.toHaveBeenCalled();
    });

    it('rejects when a concurrent request claimed the nonce first', async () => {
      // The row still looks unused when it is read, but the conditional
      // update matches nothing because another transaction consumed it.
      mockTransactionalRepository.findOne.mockResolvedValue(nonceRow());
      mockQueryBuilder.execute.mockResolvedValue({ raw: [] });

      await expect(
        service.validateNonce('valid-nonce', publicKey),
      ).rejects.toThrow('Nonce already used');
    });
  });

  describe('markNonceUsed', () => {
    it('should mark nonce as used', async () => {
      const nonce = 'test-nonce';
      mockRepository.update.mockResolvedValue({ affected: 1 });

      await service.markNonceUsed(nonce);

      expect(mockRepository.update).toHaveBeenCalledWith(
        { nonce },
        { used: true },
      );
    });
  });

  describe('cleanupExpiredNonces', () => {
    it('should delete expired nonces', async () => {
      mockRepository.delete.mockResolvedValue({ affected: 5 });

      await service.cleanupExpiredNonces();

      expect(mockRepository.delete).toHaveBeenCalled();
    });
  });
});
