import { describe, it, expect, vi } from 'vitest';
import type { PrismaClient } from '@prisma/client';

const { update } = vi.hoisted(() => ({
  update: vi.fn<(args: { where: unknown; data: unknown }) => Promise<unknown>>(),
}));

vi.mock(import('@prisma/client'), () => ({
  PrismaClient: vi.fn<() => { mention: { update: typeof update } }>(() => ({
    mention: { update },
  })) as unknown as typeof PrismaClient,
}));

const { markMentionAsFailed } = await import('../../src/services/database.js');

describe(markMentionAsFailed, () => {
  it('moves the mention to FAILED, which resetStuckMentions never picks back up', async () => {
    await markMentionAsFailed('mention-id');

    expect(update).toHaveBeenCalledExactlyOnceWith({
      where: { id: 'mention-id' },
      data: { status: 'FAILED' },
    });
  });
});
