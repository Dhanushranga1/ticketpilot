/**
 * @jest-environment jsdom
 */

import { renderHook } from '@testing-library/react';
import { PLANS, FEATURE_MIN_PLAN } from '@/lib/plans';
import { useEntitlements } from '@/hooks/useEntitlements';

jest.mock('@/contexts/OrganizationContext', () => ({
  useOrganization: jest.fn(),
}));

import { useOrganization } from '@/contexts/OrganizationContext';

const mockUseOrg = useOrganization as jest.MockedFunction<typeof useOrganization>;

describe('plans (lib)', () => {
  it('community has no features', () => {
    expect(PLANS.community.features.ai_rag).toBe(false);
    expect(PLANS.community.limits.ai_queries).toBe(0);
  });

  it('starter unlocks ai_rag + kb', () => {
    expect(PLANS.starter.features.ai_rag).toBe(true);
    expect(PLANS.starter.features.kb).toBe(true);
    expect(PLANS.starter.limits.ai_queries).toBe(5_000);
  });

  it('enterprise has unlimited AI queries', () => {
    expect(PLANS.enterprise.limits.ai_queries).toBe(-1);
  });

  it('feature min plan mapping is sane', () => {
    expect(FEATURE_MIN_PLAN.ai_rag).toBe('starter');
    expect(FEATURE_MIN_PLAN.audit_log).toBe('business');
  });
});

describe('useEntitlements', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('defaults to community when no org', () => {
    mockUseOrg.mockReturnValue({
      currentOrganization: null,
    } as any);

    const { result } = renderHook(() => useEntitlements());

    expect(result.current.planId).toBe('community');
    expect(result.current.can('ai_rag')).toBe(false);
    expect(result.current.can('kb')).toBe(false);
  });

  it('respects starter plan org', () => {
    mockUseOrg.mockReturnValue({
      currentOrganization: { plan_id: 'starter' },
    } as any);

    const { result } = renderHook(() => useEntitlements());

    expect(result.current.planId).toBe('starter');
    expect(result.current.can('ai_rag')).toBe(true);
    expect(result.current.can('kb')).toBe(true);
    expect(result.current.can('audit_log')).toBe(false);
    expect(result.current.limit('ai_queries')).toBe(5_000);
  });

  it('business plan unlocks analytics + audit_log', () => {
    mockUseOrg.mockReturnValue({
      currentOrganization: { plan_id: 'business' },
    } as any);

    const { result } = renderHook(() => useEntitlements());

    expect(result.current.can('analytics')).toBe(true);
    expect(result.current.can('audit_log')).toBe(true);
  });

  it('falls back to community for unknown plan', () => {
    mockUseOrg.mockReturnValue({
      currentOrganization: { plan_id: 'mega-ultra' },
    } as any);

    const { result } = renderHook(() => useEntitlements());

    expect(result.current.planId).toBe('mega-ultra');
    expect(result.current.can('ai_rag')).toBe(false);
  });
});
