import { describe, expect, it, vi } from 'vitest';
import { detachedInFlight, runDetached, settleDetached } from '@/lib/detached';

describe('runDetached / settleDetached', () => {
  it('tracks detached work until it settles, including work started meanwhile', async () => {
    const order: string[] = [];
    runDetached('test', async () => {
      await new Promise((r) => setTimeout(r, 20));
      order.push('first');
      runDetached('test', async () => {
        await new Promise((r) => setTimeout(r, 10));
        order.push('second');
      });
    });
    expect(detachedInFlight()).toBe(1);
    await settleDetached();
    expect(order).toEqual(['first', 'second']);
    expect(detachedInFlight()).toBe(0);
  });

  it('logs failures instead of throwing, and still settles', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    runDetached('boom', async () => {
      throw new Error('kaput');
    });
    await expect(settleDetached()).resolves.toBeUndefined();
    expect(spy).toHaveBeenCalledWith('[boom] failed:', 'kaput');
    expect(detachedInFlight()).toBe(0);
    spy.mockRestore();
  });
});
