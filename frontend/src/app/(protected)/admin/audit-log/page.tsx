'use client';

import { useEffect, useState, useCallback } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useOrganization } from '@/contexts/OrganizationContext';
import api from '@/lib/api-client';
import { toast } from 'sonner';
import { PageShell } from '@/ui/motion/PageShell';
import { Card, CardContent } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Shield, Search, ArrowLeft, RefreshCw, Download } from 'lucide-react';

interface AuditEntry {
  id: string;
  actor_id: string;
  actor_email: string;
  action: string;
  resource_type: string;
  resource_id: string;
  org_id: string | null;
  metadata: Record<string, any>;
  created_at: string;
}

interface OrgOption {
  id: string;
  name: string;
}

const ACTION_COLORS: Record<string, string> = {
  'ticket.accepted':
    'bg-green-100 text-green-800 dark:bg-green-900/30 dark:text-green-300',
  'ticket.escalated':
    'bg-red-100 text-red-800 dark:bg-red-900/30 dark:text-red-300',
  'ticket.status.resolved':
    'bg-emerald-100 text-emerald-800 dark:bg-emerald-900/30 dark:text-emerald-300',
  'ticket.status.closed':
    'bg-zinc-200 text-zinc-700 dark:bg-zinc-800 dark:text-zinc-300',
  'org.member.added':
    'bg-blue-100 text-blue-800 dark:bg-blue-900/30 dark:text-blue-300',
  'org.member.removed':
    'bg-orange-100 text-orange-800 dark:bg-orange-900/30 dark:text-orange-300',
};

function actionBadgeClass(action: string): string {
  return ACTION_COLORS[action] ?? 'bg-muted text-muted-foreground';
}

