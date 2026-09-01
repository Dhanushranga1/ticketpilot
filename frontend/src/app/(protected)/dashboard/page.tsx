'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { motion } from 'framer-motion';
import { useOrganization } from '@/contexts/OrganizationContext';
import api from '@/lib/api-client';
import { BentoGrid, BentoGridItem } from '@/components/ui/BentoGrid';
import { StatusBadge } from '@/components/StatusBadge';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { FieldError } from '@/components/FieldError';
import { DashboardSkeleton } from '@/components/skeletons/DashboardSkeleton';
import {
  TicketIcon,
  TrendingUp,
  Clock,
  AlertTriangle,
  MessageSquare,
  BarChart3,
  User,
  ArrowUpRight,
  Activity,
  Zap,
  Settings,
  BookOpen,
  Users,
  CheckCircle2,
} from 'lucide-react';
import { PageShell } from '@/ui/motion/PageShell';

type Me = { id: string; email?: string; role?: string };

interface DashboardStats {
  tickets: {
    total: number;
    open: number;
    pending: number;
    resolved: number;
    urgent: number;
  };
  performance: {
    avgResponseTime: string;
    satisfaction: number;
    resolution_rate: number;
  };
  activity: {
    today: number;
    thisWeek: number;
    trend: 'up' | 'down' | 'stable';
  };
}

interface AdminAnalytics {
  total_tickets: number;
  resolution_rate: number;
  avg_response_hours: number;
  avg_customer_rating: number | null;
  today_count: number;
  week_count: number;
  open_tickets: number;
  overdue_tickets: number;
  needs_attention: number;
}

interface ActivityItem {
  id: string;
  ticketId: string;
  action: string;
  detail: string;
  time: string;
  status: string;
}

interface RepCounts {
  needs_attention: number;
  open_active: number;
  escalated: number;
  closed_recent: number;
}

interface TicketItem {
  id: string;
  title: string;
  status: string;
  priority: string;
  created_at: string;
  updated_at: string;
  created_by: string;
}

interface TicketsResponse {
  items: TicketItem[];
  total: number;
  offset: number;
  limit: number;
}

