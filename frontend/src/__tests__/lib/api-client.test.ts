/**
 * @jest-environment jsdom
 */

import { apiCall, api, getAuthToken } from '@/lib/api-client';

// Mock supabase
jest.mock('@/lib/supabaseClient', () => ({
  supabase: {
    auth: {
      getSession: jest.fn(),
      refreshSession: jest.fn(),
    },
  },
}));

import { supabase } from '@/lib/supabaseClient';

const mockSupabase = supabase as jest.Mocked<typeof supabase>;

// Use jest.fn() assigned to global.fetch for reliable interception
const mockFetch = jest.fn();
global.fetch = mockFetch;

describe('API Client', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockFetch.mockReset();
  });

  describe('apiCall', () => {
    it('throws when no auth token available', async () => {
      (mockSupabase.auth.getSession as jest.Mock).mockResolvedValue({
        data: { session: null },
      });

      await expect(apiCall('/api/test')).rejects.toThrow(
        'No authentication token available'
      );
    });

    it('includes auth header in requests', async () => {
      (mockSupabase.auth.getSession as jest.Mock).mockResolvedValue({
        data: { session: { access_token: 'test-token-123' } },
      });

      mockFetch.mockResolvedValue({
        ok: true,
        status: 200,
        text: async () => JSON.stringify({ data: 'test' }),
      });

      await apiCall('/api/test');

      expect(mockFetch).toHaveBeenCalledWith(
        expect.stringContaining('/api/test'),
        expect.objectContaining({
          headers: expect.objectContaining({
            Authorization: 'Bearer test-token-123',
          }),
        })
      );
    });

    it('includes organization ID header when provided', async () => {
      (mockSupabase.auth.getSession as jest.Mock).mockResolvedValue({
        data: { session: { access_token: 'test-token' } },
      });

      mockFetch.mockResolvedValue({
        ok: true,
        status: 200,
        text: async () => JSON.stringify({}),
      });

      await apiCall('/api/test', { orgId: 'org-123' });

      expect(mockFetch).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({
          headers: expect.objectContaining({
            'X-Organization-ID': 'org-123',
          }),
        })
      );
    });

    it('caches GET requests', async () => {
      (mockSupabase.auth.getSession as jest.Mock).mockResolvedValue({
        data: { session: { access_token: 'test-token' } },
      });

      mockFetch.mockResolvedValue({
        ok: true,
        status: 200,
        text: async () => JSON.stringify({ cached: true }),
      });

      // First call
      await apiCall('/api/cache-test');
      // Second call should hit cache
      await apiCall('/api/cache-test');

      // fetch should only be called once
      expect(mockFetch).toHaveBeenCalledTimes(1);
    });

    it('does not cache POST requests', async () => {
      (mockSupabase.auth.getSession as jest.Mock).mockResolvedValue({
        data: { session: { access_token: 'test-token' } },
      });

      mockFetch.mockResolvedValue({
        ok: true,
        status: 200,
        text: async () => JSON.stringify({}),
      });

      await apiCall('/api/post-test', { method: 'POST', body: { foo: 'bar' } });
      await apiCall('/api/post-test', { method: 'POST', body: { foo: 'bar' } });

      expect(mockFetch).toHaveBeenCalledTimes(2);
    });

    it('retries on 502/503', async () => {
      (mockSupabase.auth.getSession as jest.Mock).mockResolvedValue({
        data: { session: { access_token: 'test-token' } },
      });

      // First two calls return 502, third succeeds
      mockFetch
        .mockResolvedValueOnce({ ok: false, status: 502, text: async () => '' })
        .mockResolvedValueOnce({ ok: false, status: 502, text: async () => '' })
        .mockResolvedValue({
          ok: true,
          status: 200,
          text: async () => JSON.stringify({ success: true }),
        });

      const result = await apiCall('/api/retry-test');

      expect(result).toEqual({ success: true });
      expect(mockFetch).toHaveBeenCalledTimes(3);
    }, 30000);

    it('retries on 401 with token refresh', async () => {
      (mockSupabase.auth.getSession as jest.Mock).mockResolvedValue({
        data: { session: { access_token: 'old-token' } },
      });

      (mockSupabase.auth.refreshSession as jest.Mock).mockResolvedValue({
        data: { session: { access_token: 'new-token' } },
      });

      mockFetch
        .mockResolvedValueOnce({ ok: false, status: 401, text: async () => '' })
        .mockResolvedValue({
          ok: true,
          status: 200,
          text: async () => JSON.stringify({ refreshed: true }),
        });

      const result = await apiCall('/api/refresh-test');

      expect(result).toEqual({ refreshed: true });
      expect(mockSupabase.auth.refreshSession).toHaveBeenCalled();
      expect(mockFetch).toHaveBeenCalledTimes(2);
    });

    it('throws on non-OK response', async () => {
      (mockSupabase.auth.getSession as jest.Mock).mockResolvedValue({
        data: { session: { access_token: 'test-token' } },
      });

      mockFetch.mockResolvedValue({
        ok: false,
        status: 400,
        text: async () => JSON.stringify({ detail: 'Bad request' }),
      });

      await expect(apiCall('/api/error-test')).rejects.toThrow('Bad request');
    });

    it('includes body in POST requests', async () => {
      (mockSupabase.auth.getSession as jest.Mock).mockResolvedValue({
        data: { session: { access_token: 'test-token' } },
      });

      mockFetch.mockResolvedValue({
        ok: true,
        status: 200,
        text: async () => JSON.stringify({}),
      });

      await apiCall('/api/body-test', {
        method: 'POST',
        body: { title: 'Test', description: 'Desc' },
      });

      expect(mockFetch).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({
          method: 'POST',
          body: JSON.stringify({ title: 'Test', description: 'Desc' }),
        })
      );
    });
  });

  describe('api convenience methods', () => {
    beforeEach(() => {
      (mockSupabase.auth.getSession as jest.Mock).mockResolvedValue({
        data: { session: { access_token: 'test-token' } },
      });
      mockFetch.mockResolvedValue({
        ok: true,
        status: 200,
        text: async () => JSON.stringify({}),
      });
    });

    it('api.get calls with GET method', async () => {
      await api.get('/api/conv-get');
      expect(mockFetch).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({ method: 'GET' })
      );
    });

    it('api.post calls with POST method', async () => {
      await api.post('/api/conv-post', { foo: 'bar' });
      expect(mockFetch).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({ method: 'POST' })
      );
    });

    it('api.delete calls with DELETE method', async () => {
      await api.delete('/api/conv-delete');
      expect(mockFetch).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({ method: 'DELETE' })
      );
    });
  });

  describe('getAuthToken', () => {
    it('returns token when available', async () => {
      (mockSupabase.auth.getSession as jest.Mock).mockResolvedValue({
        data: { session: { access_token: 'my-token' } },
      });

      const token = await getAuthToken();
      expect(token).toBe('my-token');
    });

    it('throws when no token', async () => {
      (mockSupabase.auth.getSession as jest.Mock).mockResolvedValue({
        data: { session: null },
      });

      await expect(getAuthToken()).rejects.toThrow(
        'No authentication token available'
      );
    });
  });
});