function formatDate(s: string): string {
  return new Date(s).toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function exportCsv(entries: AuditEntry[]) {
  const headers = [
    'timestamp',
    'actor_email',
    'action',
    'resource_type',
    'resource_id',
    'org_id',
    'metadata',
  ];
  const rows = entries.map(e =>
    [
      e.created_at,
      e.actor_email || '',
      e.action,
      e.resource_type || '',
      e.resource_id || '',
      e.org_id || '',
      JSON.stringify(e.metadata || {}),
    ]
      .map(v => `"${String(v).replace(/"/g, '""')}"`)
      .join(',')
  );
  const csv = [headers.join(','), ...rows].join('\n');
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `audit-log-${new Date().toISOString().slice(0, 10)}.csv`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

export default function AuditLogPage() {
  const router = useRouter();
  const { user } = useOrganization();
  const [entries, setEntries] = useState<AuditEntry[]>([]);
  const [orgs, setOrgs] = useState<OrgOption[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [note, setNote] = useState<string | null>(null);

  useEffect(() => {
    if (user && user.role !== 'admin') {
      router.replace('/dashboard');
    }
  }, [user, router]);

  if (!user || user.role !== 'admin') {
    return null;
  }

  const [selectedOrg, setSelectedOrg] = useState('all');
  const [actionFilter, setActionFilter] = useState('');
  const [actorFilter, setActorFilter] = useState('');
  const [offset, setOffset] = useState(0);
  const limit = 50;

  const loadOrgs = useCallback(async () => {
    try {
      const data = await api.get('/api/admin/organizations');
      setOrgs(data.map((o: any) => ({ id: o.id, name: o.name })));
    } catch {
      /* non-fatal */
    }
  }, []);

  const loadLog = useCallback(async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams({
        offset: String(offset),
        limit: String(limit),
      });
      if (selectedOrg !== 'all') params.set('org_id', selectedOrg);
      if (actionFilter) params.set('action', actionFilter);
      if (actorFilter) params.set('actor_email', actorFilter);
      const data = await api.get(`/api/admin/audit-log?${params}`);
      setEntries(data.items);
      setTotal(data.total);
      setNote(data.note ?? null);
    } catch (e: any) {
      toast.error('Failed to load audit log');
    } finally {
      setLoading(false);
    }
  }, [selectedOrg, actionFilter, actorFilter, offset]);

  useEffect(() => {
    loadOrgs();
  }, [loadOrgs]);
  useEffect(() => {
    loadLog();
  }, [loadLog]);

  return (
    <PageShell>
      <div className="space-y-5">
        {/* Header */}
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <Link
              href="/admin"
              className="text-muted-foreground hover:text-foreground"
            >
              <ArrowLeft className="h-5 w-5" />
            </Link>
            <Shield className="h-6 w-6 text-primary" />
            <div>
              <h1 className="text-2xl font-bold tracking-tight">Audit Log</h1>
              <p className="text-sm text-muted-foreground">
                Platform-wide action history · {total} events
              </p>
            </div>
          </div>
          <div className="flex gap-2">
            <Button
              variant="outline"
              size="sm"
              onClick={() => exportCsv(entries)}
              disabled={entries.length === 0}
              title="Export to CSV"
            >
              <Download className="h-4 w-4" />
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={loadLog}
              disabled={loading}
            >
              <RefreshCw
                className={`h-4 w-4 ${loading ? 'animate-spin' : ''}`}
              />
            </Button>
          </div>
        </div>

        {note && (
          <Card className="border-amber-300 bg-amber-50 dark:bg-amber-950/20">
            <CardContent className="py-3 px-4 text-sm text-amber-700 dark:text-amber-400">
              {note}
            </CardContent>
          </Card>
        )}

        {/* Filters */}
        <div className="flex flex-wrap items-center gap-3">
          <Select
            value={selectedOrg}
            onValueChange={v => {
              setSelectedOrg(v);
              setOffset(0);
            }}
          >
            <SelectTrigger className="w-44">
              <SelectValue placeholder="All orgs" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All organisations</SelectItem>
              {orgs.map(o => (
                <SelectItem key={o.id} value={o.id}>
                  {o.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>

          <div className="relative">
            <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
            <Input
              placeholder="Filter by action…"
              value={actionFilter}
              onChange={e => {
                setActionFilter(e.target.value);
                setOffset(0);
              }}
              className="pl-8 w-44 h-9"
            />
          </div>

          <div className="relative">
            <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
            <Input
              placeholder="Filter by actor email…"
              value={actorFilter}
              onChange={e => {
                setActorFilter(e.target.value);
                setOffset(0);
              }}
              className="pl-8 w-48 h-9"
            />
          </div>
        </div>

        {/* Log entries */}
        {loading ? (
          <div className="space-y-2">
            {[1, 2, 3, 4, 5].map(i => (
              <div key={i} className="h-14 rounded-lg bg-muted animate-pulse" />
            ))}
          </div>
        ) : entries.length === 0 ? (
          <Card>
            <CardContent className="flex flex-col items-center py-16 text-muted-foreground">
              <Shield className="h-10 w-10 mb-3 opacity-30" />
              <p className="text-sm">No audit events recorded yet</p>
            </CardContent>
          </Card>
        ) : (
          <div className="space-y-1.5">
            {entries.map(e => (
              <Card key={e.id} className="border-border/50">
                <CardContent className="py-2.5 px-4">
                  <div className="flex items-center gap-3 flex-wrap">
                    <Badge
                      className={`text-xs shrink-0 ${actionBadgeClass(e.action)}`}
                    >
                      {e.action}
                    </Badge>
                    <span className="text-sm text-muted-foreground truncate flex-1 min-w-0">
                      <span className="text-foreground font-medium">
                        {e.actor_email || 'system'}
                      </span>
                      {e.resource_type && (
                        <>
                          {' '}
                          ·{' '}
                          <span className="font-mono text-xs">
                            {e.resource_type}/{e.resource_id?.slice(0, 8)}
                          </span>
                        </>
                      )}
                      {Object.keys(e.metadata || {}).length > 0 && (
                        <>
                          {' '}
                          ·{' '}
                          <span className="text-xs">
                            {JSON.stringify(e.metadata)}
                          </span>
                        </>
                      )}
                    </span>
                    <span className="text-xs text-muted-foreground shrink-0">
                      {formatDate(e.created_at)}
                    </span>
                  </div>
                </CardContent>
              </Card>
            ))}
          </div>
        )}

        {/* Pagination */}
        {total > limit && (
          <div className="flex justify-center items-center gap-4 pt-2">
            <Button
              variant="outline"
              size="sm"
              onClick={() => setOffset(Math.max(0, offset - limit))}
              disabled={offset === 0}
            >
              Previous
            </Button>
            <span className="text-sm text-muted-foreground">
              {offset + 1}–{Math.min(offset + limit, total)} of {total}
            </span>
            <Button
              variant="outline"
              size="sm"
              onClick={() => setOffset(offset + limit)}
              disabled={offset + limit >= total}
            >
              Next
            </Button>
          </div>
        )}
      </div>
    </PageShell>
  );
}