function formatRelativeTime(ts: string): string {
  const diff = Date.now() - new Date(ts).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins} minute${mins === 1 ? '' : 's'} ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs} hour${hrs === 1 ? '' : 's'} ago`;
  const days = Math.floor(hrs / 24);
  return `${days} day${days === 1 ? '' : 's'} ago`;
}

function activityStatusFromType(type: string): string {
  if (type === 'ticket_resolved') return 'resolved';
  if (type === 'ticket_created') return 'open';
  return 'in_progress';
}

function activityLabelFromType(type: string): string {
  if (type === 'ticket_resolved') return 'Ticket resolved';
  if (type === 'ticket_created') return 'New ticket created';
  if (type === 'message_sent') return 'Response sent';
  return type.replace(/_/g, ' ');
}

function GettingStartedChecklist({
  checklist,
  onCheck,
  onNavigate,
}: {
  checklist: Record<string, boolean>;
  onCheck: (id: string) => void;
  onNavigate: (href: string) => void;
}) {
  const items = [
    {
      id: 'workspace',
      label: 'Workspace created',
      sub: 'Your organisation is live.',
      icon: Zap,
      color: 'text-indigo-400',
      bg: 'bg-indigo-500/10',
      href: null,
    },
    {
      id: 'kb',
      label: 'Upload a knowledge base doc',
      sub: 'AI answers will cite it automatically.',
      icon: BookOpen,
      color: 'text-violet-400',
      bg: 'bg-violet-500/10',
      href: '/kb',
    },
    {
      id: 'team',
      label: 'Invite a team member',
      sub: 'Reps handle tickets routed by CASPER.',
      icon: Users,
      color: 'text-emerald-400',
      bg: 'bg-emerald-500/10',
      href: '/admin/users',
    },
    {
      id: 'ticket',
      label: 'Create your first ticket',
      sub: 'See the AI in action end-to-end.',
      icon: TicketIcon,
      color: 'text-amber-400',
      bg: 'bg-amber-500/10',
      href: '/tickets',
    },
  ];
  const done = items.filter(i => checklist[i.id]).length;
  const allDone = done === items.length;

  if (allDone) {
    return (
      <motion.div
        initial={{ opacity: 0, scale: 0.95 }}
        animate={{ opacity: 1, scale: 1 }}
        className="rounded-2xl border border-emerald-500/30 bg-emerald-500/10 p-8 text-center"
      >
        <div className="text-3xl mb-3">🚀</div>
        <p className="font-bold text-emerald-400 text-lg">
          All set — your workspace is live!
        </p>
        <p className="text-sm text-muted-foreground mt-1">
          Your first tickets will show up here as they come in.
        </p>
      </motion.div>
    );
  }

  return (
    <div className="rounded-2xl border border-border bg-card overflow-hidden">
      <div className="px-5 pt-5 pb-3">
        <div className="flex items-center justify-between mb-1.5">
          <p className="text-sm font-semibold">Getting started</p>
          <p className="text-xs text-muted-foreground">
            {done} of {items.length} complete
          </p>
        </div>
        <div className="h-1.5 bg-muted rounded-full overflow-hidden">
          <motion.div
            className="h-full bg-primary rounded-full"
            initial={{ width: 0 }}
            animate={{ width: `${(done / items.length) * 100}%` }}
            transition={{ duration: 0.5 }}
          />
        </div>
      </div>
      <div className="divide-y divide-border">
        {items.map(item => {
          const checked = !!checklist[item.id];
          return (
            <button
              key={item.id}
              type="button"
              onClick={() => {
                onCheck(item.id);
                if (item.href) onNavigate(item.href);
              }}
              className="w-full flex items-center gap-4 px-5 py-4 hover:bg-accent/50 transition-colors text-left"
            >
              <div
                className={`w-8 h-8 rounded-lg ${item.bg} flex items-center justify-center shrink-0`}
              >
                {checked ? (
                  <CheckCircle2 className="w-4 h-4 text-emerald-400" />
                ) : (
                  <item.icon className={`w-4 h-4 ${item.color}`} />
                )}
              </div>
              <div className="flex-1 min-w-0">
                <p
                  className={`text-sm font-medium ${checked ? 'line-through text-muted-foreground' : ''}`}
                >
                  {item.label}
                </p>
                <p className="text-xs text-muted-foreground truncate">
                  {item.sub}
                </p>
              </div>
              {!checked && (
                <ArrowUpRight className="w-4 h-4 text-muted-foreground shrink-0" />
              )}
            </button>
          );
        })}
      </div>
    </div>
  );
}

export default function DashboardPage() {
  const router = useRouter();
  const { currentOrganization, isReady, switchingOrg } = useOrganization();
  const orgId = currentOrganization?.id;
  const [me, setMe] = useState<Me | null>(null);
  const [stats, setStats] = useState<DashboardStats | null>(null);
  const [recentActivity, setRecentActivity] = useState<ActivityItem[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [checklist, setChecklist] = useState<Record<string, boolean>>({
    workspace: true,
  });

  const loadDashboardStats = async (userRole: string, orgId: string) => {
    try {
      if (userRole === 'admin') {
        const [analytics, categorystats] = await Promise.all([
          api.get<AdminAnalytics>('/api/admin/analytics/summary', orgId),
          api
            .get<any>('/api/admin/analytics/by-category', orgId)
            .catch(() => ({ status_counts: [], priority_counts: [] })),
        ]);

        const statusCounts = categorystats.status_counts || [];
        const priorityCounts = categorystats.priority_counts || [];
        const openCount =
          statusCounts.find((s: any) => s.status === 'open')?.count || 0;
        const resolvedCount =
          statusCounts.find((s: any) => s.status === 'resolved')?.count || 0;
        const inProgressCount =
          statusCounts.find((s: any) => s.status === 'in_progress')?.count || 0;
        const urgentCount =
          priorityCounts.find((p: any) => p.priority === 'urgent')?.count || 0;
        const satisfaction =
          analytics.avg_customer_rating != null
            ? parseFloat(analytics.avg_customer_rating.toFixed(1))
            : 0;

        return {
          tickets: {
            total: analytics.total_tickets || 0,
            open: openCount,
            pending: inProgressCount,
            resolved: resolvedCount,
            urgent: urgentCount,
          },
          performance: {
            avgResponseTime: `${analytics.avg_response_hours || 0}h`,
            satisfaction,
            resolution_rate: analytics.resolution_rate || 0,
          },
          activity: {
            today: analytics.today_count || 0,
            thisWeek: analytics.week_count || 0,
            trend: 'up' as const,
          },
        };
      } else if (userRole === 'rep') {
        const counts = await api.get<RepCounts>('/api/rep/counts', orgId);

        return {
          tickets: {
            total:
              counts.needs_attention + counts.open_active + counts.escalated,
            open: counts.open_active || 0,
            pending: counts.needs_attention || 0,
            resolved: counts.closed_recent || 0,
            urgent: counts.escalated || 0,
          },
          performance: {
            avgResponseTime: 'N/A',
            satisfaction: 0,
            resolution_rate: 0,
          },
          activity: {
            today: counts.needs_attention || 0,
            thisWeek: counts.open_active || 0,
            trend: 'stable' as const,
          },
        };
      } else {
        // Customer: get their own tickets
        const myTickets = await api.get<TicketsResponse>(
          '/api/tickets?mine=true&status=all&limit=100',
          orgId
        );

        const tickets = myTickets.items || [];
        const openCount = tickets.filter(
          (t: TicketItem) => t.status === 'open'
        ).length;
        const pendingCount = tickets.filter(
          (t: TicketItem) => t.status === 'pending'
        ).length;
        const resolvedCount = tickets.filter((t: TicketItem) =>
          ['resolved', 'closed'].includes(t.status)
        ).length;
        const urgentCount = tickets.filter(
          (t: TicketItem) => t.priority === 'urgent'
        ).length;

        return {
          tickets: {
            total: myTickets.total || 0,
            open: openCount,
            pending: pendingCount,
            resolved: resolvedCount,
            urgent: urgentCount,
          },
          performance: {
            avgResponseTime: 'N/A',
            satisfaction: 0,
            resolution_rate:
              resolvedCount > 0
                ? Math.round((resolvedCount / myTickets.total) * 100)
                : 0,
          },
          activity: {
            today: openCount + pendingCount,
            thisWeek: myTickets.total || 0,
            trend: 'stable' as const,
          },
        };
      }
    } catch (error) {
      throw error;
    }
  };

  useEffect(() => {
    const loadDashboardData = async () => {
      if (!isReady || !orgId) {
        setLoading(true);
        return;
      }

      try {
        setLoading(true);
        const userInfo = await api.get<Me>('/api/me');
        setMe(userInfo);
        const role = userInfo.role || 'customer';
        const [dashboardStats] = await Promise.all([
          loadDashboardStats(role, orgId),
        ]);
        setStats(dashboardStats);

        // Load recent activity per role (non-blocking — don't fail the whole page)
        if (role === 'admin') {
          api
            .get<any[]>(`/api/admin/activity?limit=5`, orgId)
            .then(items => {
              setRecentActivity(
                (items || []).map((item: any) => ({
                  id: item.id,
                  ticketId: item.ticket_id,
                  action: activityLabelFromType(item.type),
                  detail: item.detail || '',
                  time: formatRelativeTime(item.ts),
                  status: activityStatusFromType(item.type),
                }))
              );
            })
            .catch(() => {});
        } else {
          api
            .get<TicketsResponse>(
              '/api/tickets?mine=true&status=all&limit=5',
              orgId
            )
            .then(res => {
              const items = (res.items || []).sort(
                (a: TicketItem, b: TicketItem) =>
                  new Date(b.updated_at).getTime() -
                  new Date(a.updated_at).getTime()
              );
              setRecentActivity(
                items.map((t: TicketItem) => ({
                  id: t.id,
                  ticketId: t.id,
                  action:
                    t.status === 'resolved'
                      ? 'Ticket resolved'
                      : t.status === 'in_progress'
                        ? 'In progress'
                        : t.status === 'open'
                          ? 'Open ticket'
                          : t.status,
                  detail: t.title,
                  time: formatRelativeTime(t.updated_at),
                  status: t.status,
                }))
              );
            })
            .catch(() => {});
        }
      } catch (e: unknown) {
        const error = e as Error;
        setError(error.message);
      } finally {
        setLoading(false);
      }
    };

    loadDashboardData();
  }, [isReady, orgId]);

  // Load/persist getting-started checklist state per org
  useEffect(() => {
    if (!orgId) return;
    const key = `org-checklist-${orgId}`;
    try {
      const stored = localStorage.getItem(key);
      if (stored) setChecklist(JSON.parse(stored));
    } catch {
      /* ignore */
    }
  }, [orgId]);

  const tickChecklist = (id: string) => {
    if (!orgId) return;
    const next = { ...checklist, [id]: true };
    setChecklist(next);
    try {
      localStorage.setItem(`org-checklist-${orgId}`, JSON.stringify(next));
    } catch {
      /* ignore */
    }
  };

  const getGreeting = () => {
    const hour = new Date().getHours();
    if (hour < 12) return 'Good morning';
    if (hour < 17) return 'Good afternoon';
    return 'Good evening';
  };

  const getStatusColor = (
    status: string
  ): 'open' | 'in_progress' | 'resolved' | 'closed' | 'escalated' => {
    switch (status.toLowerCase()) {
      case 'open':
        return 'open';
      case 'in_progress':
      case 'pending':
        return 'in_progress';
      case 'resolved':
        return 'resolved';
      case 'closed':
        return 'closed';
      case 'escalated':
      case 'urgent':
        return 'escalated';
      default:
        return 'open';
    }
  };

  return (
    <PageShell>
      <main className="min-h-screen bg-gradient-to-br from-background via-background to-muted/20 p-4 sm:p-6">
        <div className="max-w-7xl mx-auto space-y-6 sm:space-y-8">
          {/* Header Section - Mobile Optimized */}
          <div className="flex flex-col gap-4">
            <div className="flex-1">
              <h1 className="text-2xl sm:text-3xl font-bold tracking-tight">
                {getGreeting()}
                {me?.email ? `, ${me.email.split('@')[0]}` : ''}
              </h1>
              <p className="text-sm sm:text-base text-muted-foreground mt-1">
                Here&apos;s what&apos;s happening with your tickets today.
              </p>
            </div>

            {me && (
              <Card className="bg-card/50 backdrop-blur-sm border-border/50">
                <CardContent className="p-3 sm:p-4">
                  <div className="flex items-center gap-3">
                    <div className="h-10 w-10 rounded-full bg-primary/10 flex items-center justify-center flex-shrink-0">
                      <User className="h-5 w-5 text-primary" />
                    </div>
                    <div className="min-w-0 flex-1">
                      <p className="font-medium text-sm truncate">
                        {me.email ?? me.id}
                      </p>
                      <Badge variant="secondary" className="text-xs">
                        {me.role === 'customer' ? 'Client' : me.role}
                      </Badge>
                    </div>
                  </div>
                </CardContent>
              </Card>
            )}
          </div>

          {error && <FieldError id="dashboard-error">{error}</FieldError>}

          {/* Show skeleton when switching orgs or initial load */}
          {loading || switchingOrg ? (
            <DashboardSkeleton />
          ) : stats && stats.tickets.total === 0 ? (
            <motion.div
              initial={{ opacity: 0, scale: 0.95 }}
              animate={{ opacity: 1, scale: 1 }}
              className="space-y-8 py-4"
            >
              <div className="text-center">
                <h1 className="text-3xl font-bold mb-2">
                  Welcome to TicketPilot!
                </h1>
                <p className="text-muted-foreground">
                  {me?.role === 'admin'
                    ? 'Set up your workspace to get started.'
                    : 'Your support workspace is ready.'}
                </p>
              </div>

              {me?.role === 'admin' ? (
                <div className="max-w-lg mx-auto">
                  <GettingStartedChecklist
                    checklist={checklist}
                    onCheck={tickChecklist}
                    onNavigate={href => router.push(href)}
                  />
                </div>
              ) : me?.role === 'rep' ? (
                <div className="text-center">
                  <p className="text-muted-foreground mb-6">
                    Your queue is empty. New tickets will appear here.
                  </p>
                  <Button size="lg" onClick={() => router.push('/rep')}>
                    Open Rep Console
                    <ArrowUpRight className="ml-2 w-5 h-5" />
                  </Button>
                </div>
              ) : (
                <div className="text-center space-y-4">
                  <p className="text-muted-foreground">
                    Get instant AI-powered help for any issue.
                  </p>
                  <Button size="lg" onClick={() => router.push('/tickets')}>
                    Create Your First Ticket
                    <ArrowUpRight className="ml-2 w-5 h-5" />
                  </Button>
                  <div className="max-w-lg mx-auto grid grid-cols-3 gap-3 text-sm mt-4">
                    {[
                      {
                        icon: '📝',
                        title: 'Be Specific',
                        desc: 'Describe your issue clearly',
                      },
                      {
                        icon: '🤖',
                        title: 'AI Helps First',
                        desc: 'Searches our help docs instantly',
                      },
                      {
                        icon: '👤',
                        title: 'Human Backup',
                        desc: 'Escalate to our support team',
                      },
                    ].map(item => (
                      <div
                        key={item.title}
                        className="rounded-lg border border-border bg-card p-3 text-center"
                      >
                        <div className="text-xl mb-1">{item.icon}</div>
                        <div className="font-medium text-xs mb-0.5">
                          {item.title}
                        </div>
                        <div className="text-xs text-muted-foreground">
                          {item.desc}
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </motion.div>
          ) : stats ? (
            <BentoGrid>
              {/* Tickets Overview */}
              <BentoGridItem
                title="Total Tickets"
                description="All tickets in the system"
                icon={<TicketIcon className="h-5 w-5" />}
                size="sm"
                badge={stats.tickets.total.toString()}
                badgeVariant="secondary"
              >
                <div className="space-y-3">
                  <div className="flex items-center justify-between">
                    <span className="text-sm text-muted-foreground">Open</span>
                    <div className="flex items-center gap-2">
                      <StatusBadge status="open" />
                      <Badge variant="secondary">{stats.tickets.open}</Badge>
                    </div>
                  </div>
                  <div className="flex items-center justify-between">
                    <span className="text-sm text-muted-foreground">
                      Pending
                    </span>
                    <div className="flex items-center gap-2">
                      <StatusBadge status="in_progress" />
                      <Badge variant="secondary">{stats.tickets.pending}</Badge>
                    </div>
                  </div>
                  <div className="flex items-center justify-between">
                    <span className="text-sm text-muted-foreground">
                      Resolved
                    </span>
                    <div className="flex items-center gap-2">
                      <StatusBadge status="resolved" />
                      <Badge variant="secondary">
                        {stats.tickets.resolved}
                      </Badge>
                    </div>
                  </div>
                </div>
              </BentoGridItem>

              {/* Urgent Tickets */}
              <BentoGridItem
                title="Urgent Tickets"
                description="Requires immediate attention"
                icon={<AlertTriangle className="h-5 w-5" />}
                size="sm"
                badge={stats.tickets.urgent.toString()}
                badgeVariant="destructive"
                interactive
                onClick={() => router.push('/tickets?filter=urgent')}
              >
                <div className="flex items-center gap-2 text-2xl font-bold text-destructive">
                  <Zap className="h-6 w-6" />
                  {stats.tickets.urgent}
                </div>
              </BentoGridItem>

              {/* Performance Metrics */}
              <BentoGridItem
                title="Performance"
                description="Key performance indicators"
                icon={<TrendingUp className="h-5 w-5" />}
                size="lg"
              >
                <div className="grid grid-cols-3 gap-4">
                  <div className="text-center">
                    <div className="text-2xl font-bold text-primary">
                      {stats.performance.avgResponseTime}
                    </div>
                    <div className="text-xs text-muted-foreground">
                      Avg Response
                    </div>
                  </div>
                  <div className="text-center">
                    <div className="text-2xl font-bold text-green-600">
                      {stats.performance.satisfaction > 0
                        ? `${stats.performance.satisfaction}★`
                        : '—'}
                    </div>
                    <div className="text-xs text-muted-foreground">CSAT</div>
                  </div>
                  <div className="text-center">
                    <div className="text-2xl font-bold text-blue-600">
                      {stats.performance.resolution_rate}%
                    </div>
                    <div className="text-xs text-muted-foreground">
                      Resolution Rate
                    </div>
                  </div>
                </div>
              </BentoGridItem>

              {/* Activity Today */}
              <BentoGridItem
                title="Today's Activity"
                description="Tickets handled today"
                icon={<Activity className="h-5 w-5" />}
                size="sm"
                badge={
                  stats.activity.trend === 'up'
                    ? '↗️'
                    : stats.activity.trend === 'down'
                      ? '↘️'
                      : '→'
                }
              >
                <div className="space-y-2">
                  <div className="text-3xl font-bold">
                    {stats.activity.today}
                  </div>
                  <div className="text-sm text-muted-foreground">
                    {stats.activity.thisWeek} this week
                  </div>
                </div>
              </BentoGridItem>

              {/* Quick Actions — role-aware */}
              <BentoGridItem
                title="Quick Actions"
                description="Common tasks and workflows"
                icon={<Zap className="h-5 w-5" />}
                size="md"
              >
                <div className="space-y-2">
                  <Button
                    variant="outline"
                    size="sm"
                    className="w-full justify-start"
                    onClick={() => router.push('/tickets')}
                  >
                    <TicketIcon className="h-4 w-4 mr-2" />
                    {me?.role === 'customer' ? 'My Tickets' : 'All Tickets'}
                  </Button>
                  {['rep', 'admin'].includes(me?.role || '') && (
                    <>
                      <Button
                        variant="outline"
                        size="sm"
                        className="w-full justify-start"
                        onClick={() => router.push('/rep')}
                      >
                        <MessageSquare className="h-4 w-4 mr-2" />
                        Rep Console
                      </Button>
                      <Button
                        variant="outline"
                        size="sm"
                        className="w-full justify-start"
                        onClick={() => router.push('/rep/my-tickets')}
                      >
                        <User className="h-4 w-4 mr-2" />
                        My Tickets
                      </Button>
                    </>
                  )}
                  {me?.role === 'admin' && (
                    <>
                      <Button
                        variant="outline"
                        size="sm"
                        className="w-full justify-start"
                        onClick={() => router.push('/analytics')}
                      >
                        <BarChart3 className="h-4 w-4 mr-2" />
                        Analytics
                      </Button>
                      <Button
                        variant="outline"
                        size="sm"
                        className="w-full justify-start"
                        onClick={() => router.push('/admin')}
                      >
                        <Settings className="h-4 w-4 mr-2" />
                        Admin Panel
                      </Button>
                    </>
                  )}
                  {me?.role === 'customer' && (
                    <Button
                      variant="default"
                      size="sm"
                      className="w-full justify-start"
                      onClick={() => router.push('/tickets?new=1')}
                    >
                      <TicketIcon className="h-4 w-4 mr-2" />
                      New Ticket
                    </Button>
                  )}
                </div>
              </BentoGridItem>

              {/* Recent Activity */}
              <BentoGridItem
                title="Recent Activity"
                description="Latest ticket updates"
                icon={<Clock className="h-5 w-5" />}
                size="lg"
              >
                <div className="space-y-3">
                  {recentActivity.length === 0 ? (
                    <p className="text-sm text-muted-foreground text-center py-2">
                      No recent activity
                    </p>
                  ) : (
                    recentActivity.map(item => (
                      <div
                        key={item.id}
                        className="flex items-center justify-between p-2 rounded-md bg-muted/30 cursor-pointer hover:bg-muted/50 transition-colors"
                        onClick={() => router.push(`/tickets/${item.ticketId}`)}
                      >
                        <div className="flex items-center gap-3 min-w-0">
                          <StatusBadge status={getStatusColor(item.status)} />
                          <div className="min-w-0">
                            <p className="text-sm font-medium truncate max-w-[180px]">
                              {item.detail || item.ticketId.slice(0, 8)}
                            </p>
                            <p className="text-xs text-muted-foreground">
                              {item.action}
                            </p>
                          </div>
                        </div>
                        <div className="text-xs text-muted-foreground whitespace-nowrap ml-2">
                          {item.time}
                        </div>
                      </div>
                    ))
                  )}
                  <Button
                    variant="ghost"
                    size="sm"
                    className="w-full"
                    onClick={() =>
                      router.push(
                        me?.role === 'admin' ? '/admin/tickets' : '/tickets'
                      )
                    }
                  >
                    View All Tickets
                    <ArrowUpRight className="h-4 w-4 ml-2" />
                  </Button>
                </div>
              </BentoGridItem>
            </BentoGrid>
          ) : null}
        </div>
      </main>
    </PageShell>
  );
}
