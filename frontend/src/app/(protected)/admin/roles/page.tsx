'use client';

import { useState, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { toast } from 'sonner';
import { supabase } from '@/lib/supabaseClient';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import {
  Users,
  UserCheck,
  Clock,
  Search,
  Shield,
  UserX,
  CheckCircle,
  XCircle,
  RefreshCw,
} from 'lucide-react';

interface User {
  id: string;
  email: string;
  role: 'rep' | 'admin';
  created_at: string;
  last_login?: string;
  is_active: boolean;
}

interface UserActivity {
  id: string;
  user_id: string;
  action: string;
  timestamp: string;
  details?: string;
}

interface UserStats {
  total_users: number;
  active_users: number;
  total_admins: number;
  active_admins: number;
  recent_signups: number;
}

const API_BASE = process.env.NEXT_PUBLIC_API_BASE || 'http://127.0.0.1:8000';

export default function AdminRolesPage() {
  const router = useRouter();
  const [users, setUsers] = useState<User[]>([]);
  const [userActivities, setUserActivities] = useState<UserActivity[]>([]);
  const [stats, setStats] = useState<UserStats | null>(null);
  const [loading, setLoading] = useState(true);
  const [searchTerm, setSearchTerm] = useState('');
  const [processingUsers, setProcessingUsers] = useState<Set<string>>(
    new Set()
  );
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  useEffect(() => {
    loadData();
  }, []);

  // Clear success message after 3 seconds
  useEffect(() => {
    if (success) {
      const timer = setTimeout(() => setSuccess(null), 3000);
      return () => clearTimeout(timer);
    }
  }, [success]);

  // Clear error message after 5 seconds
  useEffect(() => {
    if (error) {
      const timer = setTimeout(() => setError(null), 5000);
      return () => clearTimeout(timer);
    }
  }, [error]);

  const loadData = async () => {
    try {
      setLoading(true);
      setError(null); // Clear any previous errors
      await loadUsers();
      // loadUserStats will be called after users are loaded
      // Load activity after users are loaded so we have user data
    } catch (error) {
      console.error('Error loading data:', error);
      setError('Failed to load data');
    } finally {
      setLoading(false);
    }
  };

  const loadUsers = async () => {
    try {
      console.log('[AdminRoles] Starting loadUsers...');

      // Use Supabase session instead of localStorage token
      const { data: sessionData } = await supabase.auth.getSession();
      console.log('[AdminRoles] Supabase session:', !!sessionData.session);

      if (!sessionData.session) {
        console.log('[AdminRoles] No session found, redirecting to login');
        router.push('/login');
        return;
      }

      const token = sessionData.session.access_token;
      console.log('[AdminRoles] Token from session:', !!token);

      console.log('[AdminRoles] Making API call to /api/admin/users');
      const response = await fetch(`${API_BASE}/api/admin/users`, {
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
      });

      console.log('[AdminRoles] API response status:', response.status);

      if (!response.ok) {
        const errorText = await response.text();
        console.log('[AdminRoles] API error response:', errorText);

        if (response.status === 403) {
          console.log('[AdminRoles] 403 Forbidden - Admin privileges required');
          setError('Access denied. Admin privileges required.');
          return;
        }
        if (response.status === 401) {
          console.log('[AdminRoles] 401 Unauthorized - redirecting to login');
          router.push('/login');
          return;
        }
        throw new Error(`HTTP ${response.status}`);
      }

      const data = await response.json();
      console.log('[AdminRoles] Users data received:', data);
      console.log(
        '[AdminRoles] Data type:',
        typeof data,
        'Array:',
        Array.isArray(data)
      );

      // Backend returns array directly, not wrapped in {users: [...]}
      // Transform backend format (user_id) to frontend format (id)
      const usersData = Array.isArray(data)
        ? data.map(user => ({
            id: user.user_id,
            email: user.email,
            role: user.role,
            created_at: user.role_updated_at || new Date().toISOString(),
            is_active: true, // Default to active since backend doesn't provide this
          }))
        : [];
      console.log(
        '[AdminRoles] Processed users data length:',
        usersData.length
      );
      console.log('[AdminRoles] Sample transformed user:', usersData[0]);

      setUsers(usersData);

      // Calculate stats after users are loaded
      calculateAndSetStats(usersData);

      // Load recent activity after users are available
      await loadRecentActivity(usersData);
    } catch (error) {
      console.error('Error loading users:', error);
      setError('Failed to load users');
    }
  };

  const loadUserStats = async () => {
    calculateAndSetStats(users);
  };

  const calculateAndSetStats = (usersData: User[]) => {
    try {
      // Calculate basic stats from the users data
      const totalUsers = usersData.length;
      const activeUsers = usersData.filter(u => u.is_active).length;
      const totalAdmins = usersData.filter(u => u.role === 'admin').length;
      const activeAdmins = usersData.filter(
        u => u.role === 'admin' && u.is_active
      ).length;

      // Recent signups (last 7 days)
      const sevenDaysAgo = new Date();
      sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);
      const recentSignups = usersData.filter(
        u => new Date(u.created_at) > sevenDaysAgo
      ).length;

      setStats({
        total_users: totalUsers,
        active_users: activeUsers,
        total_admins: totalAdmins,
        active_admins: activeAdmins,
        recent_signups: recentSignups,
      });
    } catch (error) {
      console.error('Error calculating user stats:', error);
    }
  };

  const loadRecentActivity = async (usersData?: User[]) => {
    try {
      const { data: sessionData } = await supabase.auth.getSession();
      if (!sessionData.session) {
        router.push('/login');
        return;
      }
      const token = sessionData.session.access_token;

      const response = await fetch(
        `${API_BASE}/api/admin/audit-log?limit=10`,
        {
          headers: {
            Authorization: `Bearer ${token}`,
            'Content-Type': 'application/json',
          },
        }
      );

      if (!response.ok) {
        setUserActivities([]);
        return;
      }

      const data = await response.json();
      const items: any[] = data.items || [];

      const activities: UserActivity[] = items.map(item => ({
        id: item.id || String(Math.random()),
        user_id: item.actor_id || 'system',
        action: item.action || 'Unknown action',
        timestamp: item.created_at || new Date().toISOString(),
        details: item.actor_email
          ? `${item.actor_email} — ${item.action}`
          : item.action,
      }));

      setUserActivities(activities.slice(0, 10));
    } catch (error) {
      console.error('Error loading user activity:', error);
      setUserActivities([]);
    }
  };

  const handleRoleChange = async (userId: string, newRole: 'rep' | 'admin') => {
    try {
      setProcessingUsers(prev => new Set([...prev, userId]));

      // Use Supabase session instead of localStorage token
      const { data: sessionData } = await supabase.auth.getSession();
      if (!sessionData.session) {
        router.push('/login');
        return;
      }
      const token = sessionData.session.access_token;

      const response = await fetch(
        `${API_BASE}/api/admin/users/${userId}/role`,
        {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${token}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ role: newRole }),
        }
      );

      if (!response.ok) {
        const errorData = await response.json();
        if (response.status === 409) {
          const errorMsg =
            errorData.error ||
            'Cannot perform this action - would leave system without admins';
          setError(errorMsg);
          toast.error(`❌ ${errorMsg}`);
        } else {
          throw new Error(`HTTP ${response.status}`);
        }
        return;
      }

      const data = await response.json();
      const successMsg = `User role updated to ${newRole}`;
      setSuccess(successMsg);
      toast.success(`✅ ${successMsg}`);

      // Add activity for role change
      const targetUser = users.find(u => u.id === userId);
      const newActivity: UserActivity = {
        id: `role-change-${userId}-${Date.now()}`,
        user_id: userId,
        action: `Role changed to ${newRole}`,
        timestamp: new Date().toISOString(),
        details: `${targetUser?.email || 'Unknown user'} role updated from ${targetUser?.role || 'unknown'} to ${newRole}`,
      };

      setUserActivities(prev => [newActivity, ...prev].slice(0, 10));

      // Update local state with functional update to ensure we get the latest state
      setUsers(prev => {
        const updatedUsers = prev.map(user =>
          user.id === userId ? { ...user, role: newRole } : user
        );
        // Calculate stats with the updated users data
        calculateAndSetStats(updatedUsers);
        return updatedUsers;
      });
    } catch (error) {
      console.error('Error updating user role:', error);
      const errorMsg =
        error instanceof Error ? error.message : 'Failed to update user role';
      setError(errorMsg);
      toast.error(`❌ ${errorMsg}`);
    } finally {
      setProcessingUsers(prev => {
        const next = new Set(prev);
        next.delete(userId);
        return next;
      });
    }
  };

  const filteredUsers = users.filter(
    user =>
      user.email.toLowerCase().includes(searchTerm.toLowerCase()) ||
      user.role.toLowerCase().includes(searchTerm.toLowerCase())
  );

  const formatDate = (dateString: string) => {
    return new Date(dateString).toLocaleDateString('en-US', {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    });
  };

  const getRoleBadgeVariant = (role: string) => {
    switch (role) {
      case 'admin':
        return 'destructive';
      case 'rep':
        return 'secondary';
      default:
        return 'outline';
    }
  };

  if (loading && users.length === 0) {
    return (
      <div className="flex items-center justify-center min-h-[400px]">
        <RefreshCw className="h-8 w-8 animate-spin" />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">User Management</h1>
          <p className="text-muted-foreground">
            Manage user roles and permissions
          </p>
        </div>
        <Button onClick={loadData} disabled={loading}>
          <RefreshCw
            className={`h-4 w-4 mr-2 ${loading ? 'animate-spin' : ''}`}
          />
          Refresh
        </Button>
      </div>

      {/* Error/Success Messages */}
      {error && (
        <Card className="border-destructive">
          <CardContent className="pt-6">
            <div className="flex items-center gap-2 text-destructive">
              <XCircle className="h-5 w-5" />
              <span>{error}</span>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => setError(null)}
                className="ml-auto"
              >
                Dismiss
              </Button>
            </div>
          </CardContent>
        </Card>
      )}

      {success && (
        <Card className="border-green-500">
          <CardContent className="pt-6">
            <div className="flex items-center gap-2 text-green-600">
              <CheckCircle className="h-5 w-5" />
              <span>{success}</span>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => setSuccess(null)}
                className="ml-auto"
              >
                Dismiss
              </Button>
            </div>
          </CardContent>
        </Card>
      )}

      {/* Stats Cards */}
      {stats && (
        <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-4">
          <Card>
            <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
              <CardTitle className="text-sm font-medium">Total Users</CardTitle>
              <Users className="h-4 w-4 text-muted-foreground" />
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-bold">{stats.total_users}</div>
            </CardContent>
          </Card>
          <Card>
            <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
              <CardTitle className="text-sm font-medium">
                Active Users
              </CardTitle>
              <UserCheck className="h-4 w-4 text-muted-foreground" />
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-bold">{stats.active_users}</div>
            </CardContent>
          </Card>
          <Card>
            <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
              <CardTitle className="text-sm font-medium">
                Total Admins
              </CardTitle>
              <Shield className="h-4 w-4 text-muted-foreground" />
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-bold">{stats.total_admins}</div>
            </CardContent>
          </Card>
          <Card>
            <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
              <CardTitle className="text-sm font-medium">
                Recent Signups
              </CardTitle>
              <Clock className="h-4 w-4 text-muted-foreground" />
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-bold">{stats.recent_signups}</div>
            </CardContent>
          </Card>
        </div>
      )}

      <Tabs defaultValue="users" className="space-y-4">
        <TabsList>
          <TabsTrigger value="users">Users</TabsTrigger>
          <TabsTrigger value="activity">Recent Activity</TabsTrigger>
        </TabsList>

        <TabsContent value="users" className="space-y-4">
          <Card>
            <CardHeader>
              <CardTitle>Users & Roles</CardTitle>
              <CardDescription>
                Manage user roles and access permissions
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              {/* Search */}
              <div className="relative max-w-sm">
                <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
                <Input
                  placeholder="Search users..."
                  value={searchTerm}
                  onChange={e => setSearchTerm(e.target.value)}
                  className="pl-8"
                />
              </div>

              {/* Users Table */}
              <div className="border rounded-lg">
                <div className="overflow-x-auto">
                  <table className="w-full">
                    <thead className="border-b bg-muted/50">
                      <tr>
                        <th className="text-left p-3 font-medium">User</th>
                        <th className="text-left p-3 font-medium">Role</th>
                        <th className="text-left p-3 font-medium">Status</th>
                        <th className="text-left p-3 font-medium">Joined</th>
                        <th className="text-left p-3 font-medium">
                          Last Login
                        </th>
                        <th className="text-left p-3 font-medium">Actions</th>
                      </tr>
                    </thead>
                    <tbody>
                      {filteredUsers.map(user => (
                        <tr
                          key={user.id}
                          className="border-b hover:bg-muted/50"
                        >
                          <td className="p-3">
                            <div className="font-medium">{user.email}</div>
                            <div className="text-sm text-muted-foreground">
                              ID: {user.id.slice(0, 8)}...
                            </div>
                          </td>
                          <td className="p-3">
                            <Badge variant={getRoleBadgeVariant(user.role)}>
                              {user.role}
                            </Badge>
                          </td>
                          <td className="p-3">
                            <Badge
                              variant={user.is_active ? 'default' : 'secondary'}
                            >
                              {user.is_active ? 'Active' : 'Inactive'}
                            </Badge>
                          </td>
                          <td className="p-3 text-sm text-muted-foreground">
                            {formatDate(user.created_at)}
                          </td>
                          <td className="p-3 text-sm text-muted-foreground">
                            {user.last_login
                              ? formatDate(user.last_login)
                              : 'Never'}
                          </td>
                          <td className="p-3">
                            <div className="flex items-center gap-2">
                              {user.role === 'rep' ? (
                                <Button
                                  size="sm"
                                  variant="outline"
                                  onClick={() =>
                                    handleRoleChange(user.id, 'admin')
                                  }
                                  disabled={processingUsers.has(user.id)}
                                >
                                  {processingUsers.has(user.id) ? (
                                    <RefreshCw className="h-3 w-3 animate-spin" />
                                  ) : (
                                    <>
                                      <Shield className="h-3 w-3 mr-1" />
                                      Promote
                                    </>
                                  )}
                                </Button>
                              ) : (
                                <Button
                                  size="sm"
                                  variant="outline"
                                  onClick={() =>
                                    handleRoleChange(user.id, 'rep')
                                  }
                                  disabled={processingUsers.has(user.id)}
                                >
                                  {processingUsers.has(user.id) ? (
                                    <RefreshCw className="h-3 w-3 animate-spin" />
                                  ) : (
                                    <>
                                      <UserX className="h-3 w-3 mr-1" />
                                      Demote
                                    </>
                                  )}
                                </Button>
                              )}
                            </div>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>

                {filteredUsers.length === 0 && (
                  <div className="text-center py-8 text-muted-foreground">
                    {searchTerm
                      ? 'No users found matching your search.'
                      : 'No users found.'}
                  </div>
                )}
              </div>
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="activity" className="space-y-4">
          <Card>
            <CardHeader>
              <CardTitle>Recent Activity</CardTitle>
              <CardDescription>
                Recent user actions and system events
              </CardDescription>
            </CardHeader>
            <CardContent>
              <div className="space-y-3">
                {userActivities.map(activity => (
                  <div
                    key={activity.id}
                    className="flex items-center gap-3 p-3 border rounded-lg"
                  >
                    <div className="flex-1">
                      <div className="font-medium">{activity.action}</div>
                      {activity.details && (
                        <div className="text-sm text-muted-foreground mt-1">
                          {activity.details}
                        </div>
                      )}
                    </div>
                    <div className="text-sm text-muted-foreground">
                      {formatDate(activity.timestamp)}
                    </div>
                  </div>
                ))}

                {userActivities.length === 0 && (
                  <div className="text-center py-8 text-muted-foreground">
                    No recent activity found.
                  </div>
                )}
              </div>
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>
    </div>
  );
}
