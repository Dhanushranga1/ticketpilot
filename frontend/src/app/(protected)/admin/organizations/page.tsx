'use client';

import { useEffect, useState, useCallback } from 'react';
import { useRouter } from 'next/navigation';
import api from '@/lib/api-client';
import { useOrganization } from '@/contexts/OrganizationContext';
import { toast } from 'sonner';
import { PageShell } from '@/ui/motion/PageShell';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  Building2,
  Users,
  Plus,
  Pencil,
  UserPlus,
  Trash2,
  ToggleLeft,
  ToggleRight,
  ChevronDown,
  ChevronUp,
  ArrowLeft,
} from 'lucide-react';
import Link from 'next/link';
import { cn } from '@/lib/utils';

interface OrgRow {
  id: string;
  name: string;
  slug: string;
  is_active: boolean;
  created_at: string;
  member_count: number;
  ticket_count: number;
  plan_id?: string;
}

interface OrgMember {
  user_id: string;
  role: string;
  joined_at: string;
  user_email: string | null;
  last_sign_in_at: string | null;
}

const ORG_ROLE_LABELS: Record<string, string> = {
  owner: 'Owner',
  admin: 'Admin',
  rep: 'Support Rep',
  member: 'Client',
};

const roleBadgeClass: Record<string, string> = {
  owner:
    'bg-purple-100 text-purple-800 dark:bg-purple-900/40 dark:text-purple-300',
  admin: 'bg-blue-100 text-blue-800 dark:bg-blue-900/40 dark:text-blue-300',
  rep: 'bg-green-100 text-green-800 dark:bg-green-900/40 dark:text-green-300',
  member: 'bg-gray-100 text-gray-700 dark:bg-zinc-800 dark:text-zinc-300',
};

function timeAgo(s: string | null): string {
  if (!s) return 'Never';
  const diff = Date.now() - new Date(s).getTime();
  const days = Math.floor(diff / 86400000);
  const hours = Math.floor(diff / 3600000);
  if (days > 30) return new Date(s).toLocaleDateString();
  if (days > 0) return `${days}d ago`;
  if (hours > 0) return `${hours}h ago`;
  return `${Math.floor(diff / 60000)}m ago`;
}

