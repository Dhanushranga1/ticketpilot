/**
 * @jest-environment jsdom
 */

import { cn } from '@/lib/utils';
import { useReducedMotion } from '@/lib/a11y';
import { API_BASE, apiGet, apiPost } from '@/lib/api';
import { renderHook } from '@testing-library/react';

jest.mock('@/lib/supabaseClient', () => ({
  supabase: {
    auth: {
      getSession: jest.fn(),
    },
  },
}));

import { supabase } from '@/lib/supabaseClient';

const mockSupabase = supabase as jest.Mocked<typeof supabase>;
const mockFetch = jest.fn();
global.fetch = mockFetch as unknown as typeof fetch;

describe('cn (utils)', () => {
  it('merges class names', () => {
    expect(cn('a', 'b')).toBe('a b');
  });

  it('handles conditional values', () => {
    expect(cn('a', false && 'b', null, undefined, 'c')).toBe('a c');
  });

  it('tailwind-merge dedupes conflicting classes', () => {
    expect(cn('px-2', 'px-4')).toBe('px-4');
  });
});

describe('useReducedMotion (a11y)', () => {
  it('returns matchMedia result', () => {
    const { result } = renderHook(() => useReducedMotion());
    expect(typeof result.current).toBe('boolean');
  });
});

describe('legacy api helpers', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockFetch.mockReset();
  });

  it('apiGet uses session token when not passed', async () => {
    (mockSupabase.auth.getSession as jest.Mock).mockResolvedValue({
      data: { session: { access_token: 'tok-123' } },
    });
    mockFetch.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ data: 1 }),
    } as any);

    const result = await apiGet('/api/test');

    expect(result).toEqual({ data: 1 });
    expect(mockFetch).toHaveBeenCalledWith(
      expect.stringContaining('/api/test'),
      expect.objectContaining({
        headers: expect.objectContaining({
          Authorization: 'Bearer tok-123',
        }),
      })
    );
  });

  it('apiGet throws on non-OK response', async () => {
    (mockSupabase.auth.getSession as jest.Mock).mockResolvedValue({
      data: { session: null },
    });
    mockFetch.mockResolvedValue({
      ok: false,
      status: 500,
      text: async () => 'boom',
    } as any);

    await expect(apiGet('/api/test')).rejects.toThrow('API 500: boom');
  });

  it('apiPost sends JSON body with auth header', async () => {
    (mockSupabase.auth.getSession as jest.Mock).mockResolvedValue({
      data: { session: { access_token: 'tok-456' } },
    });
    mockFetch.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ ok: true }),
    } as any);

    const result = await apiPost('/api/test', { foo: 'bar' });

    expect(result).toEqual({ ok: true });
    expect(mockFetch).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ foo: 'bar' }),
      })
    );
  });

  it('API_BASE strips trailing slash', () => {
    expect(API_BASE.endsWith('/')).toBe(false);
  });
});
