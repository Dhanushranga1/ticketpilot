'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { supabase } from '@/lib/supabaseClient';
import { useOrganization } from '@/contexts/OrganizationContext';
import api from '@/lib/api-client';
import { toast } from 'sonner';

const API_BASE = (
  process.env.NEXT_PUBLIC_API_URL ||
  process.env.NEXT_PUBLIC_API_BASE ||
  'http://127.0.0.1:8000'
).replace(/\/$/, '');
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import {
  Settings,
  Save,
  RefreshCw,
  Mail,
  Bell,
  Shield,
  Database,
  Globe,
  Clock,
  AlertCircle,
  UserCheck,
  Zap,
  Brain,
} from 'lucide-react';

export default function AdminSettingsPage() {
  const router = useRouter();
  const { currentOrganization } = useOrganization();
  const orgId = currentOrganization?.id;
  const [user, setUser] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [diagnosticsLoading, setDiagnosticsLoading] = useState(false);
  const [diagnosticsData, setDiagnosticsData] = useState<any>(null);
  const [settings, setSettings] = useState({
    siteTitle: 'TicketPilot',
    siteDomain: 'localhost:3000',
    emailNotifications: true,
    autoAssignTickets: true,
    requireApproval: true,
    maxFileSize: '10',
    sessionTimeout: '24',
  });

  const PRIORITY_LABELS: Record<number, string> = {
    1: 'P1 — Lowest (default 168 hrs / 1 week)',
    2: 'P2 — Very Low (default 72 hrs / 3 days)',
    3: 'P3 — Low (default 48 hrs / 2 days)',
    4: 'P4 — Normal (default 24 hrs / 1 day)',
    5: 'P5 — High (default 12 hrs)',
    6: 'P6 — Very High (default 6 hrs)',
    7: 'P7 — Critical (default 7 hrs)',
  };
  const PRIORITY_DEFAULTS: Record<number, number> = {
    1: 168,
    2: 72,
    3: 48,
    4: 24,
    5: 12,
    6: 6,
    7: 7,
  };

  // Attention thresholds — how long before a ticket at each priority level gets flagged
  const [thresholds, setThresholds] = useState<Record<number, string>>(
    Object.fromEntries(
      Object.entries(PRIORITY_DEFAULTS).map(([k, v]) => [Number(k), String(v)])
    )
  );
  const [thresholdsSaving, setThresholdsSaving] = useState(false);

  // Overdue / notification settings — persisted in org settings JSONB
  const [overdueSettings, setOverdueSettings] = useState({
    overdue_threshold_hours: '48',
    overdue_reminder_hours: '24',
  });
  const [overdueSaving, setOverdueSaving] = useState(false);

  // Default ETR (Expected Time to Resolution) — applied to every new ticket
  const [defaultEtrHours, setDefaultEtrHours] = useState('');
  const [etrSaving, setEtrSaving] = useState(false);

  // Auto-assign on create — persisted in org settings
  const [autoAssignOnCreate, setAutoAssignOnCreate] = useState(false);
  const [autoAssignSaving, setAutoAssignSaving] = useState(false);

  // Rep workload + bulk auto-assign
  const [workload, setWorkload] = useState<
    { user_id: string; email: string; open_tickets: number }[]
  >([]);
  const [totalUnassigned, setTotalUnassigned] = useState(0);
  const [bulkAssigning, setBulkAssigning] = useState(false);

  // Load all org settings once auth + org are ready
  useEffect(() => {
    if (!orgId || !user) return;
    api
      .get(`/api/organizations/${orgId}`, orgId)
      .then((data: any) => {
        const s = data.settings || {};
        setOverdueSettings({
          overdue_threshold_hours: String(s.overdue_threshold_hours ?? 48),
          overdue_reminder_hours: String(s.overdue_reminder_hours ?? 24),
        });
        if (s.default_etr_hours != null)
          setDefaultEtrHours(String(s.default_etr_hours));
        setAutoAssignOnCreate(!!s.auto_assign_on_create);
        const at = s.attention_thresholds || {};
        setThresholds(
          Object.fromEntries(
            [1, 2, 3, 4, 5, 6, 7].map(lvl => [
              lvl,
              String(at[lvl] ?? PRIORITY_DEFAULTS[lvl]),
            ])
          )
        );
      })
      .catch(() => {});

    // Load rep workload
    api
      .get<{
        reps: { user_id: string; email: string; open_tickets: number }[];
        total_unassigned: number;
      }>('/api/rep/workload', orgId)
      .then(d => {
        setWorkload(d.reps);
        setTotalUnassigned(d.total_unassigned);
      })
      .catch(() => {});
  }, [orgId, user]);

  // Merge-safe patch helper — fetches current settings before saving
  const patchOrgSettings = async (patch: Record<string, unknown>) => {
    const current: any = await api.get(`/api/organizations/${orgId}`, orgId);
    await api.patch(
      `/api/organizations/${orgId}`,
      {
        settings: { ...(current.settings || {}), ...patch },
      },
      orgId
    );
  };

  const saveOverdueSettings = async () => {
    if (!orgId) return;
    try {
      setOverdueSaving(true);
      await patchOrgSettings({
        overdue_threshold_hours:
          Number(overdueSettings.overdue_threshold_hours) || 48,
        overdue_reminder_hours:
          Number(overdueSettings.overdue_reminder_hours) || 24,
      });
      toast.success('Overdue settings saved');
    } catch {
      toast.error('Failed to save settings');
    } finally {
      setOverdueSaving(false);
    }
  };

  const saveThresholds = async () => {
    if (!orgId) return;
    try {
      setThresholdsSaving(true);
      await patchOrgSettings({
        attention_thresholds: Object.fromEntries(
          [1, 2, 3, 4, 5, 6, 7].map(lvl => [
            lvl,
            Number(thresholds[lvl]) || PRIORITY_DEFAULTS[lvl],
          ])
        ),
      });
      toast.success('Attention thresholds saved');
    } catch {
      toast.error('Failed to save settings');
    } finally {
      setThresholdsSaving(false);
    }
  };

  const saveAutoAssign = async (value: boolean) => {
    if (!orgId) return;
    try {
      setAutoAssignSaving(true);
      setAutoAssignOnCreate(value);
      await patchOrgSettings({ auto_assign_on_create: value });
      toast.success(value ? 'Auto-assign enabled' : 'Auto-assign disabled');
    } catch {
      toast.error('Failed to save setting');
      setAutoAssignOnCreate(!value); // revert
    } finally {
      setAutoAssignSaving(false);
    }
  };

  const runBulkAutoAssign = async () => {
    if (!orgId) return;
    try {
      setBulkAssigning(true);
      const result = await api.post<{
        assigned: number;
        details: { assigned_to: string }[];
      }>('/api/admin/auto-assign', {}, orgId);
      if (result.assigned === 0) {
        toast.info('No unassigned tickets to assign');
      } else {
        toast.success(
          `Assigned ${result.assigned} ticket${result.assigned !== 1 ? 's' : ''} across your team`
        );
      }
      // Refresh workload
      api
        .get<{
          reps: { user_id: string; email: string; open_tickets: number }[];
          total_unassigned: number;
        }>('/api/rep/workload', orgId)
        .then(d => {
          setWorkload(d.reps);
          setTotalUnassigned(d.total_unassigned);
        })
        .catch(() => {});
    } catch {
      toast.error('Auto-assign failed');
    } finally {
      setBulkAssigning(false);
    }
  };

  const saveEtrSettings = async () => {
    if (!orgId) return;
    try {
      setEtrSaving(true);
      await patchOrgSettings({
        default_etr_hours: defaultEtrHours ? Number(defaultEtrHours) : null,
      });
      toast.success('Default resolution time saved');
    } catch {
      toast.error('Failed to save settings');
    } finally {
      setEtrSaving(false);
    }
  };

  useEffect(() => {
    const checkAuth = async () => {
      try {
        const { data: sessionData } = await supabase.auth.getSession();
        const token = sessionData?.session?.access_token;

        if (!token) {
          router.push('/login');
          return;
        }

        const response = await fetch(`${API_BASE}/api/me`, {
          headers: { Authorization: `Bearer ${token}` },
        });

        if (response.ok) {
          const userData = await response.json();
          if (userData.role !== 'admin') {
            router.push('/dashboard');
            return;
          }
          setUser(userData);
        } else {
          await supabase.auth.signOut();
          router.push('/login');
        }
      } catch {
        await supabase.auth.signOut();
        router.push('/login');
      } finally {
        setLoading(false);
      }
    };

    checkAuth();
  }, [router]);

  const [generalSaving, setGeneralSaving] = useState(false);

  const handleSaveSettings = async () => {
    if (!orgId) return;
    setGeneralSaving(true);
    try {
      await patchOrgSettings({
        site_title: settings.siteTitle,
        site_domain: settings.siteDomain,
        session_timeout_hours: Number(settings.sessionTimeout) || 24,
        require_approval: settings.requireApproval,
        max_file_size_mb: Number(settings.maxFileSize) || 10,
        email_notifications: settings.emailNotifications,
      });
      toast.success('Settings saved');
    } catch {
      toast.error('Failed to save settings');
    } finally {
      setGeneralSaving(false);
    }
  };

  const testEmail = async () => {
    try {
      await api.post('/api/admin/test-email', {}, orgId);
      toast.success('Test email sent — check your inbox');
    } catch {
      toast.info('Email test skipped (no SMTP key configured)');
    }
  };

  const clearCache = async () => {
    try {
      await api.get('/api/wake');
      toast.success('Server cache cleared and connections re-warmed');
    } catch {
      toast.error('Cache clear failed');
    }
  };

  const loadDiagnostics = async () => {
    setDiagnosticsLoading(true);
    try {
      const { data: sessionData } = await supabase.auth.getSession();
      const token = sessionData?.session?.access_token;

      const response = await fetch(`${API_BASE}/api/admin/diagnostics/db`, {
        headers: { Authorization: `Bearer ${token}` },
      });

      if (response.ok) {
        const data = await response.json();
        setDiagnosticsData(data);
      }
    } catch {
      // diagnostics are non-critical
    } finally {
      setDiagnosticsLoading(false);
    }
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary"></div>
      </div>
    );
  }

  if (!user || user.role !== 'admin') {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="text-center">
          <h2 className="text-xl font-semibold mb-2">Access Denied</h2>
          <p className="text-muted-foreground">
            You don't have permission to access this page.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <Settings className="h-8 w-8 text-primary" />
          <div>
            <h1 className="text-3xl font-bold tracking-tight">
              System Settings
            </h1>
            <p className="text-muted-foreground">
              Configure system-wide settings and preferences
            </p>
          </div>
        </div>
        <div className="flex gap-2">
          <Button
            variant="outline"
            onClick={() => router.push('/admin/settings/ai')}
          >
            <Brain className="h-4 w-4 mr-2" />
            AI Settings
          </Button>
          <Button onClick={handleSaveSettings} disabled={generalSaving}>
            <Save className="h-4 w-4 mr-2" />
            {generalSaving ? 'Saving…' : 'Save Changes'}
          </Button>
        </div>
      </div>

      <div className="grid gap-6 md:grid-cols-2">
        {/* General Settings */}
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Globe className="h-5 w-5" />
              General Settings
            </CardTitle>
            <CardDescription>Basic site configuration</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="siteTitle">Site Title</Label>
              <Input
                id="siteTitle"
                value={settings.siteTitle}
                onChange={e =>
                  setSettings({ ...settings, siteTitle: e.target.value })
                }
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="siteDomain">Site Domain</Label>
              <Input
                id="siteDomain"
                value={settings.siteDomain}
                onChange={e =>
                  setSettings({ ...settings, siteDomain: e.target.value })
                }
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="sessionTimeout">Session Timeout (hours)</Label>
              <Input
                id="sessionTimeout"
                type="number"
                value={settings.sessionTimeout}
                onChange={e =>
                  setSettings({ ...settings, sessionTimeout: e.target.value })
                }
              />
            </div>
          </CardContent>
        </Card>

        {/* Notification Settings */}
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Bell className="h-5 w-5" />
              Notifications
            </CardTitle>
            <CardDescription>
              Email and notification preferences
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="flex items-center justify-between">
              <div className="space-y-0.5">
                <Label>Email Notifications</Label>
                <p className="text-sm text-muted-foreground">
                  Send email notifications for new tickets
                </p>
              </div>
              <Switch
                checked={settings.emailNotifications}
                onCheckedChange={(checked: boolean) =>
                  setSettings({ ...settings, emailNotifications: checked })
                }
              />
            </div>
            <div className="flex items-center justify-between">
              <div className="space-y-0.5">
                <Label>Auto-assign Tickets</Label>
                <p className="text-sm text-muted-foreground">
                  Automatically assign tickets to available reps
                </p>
              </div>
              <Switch
                checked={autoAssignOnCreate}
                disabled={autoAssignSaving}
                onCheckedChange={saveAutoAssign}
              />
            </div>
          </CardContent>
        </Card>

        {/* Security Settings */}
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Shield className="h-5 w-5" />
              Security
            </CardTitle>
            <CardDescription>
              Security and access control settings
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="flex items-center justify-between">
              <div className="space-y-0.5">
                <Label>Require Role Approval</Label>
                <p className="text-sm text-muted-foreground">
                  Admin approval required for role changes
                </p>
              </div>
              <Switch
                checked={settings.requireApproval}
                onCheckedChange={(checked: boolean) =>
                  setSettings({ ...settings, requireApproval: checked })
                }
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="maxFileSize">Max File Upload Size (MB)</Label>
              <Input
                id="maxFileSize"
                type="number"
                value={settings.maxFileSize}
                onChange={e =>
                  setSettings({ ...settings, maxFileSize: e.target.value })
                }
              />
            </div>
          </CardContent>
        </Card>

      </div>

      {/* Attention Thresholds */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <AlertCircle className="h-5 w-5" />
            Attention Thresholds (Priority Levels)
          </CardTitle>
          <CardDescription>
            How long a ticket at each priority level can sit open before it is
            auto-flagged as "Needs Attention". Priority 1 is lowest urgency, 7
            is most critical.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
            {([1, 2, 3, 4, 5, 6, 7] as const).map(lvl => (
              <div key={lvl} className="space-y-1.5">
                <Label
                  htmlFor={`threshold-p${lvl}`}
                  className="text-xs font-medium"
                >
                  {PRIORITY_LABELS[lvl]}
                </Label>
                <div className="flex items-center gap-1.5">
                  <Input
                    id={`threshold-p${lvl}`}
                    type="number"
                    min={1}
                    value={thresholds[lvl]}
                    onChange={e =>
                      setThresholds(prev => ({
                        ...prev,
                        [lvl]: e.target.value,
                      }))
                    }
                    className="h-8 text-sm"
                  />
                  <span className="text-xs text-muted-foreground whitespace-nowrap">
                    hrs
                  </span>
                </div>
              </div>
            ))}
          </div>
          <Button
            onClick={saveThresholds}
            disabled={thresholdsSaving}
            size="sm"
          >
            <Save className="h-4 w-4 mr-2" />
            {thresholdsSaving ? 'Saving…' : 'Save Thresholds'}
          </Button>
        </CardContent>
      </Card>

      {/* Overdue & Email Notification Settings */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Clock className="h-5 w-5" />
            Overdue &amp; Notification Settings
          </CardTitle>
          <CardDescription>
            Configure when tickets are marked overdue and how often reminder
            emails are sent. Changes are saved to your organisation and picked
            up by the next background scan (runs every 15 min).
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-6">
          <div className="grid gap-6 sm:grid-cols-2">
            <div className="space-y-2">
              <Label htmlFor="overdue-threshold">
                Mark ticket overdue after (hours)
              </Label>
              <Input
                id="overdue-threshold"
                type="number"
                min={1}
                value={overdueSettings.overdue_threshold_hours}
                onChange={e =>
                  setOverdueSettings(prev => ({
                    ...prev,
                    overdue_threshold_hours: e.target.value,
                  }))
                }
              />
              <p className="text-xs text-muted-foreground">
                Tickets open longer than this are flagged overdue and an email
                is sent to the assigned rep. Default: 48 hrs.
              </p>
            </div>
            <div className="space-y-2">
              <Label htmlFor="overdue-reminder">
                Send reminder every (hours)
              </Label>
              <Input
                id="overdue-reminder"
                type="number"
                min={1}
                value={overdueSettings.overdue_reminder_hours}
                onChange={e =>
                  setOverdueSettings(prev => ({
                    ...prev,
                    overdue_reminder_hours: e.target.value,
                  }))
                }
              />
              <p className="text-xs text-muted-foreground">
                How often to re-send the overdue reminder until the ticket is
                resolved. Default: 24 hrs.
              </p>
            </div>
          </div>

          <div className="flex items-center gap-3 p-3 rounded-lg bg-amber-50 border border-amber-200 text-amber-800 text-sm">
            <AlertCircle className="h-4 w-4 shrink-0" />
            <span>
              Make sure{' '}
              <code className="font-mono bg-amber-100 px-1 rounded">
                RESEND_API_KEY
              </code>{' '}
              is set in the backend
              <code className="font-mono bg-amber-100 px-1 rounded mx-1">
                .env
              </code>{' '}
              for emails to send.
            </span>
          </div>

          <Button onClick={saveOverdueSettings} disabled={overdueSaving}>
            <Save className="h-4 w-4 mr-2" />
            {overdueSaving ? 'Saving…' : 'Save Notification Settings'}
          </Button>
        </CardContent>
      </Card>

      {/* Default Resolution Time */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Clock className="h-5 w-5" />
            Default Resolution Time
          </CardTitle>
          <CardDescription>
            Automatically set an expected resolution deadline on every new
            ticket. When the deadline passes without resolution, the assigned
            rep receives an email notification. Leave blank to disable.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex items-end gap-3 max-w-xs">
            <div className="flex-1 space-y-2">
              <Label htmlFor="default-etr">Hours to resolve</Label>
              <Input
                id="default-etr"
                type="number"
                min={1}
                placeholder="e.g. 24"
                value={defaultEtrHours}
                onChange={e => setDefaultEtrHours(e.target.value)}
              />
            </div>
            <Button onClick={saveEtrSettings} disabled={etrSaving}>
              <Save className="h-4 w-4 mr-2" />
              {etrSaving ? 'Saving…' : 'Save'}
            </Button>
          </div>
          <p className="text-xs text-muted-foreground">
            Example: <strong>24</strong> = tickets must be resolved within 24
            hours of creation. Reps see the deadline in the Rep Console queue.
          </p>
        </CardContent>
      </Card>

      {/* Assignment Settings */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <UserCheck className="h-5 w-5" />
            Ticket Assignment
          </CardTitle>
          <CardDescription>
            Control how tickets are routed to reps. Auto-assign distributes work
            to whoever has the lowest open ticket count.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-6">
          {/* Toggle */}
          <div className="flex items-center justify-between">
            <div className="space-y-0.5">
              <Label>Auto-assign on creation</Label>
              <p className="text-sm text-muted-foreground">
                Every new ticket is immediately assigned to the least-loaded rep
              </p>
            </div>
            <Switch
              checked={autoAssignOnCreate}
              disabled={autoAssignSaving}
              onCheckedChange={saveAutoAssign}
            />
          </div>

          {/* Workload table */}
          {workload.length > 0 && (
            <div className="space-y-2">
              <p className="text-sm font-medium">Current rep workload</p>
              <div className="rounded-lg border border-border overflow-hidden">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="bg-[rgb(var(--surface2))] text-muted-foreground text-xs uppercase">
                      <th className="px-3 py-2 text-left">Rep</th>
                      <th className="px-3 py-2 text-left">Role</th>
                      <th className="px-3 py-2 text-right">Open tickets</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-border">
                    {workload.map(r => (
                      <tr
                        key={r.user_id}
                        className="hover:bg-[rgb(var(--surface2))] transition-colors"
                      >
                        <td className="px-3 py-2 font-medium">{r.email}</td>
                        <td className="px-3 py-2 text-muted-foreground capitalize">
                          {(r as any).role}
                        </td>
                        <td className="px-3 py-2 text-right">
                          <span
                            className={`font-semibold ${r.open_tickets > 10 ? 'text-red-400' : r.open_tickets > 5 ? 'text-amber-400' : 'text-green-400'}`}
                          >
                            {r.open_tickets}
                          </span>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <p className="text-xs text-muted-foreground">
                {totalUnassigned} unassigned open ticket
                {totalUnassigned !== 1 ? 's' : ''}
              </p>
            </div>
          )}

          {/* Bulk assign button */}
          <div className="flex items-center gap-3">
            <Button
              variant="outline"
              disabled={bulkAssigning || totalUnassigned === 0}
              onClick={runBulkAutoAssign}
            >
              <Zap className="h-4 w-4 mr-2" />
              {bulkAssigning
                ? 'Assigning…'
                : `Auto-assign ${totalUnassigned > 0 ? `${totalUnassigned} ` : ''}unassigned tickets`}
            </Button>
            {totalUnassigned === 0 && (
              <span className="text-xs text-muted-foreground">
                All tickets are assigned
              </span>
            )}
          </div>
        </CardContent>
      </Card>

      {/* Database Diagnostics */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Database className="h-5 w-5" />
            Database Diagnostics
          </CardTitle>
          <CardDescription>
            System health and database information
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex gap-4 mb-4">
            <Button
              onClick={loadDiagnostics}
              disabled={diagnosticsLoading}
              variant="outline"
            >
              {diagnosticsLoading ? (
                <RefreshCw className="h-4 w-4 mr-2 animate-spin" />
              ) : (
                <Database className="h-4 w-4 mr-2" />
              )}
              {diagnosticsLoading ? 'Loading...' : 'Run Diagnostics'}
            </Button>
          </div>

          {diagnosticsData && (
            <div className="space-y-4">
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <div className="space-y-2">
                  <Label className="text-sm font-medium">
                    Database Version
                  </Label>
                  <p className="text-sm text-muted-foreground">
                    {diagnosticsData.database_version}
                  </p>
                </div>
                <div className="space-y-2">
                  <Label className="text-sm font-medium">Last Check</Label>
                  <p className="text-sm text-muted-foreground">
                    {new Date(diagnosticsData.timestamp).toLocaleString()}
                  </p>
                </div>
              </div>

              <div className="space-y-2">
                <Label className="text-sm font-medium">Table Counts</Label>
                <div className="grid grid-cols-2 md:grid-cols-4 gap-2 text-sm">
                  {Object.entries(diagnosticsData.table_counts || {}).map(
                    ([table, count]) => (
                      <div
                        key={table}
                        className="flex justify-between p-2 bg-muted rounded"
                      >
                        <span className="font-mono">{table}</span>
                        <span className="font-semibold">{String(count)}</span>
                      </div>
                    )
                  )}
                </div>
              </div>

              <div className="space-y-2">
                <Label className="text-sm font-medium">
                  Installed Extensions
                </Label>
                <div className="flex flex-wrap gap-1">
                  {diagnosticsData.extensions?.map((ext: string) => (
                    <span
                      key={ext}
                      className="px-2 py-1 bg-blue-100 text-blue-800 rounded text-xs"
                    >
                      {ext}
                    </span>
                  ))}
                </div>
              </div>
            </div>
          )}
        </CardContent>
      </Card>

      {/* Quick Actions */}
      <Card>
        <CardHeader>
          <CardTitle>Quick Actions</CardTitle>
          <CardDescription>Common administrative tasks</CardDescription>
        </CardHeader>
        <CardContent>
          <div className="flex gap-4 flex-wrap">
            <Button variant="outline" onClick={clearCache}>
              <RefreshCw className="h-4 w-4 mr-2" />
              Clear Cache
            </Button>
            <Button
              variant="outline"
              onClick={() =>
                toast.info(
                  'Database backups are managed automatically by Supabase. Check your Supabase dashboard → Backups.'
                )
              }
            >
              <Database className="h-4 w-4 mr-2" />
              Backup Info
            </Button>
            <Button variant="outline" onClick={testEmail}>
              <Mail className="h-4 w-4 mr-2" />
              Test Email
            </Button>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