export default function AdminOrganizationsPage() {
  const router = useRouter();
  const { currentOrganization } = useOrganization();

  const [orgs, setOrgs] = useState<OrgRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [expandedOrg, setExpandedOrg] = useState<string | null>(null);
  const [membersMap, setMembersMap] = useState<Record<string, OrgMember[]>>({});
  const [membersLoading, setMembersLoading] = useState<string | null>(null);

  // Create org dialog
  const [createDialog, setCreateDialog] = useState(false);
  const [createName, setCreateName] = useState('');
  const [createLoading, setCreateLoading] = useState(false);

  // Edit org dialog
  const [editDialog, setEditDialog] = useState<{
    open: boolean;
    org: OrgRow | null;
  }>({ open: false, org: null });
  const [editName, setEditName] = useState('');
  const [editLoading, setEditLoading] = useState(false);

  // Add member dialog
  const [addMemberDialog, setAddMemberDialog] = useState<{
    open: boolean;
    orgId: string | null;
  }>({ open: false, orgId: null });
  const [addEmail, setAddEmail] = useState('');
  const [addRole, setAddRole] = useState('rep');
  const [addLoading, setAddLoading] = useState(false);

  // Remove member confirmation
  const [removeDialog, setRemoveDialog] = useState<{
    open: boolean;
    orgId: string;
    member: OrgMember | null;
  }>({ open: false, orgId: '', member: null });

  const loadOrgs = useCallback(async () => {
    setLoading(true);
    try {
      const data = await api.get('/api/admin/organizations');
      setOrgs(data);
    } catch (e: any) {
      if (e?.message?.includes('403') || e?.message?.includes('Admin')) {
        router.replace('/dashboard');
      } else {
        toast.error('Failed to load organisations');
      }
    } finally {
      setLoading(false);
    }
  }, [router]);

  useEffect(() => {
    loadOrgs();
  }, [loadOrgs]);

  const loadMembers = async (orgId: string) => {
    if (membersMap[orgId]) return;
    setMembersLoading(orgId);
    try {
      const data = await api.get(`/api/admin/organizations/${orgId}/members`);
      setMembersMap(prev => ({ ...prev, [orgId]: data }));
    } catch {
      toast.error('Failed to load members');
    } finally {
      setMembersLoading(null);
    }
  };

  const toggleExpand = (orgId: string) => {
    if (expandedOrg === orgId) {
      setExpandedOrg(null);
    } else {
      setExpandedOrg(orgId);
      loadMembers(orgId);
    }
  };

  // ── Create org ─────────────────────────────────────────────────────────────
  const handleCreate = async () => {
    if (!createName.trim()) return;
    setCreateLoading(true);
    try {
      await api.post('/api/organizations', { name: createName.trim() });
      toast.success(`Organisation "${createName}" created`);
      setCreateDialog(false);
      setCreateName('');
      await loadOrgs();
    } catch (e: any) {
      toast.error(e?.message || 'Failed to create organisation');
    } finally {
      setCreateLoading(false);
    }
  };

  // ── Edit org ───────────────────────────────────────────────────────────────
  const openEdit = (org: OrgRow) => {
    setEditDialog({ open: true, org });
    setEditName(org.name);
  };

  const handleEdit = async () => {
    if (!editDialog.org) return;
    setEditLoading(true);
    try {
      await api.patch(`/api/admin/organizations/${editDialog.org.id}`, {
        name: editName.trim(),
      });
      toast.success('Organisation renamed');
      setEditDialog({ open: false, org: null });
      await loadOrgs();
    } catch (e: any) {
      toast.error(e?.message || 'Failed to rename organisation');
    } finally {
      setEditLoading(false);
    }
  };

  // ── Toggle active ──────────────────────────────────────────────────────────
  const toggleActive = async (org: OrgRow) => {
    try {
      await api.patch(`/api/admin/organizations/${org.id}`, {
        is_active: !org.is_active,
      });
      toast.success(
        org.is_active ? 'Organisation deactivated' : 'Organisation reactivated'
      );
      await loadOrgs();
    } catch (e: any) {
      toast.error(e?.message || 'Failed to update organisation');
    }
  };

  // ── Plan assignment ────────────────────────────────────────────────────────
  const updatePlan = async (org: OrgRow, planId: string) => {
    try {
      await api.patch(`/api/admin/organizations/${org.id}/plan`, {
        plan_id: planId,
      });
      toast.success(`Plan set to ${planId} for ${org.name}`);
      await loadOrgs();
    } catch (e: any) {
      toast.error(e?.message || 'Failed to update plan');
    }
  };

  // ── Add member ─────────────────────────────────────────────────────────────
  const openAddMember = (orgId: string) => {
    setAddMemberDialog({ open: true, orgId });
    setAddEmail('');
    setAddRole('rep');
  };

  const handleAddMember = async () => {
    if (!addMemberDialog.orgId || !addEmail.trim()) return;
    setAddLoading(true);
    try {
      await api.post(
        `/api/admin/organizations/${addMemberDialog.orgId}/members`,
        {
          email: addEmail.trim(),
          role: addRole,
        }
      );
      toast.success(`Added ${addEmail} as ${ORG_ROLE_LABELS[addRole]}`);
      setAddMemberDialog({ open: false, orgId: null });
      // Refresh members for this org
      const orgId = addMemberDialog.orgId;
      setMembersMap(prev => {
        const next = { ...prev };
        delete next[orgId];
        return next;
      });
      loadMembers(orgId);
    } catch (e: any) {
      toast.error(e?.message || 'Failed to add member');
    } finally {
      setAddLoading(false);
    }
  };

  // ── Change member role ─────────────────────────────────────────────────────
  const handleRoleChange = async (
    orgId: string,
    userId: string,
    newRole: string
  ) => {
    try {
      await api.patch(`/api/admin/organizations/${orgId}/members/${userId}`, {
        role: newRole,
      });
      setMembersMap(prev => ({
        ...prev,
        [orgId]: (prev[orgId] || []).map(m =>
          m.user_id === userId ? { ...m, role: newRole } : m
        ),
      }));
      toast.success('Role updated');
    } catch (e: any) {
      toast.error(e?.message || 'Failed to update role');
    }
  };

  // ── Remove member ──────────────────────────────────────────────────────────
  const confirmRemove = (orgId: string, member: OrgMember) => {
    setRemoveDialog({ open: true, orgId, member });
  };

  const handleRemove = async () => {
    if (!removeDialog.member) return;
    try {
      await api.delete(
        `/api/admin/organizations/${removeDialog.orgId}/members/${removeDialog.member.user_id}`
      );
      toast.success(
        `Removed ${removeDialog.member.user_email ?? removeDialog.member.user_id}`
      );
      const orgId = removeDialog.orgId;
      setMembersMap(prev => ({
        ...prev,
        [orgId]: (prev[orgId] || []).filter(
          m => m.user_id !== removeDialog.member!.user_id
        ),
      }));
      setRemoveDialog({ open: false, orgId: '', member: null });
    } catch (e: any) {
      toast.error(e?.message || 'Failed to remove member');
    }
  };

  return (
    <PageShell>
      <div className="space-y-6">
        {/* Header */}
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <Link
              href="/admin"
              className="text-muted-foreground hover:text-foreground"
            >
              <ArrowLeft className="h-5 w-5" />
            </Link>
            <Building2 className="h-7 w-7 text-primary" />
            <div>
              <h1 className="text-2xl font-bold tracking-tight">
                Organisations
              </h1>
              <p className="text-sm text-muted-foreground">
                Create and manage all organisations on the platform
              </p>
            </div>
          </div>
          <Button onClick={() => setCreateDialog(true)}>
            <Plus className="h-4 w-4 mr-2" />
            New Organisation
          </Button>
        </div>

        {/* Org list */}
        {loading ? (
          <div className="space-y-3">
            {[1, 2, 3].map(i => (
              <div key={i} className="h-20 rounded-lg bg-muted animate-pulse" />
            ))}
          </div>
        ) : orgs.length === 0 ? (
          <Card>
            <CardContent className="flex flex-col items-center justify-center py-16 text-muted-foreground">
              <Building2 className="h-12 w-12 mb-3 opacity-30" />
              <p className="text-sm">No organisations yet</p>
              <Button className="mt-4" onClick={() => setCreateDialog(true)}>
                Create first organisation
              </Button>
            </CardContent>
          </Card>
        ) : (
          <div className="space-y-3">
            {orgs.map(org => (
              <Card
                key={org.id}
                className={cn('border', !org.is_active && 'opacity-60')}
              >
                <CardContent className="py-4 px-5">
                  {/* Org row */}
                  <div className="flex items-center gap-3 flex-wrap">
                    <button
                      onClick={() => toggleExpand(org.id)}
                      className="flex items-center gap-2 flex-1 min-w-0 text-left"
                    >
                      {expandedOrg === org.id ? (
                        <ChevronUp className="h-4 w-4 text-muted-foreground shrink-0" />
                      ) : (
                        <ChevronDown className="h-4 w-4 text-muted-foreground shrink-0" />
                      )}
                      <span className="font-semibold truncate">{org.name}</span>
                      <span className="text-xs text-muted-foreground font-mono">
                        {org.slug}
                      </span>
                      {!org.is_active && (
                        <Badge
                          variant="outline"
                          className="text-xs border-orange-400 text-orange-600"
                        >
                          Inactive
                        </Badge>
                      )}
                    </button>

                    <div className="flex items-center gap-4 text-xs text-muted-foreground shrink-0">
                      <span className="flex items-center gap-1">
                        <Users className="h-3.5 w-3.5" />
                        {org.member_count} member
                        {org.member_count !== 1 ? 's' : ''}
                      </span>
                      <span>
                        {org.ticket_count} ticket
                        {org.ticket_count !== 1 ? 's' : ''}
                      </span>
                    </div>

                    <div className="flex items-center gap-2 shrink-0">
                      <Select
                        value={org.plan_id || 'community'}
                        onValueChange={v => updatePlan(org, v)}
                      >
                        <SelectTrigger className="h-8 w-[110px] text-xs">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="community">Community</SelectItem>
                          <SelectItem value="starter">Starter</SelectItem>
                          <SelectItem value="business">Business</SelectItem>
                          <SelectItem value="enterprise">Enterprise</SelectItem>
                        </SelectContent>
                      </Select>
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => openEdit(org)}
                        title="Rename"
                      >
                        <Pencil className="h-3.5 w-3.5" />
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => toggleActive(org)}
                        title={org.is_active ? 'Deactivate' : 'Reactivate'}
                      >
                        {org.is_active ? (
                          <ToggleRight className="h-4 w-4 text-green-600" />
                        ) : (
                          <ToggleLeft className="h-4 w-4 text-muted-foreground" />
                        )}
                      </Button>
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => openAddMember(org.id)}
                      >
                        <UserPlus className="h-3.5 w-3.5 mr-1" />
                        Add
                      </Button>
                    </div>
                  </div>

                  {/* Members panel */}
                  {expandedOrg === org.id && (
                    <div className="mt-4 border-t pt-4">
                      {membersLoading === org.id ? (
                        <div className="space-y-2">
                          {[1, 2].map(i => (
                            <div
                              key={i}
                              className="h-8 bg-muted animate-pulse rounded"
                            />
                          ))}
                        </div>
                      ) : (membersMap[org.id] || []).length === 0 ? (
                        <p className="text-sm text-muted-foreground">
                          No members yet.
                        </p>
                      ) : (
                        <div className="space-y-2">
                          {(membersMap[org.id] || []).map(m => (
                            <div
                              key={m.user_id}
                              className="flex items-center gap-3 text-sm"
                            >
                              <div className="w-7 h-7 rounded-full bg-primary/10 flex items-center justify-center text-xs font-bold text-primary shrink-0">
                                {(m.user_email ?? '?')[0].toUpperCase()}
                              </div>
                              <span className="flex-1 truncate text-sm">
                                {m.user_email ?? m.user_id}
                              </span>
                              <span className="text-xs text-muted-foreground hidden sm:block">
                                {timeAgo(m.last_sign_in_at)}
                              </span>
                              <Select
                                value={m.role}
                                onValueChange={v =>
                                  handleRoleChange(org.id, m.user_id, v)
                                }
                              >
                                <SelectTrigger
                                  className={cn(
                                    'h-7 w-32 text-xs px-2',
                                    roleBadgeClass[m.role]
                                  )}
                                >
                                  <SelectValue />
                                </SelectTrigger>
                                <SelectContent>
                                  <SelectItem value="owner">Owner</SelectItem>
                                  <SelectItem value="admin">Admin</SelectItem>
                                  <SelectItem value="rep">
                                    Support Rep
                                  </SelectItem>
                                  <SelectItem value="member">Client</SelectItem>
                                </SelectContent>
                              </Select>
                              <Button
                                size="sm"
                                variant="ghost"
                                className="text-red-500 hover:text-red-600 hover:bg-red-50 dark:hover:bg-red-950/20"
                                onClick={() => confirmRemove(org.id, m)}
                              >
                                <Trash2 className="h-3.5 w-3.5" />
                              </Button>
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                  )}
                </CardContent>
              </Card>
            ))}
          </div>
        )}
      </div>

      {/* Create org dialog */}
      <Dialog open={createDialog} onOpenChange={setCreateDialog}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle>New Organisation</DialogTitle>
          </DialogHeader>
          <div className="space-y-4 py-2">
            <div className="space-y-1.5">
              <Label htmlFor="create-name">Organisation name</Label>
              <Input
                id="create-name"
                placeholder="Acme Corp"
                value={createName}
                onChange={e => setCreateName(e.target.value)}
                onKeyDown={e => e.key === 'Enter' && handleCreate()}
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setCreateDialog(false)}>
              Cancel
            </Button>
            <Button
              onClick={handleCreate}
              disabled={createLoading || !createName.trim()}
            >
              {createLoading ? 'Creating…' : 'Create'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Edit org dialog */}
      <Dialog
        open={editDialog.open}
        onOpenChange={open =>
          !open && setEditDialog({ open: false, org: null })
        }
      >
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle>Rename Organisation</DialogTitle>
          </DialogHeader>
          <div className="space-y-4 py-2">
            <div className="space-y-1.5">
              <Label htmlFor="edit-name">New name</Label>
              <Input
                id="edit-name"
                value={editName}
                onChange={e => setEditName(e.target.value)}
                onKeyDown={e => e.key === 'Enter' && handleEdit()}
              />
            </div>
          </div>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setEditDialog({ open: false, org: null })}
            >
              Cancel
            </Button>
            <Button
              onClick={handleEdit}
              disabled={editLoading || !editName.trim()}
            >
              {editLoading ? 'Saving…' : 'Save'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Add member dialog */}
      <Dialog
        open={addMemberDialog.open}
        onOpenChange={open =>
          !open && setAddMemberDialog({ open: false, orgId: null })
        }
      >
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle>Add Member</DialogTitle>
          </DialogHeader>
          <div className="space-y-4 py-2">
            <div className="space-y-1.5">
              <Label htmlFor="add-email">User email</Label>
              <Input
                id="add-email"
                placeholder="rep@example.com"
                value={addEmail}
                onChange={e => setAddEmail(e.target.value)}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="add-role">Role in org</Label>
              <Select value={addRole} onValueChange={setAddRole}>
                <SelectTrigger id="add-role">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="rep">Support Rep</SelectItem>
                  <SelectItem value="admin">Admin</SelectItem>
                  <SelectItem value="member">Client</SelectItem>
                  <SelectItem value="owner">Owner</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setAddMemberDialog({ open: false, orgId: null })}
            >
              Cancel
            </Button>
            <Button
              onClick={handleAddMember}
              disabled={addLoading || !addEmail.trim()}
            >
              {addLoading ? 'Adding…' : 'Add Member'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Remove confirmation dialog */}
      <Dialog
        open={removeDialog.open}
        onOpenChange={open =>
          !open && setRemoveDialog({ open: false, orgId: '', member: null })
        }
      >
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle>Remove Member</DialogTitle>
          </DialogHeader>
          <p className="text-sm text-muted-foreground py-2">
            Remove{' '}
            <strong>{removeDialog.member?.user_email ?? 'this member'}</strong>{' '}
            from this organisation? Their tickets and messages remain.
          </p>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() =>
                setRemoveDialog({ open: false, orgId: '', member: null })
              }
            >
              Cancel
            </Button>
            <Button variant="destructive" onClick={handleRemove}>
              Remove
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </PageShell>
  );
}
