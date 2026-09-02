/**
 * @jest-environment jsdom
 */

import React from 'react';
import { act, render, screen, waitFor } from '@testing-library/react';
import {
  OrganizationProvider,
  useOrganization,
} from '@/contexts/OrganizationContext';

// Mock supabase
jest.mock('@/lib/supabaseClient', () => ({
  supabase: {
    auth: {
      getSession: jest.fn(),
      onAuthStateChange: jest.fn(() => ({
        data: { subscription: { unsubscribe: jest.fn() } },
      })),
      signOut: jest.fn(),
    },
  },
}));

// Mock next/navigation
jest.mock('next/navigation', () => ({
  useRouter: () => ({
    push: jest.fn(),
    replace: jest.fn(),
  }),
  usePathname: () => '/dashboard',
}));

import { supabase } from '@/lib/supabaseClient';

const mockSupabase = supabase as jest.Mocked<typeof supabase>;
const mockFetch = jest.fn();
global.fetch = mockFetch as unknown as typeof fetch;

const ORG_FIXTURE = {
  id: 'org1',
  name: 'Test Org',
  slug: 'test-org',
  your_role: 'admin',
  is_default: true,
  settings: { onboarding_completed: true },
  plan_id: 'starter',
};

function TestConsumer() {
  const { user, organizations, currentOrganization, loading } =
    useOrganization();
  return (
    <div>
      <div data-testid="loading">{loading ? 'loading' : 'ready'}</div>
      <div data-testid="user">{user?.email || 'no-user'}</div>
      <div data-testid="org-count">{organizations.length}</div>
      <div data-testid="current-org">{currentOrganization?.name || 'none'}</div>
    </div>
  );
}

describe('OrganizationContext', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockFetch.mockReset();
    localStorage.clear();
    sessionStorage.clear();
  });

  it('shows ready state with no session', async () => {
    (mockSupabase.auth.getSession as jest.Mock).mockResolvedValue({
      data: { session: null },
    });

    await act(async () => {
      render(
        <OrganizationProvider>
          <TestConsumer />
        </OrganizationProvider>
      );
    });

    await waitFor(() =>
      expect(screen.getByTestId('loading')).toHaveTextContent('ready')
    );
    expect(screen.getByTestId('user')).toHaveTextContent('no-user');
    expect(screen.getByTestId('org-count')).toHaveTextContent('0');
  });

  it('loads user and organizations on mount', async () => {
    (mockSupabase.auth.getSession as jest.Mock).mockResolvedValue({
      data: { session: { access_token: 'test-token' } },
    });

    mockFetch.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        user: { id: 'u1', email: 'test@example.com', role: 'admin' },
        organizations: [ORG_FIXTURE],
        default_organization_id: 'org1',
      }),
    } as any);

    await act(async () => {
      render(
        <OrganizationProvider>
          <TestConsumer />
        </OrganizationProvider>
      );
    });

    await waitFor(() =>
      expect(screen.getByTestId('user')).toHaveTextContent('test@example.com')
    );
    expect(screen.getByTestId('org-count')).toHaveTextContent('1');
    expect(screen.getByTestId('current-org')).toHaveTextContent('Test Org');
  });

  it('handles API error gracefully', async () => {
    (mockSupabase.auth.getSession as jest.Mock).mockResolvedValue({
      data: { session: { access_token: 'test-token' } },
    });

    mockFetch.mockRejectedValue(new Error('Network error'));

    await act(async () => {
      render(
        <OrganizationProvider>
          <TestConsumer />
        </OrganizationProvider>
      );
    });

    await waitFor(() =>
      expect(screen.getByTestId('loading')).toHaveTextContent('ready')
    );
    expect(screen.getByTestId('user')).toHaveTextContent('no-user');
  });

  it('signs out on 401 response', async () => {
    (mockSupabase.auth.getSession as jest.Mock).mockResolvedValue({
      data: { session: { access_token: 'expired-token' } },
    });

    mockFetch.mockResolvedValue({
      ok: false,
      status: 401,
    } as any);

    await act(async () => {
      render(
        <OrganizationProvider>
          <TestConsumer />
        </OrganizationProvider>
      );
    });

    await waitFor(() =>
      expect(mockSupabase.auth.signOut).toHaveBeenCalled()
    );
  });

  it('persists current org to localStorage', async () => {
    (mockSupabase.auth.getSession as jest.Mock).mockResolvedValue({
      data: { session: { access_token: 'test-token' } },
    });

    mockFetch.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        user: { id: 'u1', email: 'test@example.com', role: 'admin' },
        organizations: [ORG_FIXTURE],
        default_organization_id: 'org1',
      }),
    } as any);

    await act(async () => {
      render(
        <OrganizationProvider>
          <TestConsumer />
        </OrganizationProvider>
      );
    });

    await waitFor(() =>
      expect(localStorage.getItem('currentOrganizationId')).toBe('org1')
    );
  });
});
