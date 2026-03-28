import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('bullmq', () => ({
  Queue: vi.fn().mockImplementation((name: string) => ({
    name,
    add: vi.fn(),
  })),
}));

vi.mock('ioredis', () => ({
  default: vi.fn().mockImplementation(() => ({})),
}));

import { resetQueues } from '../../src/services/queue.service';

describe('Queue Service', () => {
  beforeEach(() => {
    resetQueues();
    vi.clearAllMocks();
  });

  it('should create queue with correct provider name', async () => {
    const { getProviderQueue } = await import('../../src/services/queue.service');
    const queue = getProviderQueue('github');
    expect(queue.name).toBe('webhooks:github');
  });

  it('should return same queue instance for same provider', async () => {
    const { getProviderQueue } = await import('../../src/services/queue.service');
    const first = getProviderQueue('github');
    const second = getProviderQueue('github');
    expect(first).toBe(second);
  });

  it('should return different queue instances for different providers', async () => {
    const { getProviderQueue } = await import('../../src/services/queue.service');
    const github = getProviderQueue('github');
    const jira = getProviderQueue('jira');
    expect(github).not.toBe(jira);
    expect(github.name).toBe('webhooks:github');
    expect(jira.name).toBe('webhooks:jira');
  });
});
