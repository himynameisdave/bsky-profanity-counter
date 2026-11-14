import { describe, it, expect, vi } from 'vitest';
import type { PrismaClient } from '../../src/generated/prisma/client.js';

const { update } = vi.hoisted(() => ({
  update: vi.fn<(args: { where: unknown; data: unknown }) => Promise<unknown>>(),
}));

vi.mock(import('../../src/generated/prisma/client.js'), () => ({
  PrismaClient: class {
    mention = { update };
  } as unknown as typeof PrismaClient,
}));

const { init, markMentionAsFailed } = await import('../../src/services/database.js');
init({ url: 'postgresql://test:test@localhost:5432/test' });

describe(markMentionAsFailed, () => {
  it('moves the mention to FAILED, which resetStuckMentions never picks back up', async () => {
    await markMentionAsFailed('mention-id', 'BlockedActor');

    expect(update).toHaveBeenCalledExactlyOnceWith({
      where: { id: 'mention-id' },
      data: { status: 'FAILED', lastError: 'BlockedActor' },
    });
  });
});
