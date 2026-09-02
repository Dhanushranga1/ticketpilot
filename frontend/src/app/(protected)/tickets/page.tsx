'use client';

import { useState, useEffect, Suspense } from 'react';
import { useSearchParams, useRouter } from 'next/navigation';
import Link from 'next/link';
import {
  Plus,
  Search,
  Filter,
  Download,
  AlertCircle,
  Eye,
  Edit,
  CheckSquare,
  Square,
  CheckCheck,
  X as XIcon,
  UserCheck as AssignIcon,
  CheckCircle2,
  RotateCcw,
} from 'lucide-react';
import { motion } from 'framer-motion';
import { toast } from 'sonner';
import { DataTable } from '@/components/ui/DataTable';
import { MobileTicketCard } from '@/components/ui/mobile-ticket-card';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { TicketListSkeleton } from '@/components/skeletons/TicketListSkeleton';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { StatusBadge } from '@/components/StatusBadge';
import { useOrganization } from '@/contexts/OrganizationContext';
import api from '@/lib/api-client';

// Types from backend schemas
interface TicketSummary {
  id: string;
  title: string;
  status: string;
  priority: string;
  priority_level: number | null;
  is_overdue: boolean;
  needs_attention: boolean;
  message_count: number;
  last_message_at: string;
  created_at: string;
  assignee_email: string | null;
  tags: string[];
  customer_rating?: number | null;
}

interface TicketListResponse {
  items: TicketSummary[];
  total: number;
  offset: number;
  limit: number;
}

const PRIORITY_COLORS: Record<string, string> = {
  urgent: 'bg-red-100 text-red-700 dark:bg-red-900/40 dark:text-red-300',
  high: 'bg-orange-100 text-orange-700 dark:bg-orange-900/40 dark:text-orange-300',
  medium:
    'bg-yellow-100 text-yellow-700 dark:bg-yellow-900/40 dark:text-yellow-300',
  low: 'bg-blue-100 text-blue-700 dark:bg-blue-900/40 dark:text-blue-300',
  normal: 'bg-slate-100 text-slate-700 dark:bg-slate-800 dark:text-slate-300',
};

const P_LEVEL_COLORS = [
  '', // 0 unused
  'bg-red-600 text-white', // P1
  'bg-red-500 text-white', // P2
  'bg-orange-500 text-white', // P3
  'bg-yellow-500 text-white', // P4
  'bg-blue-500 text-white', // P5
  'bg-indigo-500 text-white', // P6
  'bg-slate-400 text-white', // P7
];

const columns = [
  {
    id: 'title',
    accessorKey: 'title',
    header: 'Subject',
    cell: ({ row }: { row: { original: TicketSummary } }) => {
      const t = row.original;
      return (
        <div className="max-w-[340px]">
          <Link
            href={`/tickets/${t.id}`}
            className="font-medium hover:text-primary hover:underline line-clamp-1"
          >
            {t.title}
          </Link>
          <div className="flex items-center gap-1.5 mt-0.5 flex-wrap">
            {t.is_overdue && (
              <span className="inline-flex items-center px-1.5 py-px rounded text-[10px] font-bold bg-red-100 text-red-700 dark:bg-red-900/40 dark:text-red-300">
                OVERDUE
              </span>
            )}
            {t.needs_attention && !t.is_overdue && (
              <span className="inline-flex items-center px-1.5 py-px rounded text-[10px] font-semibold bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-300">
                ATTENTION
              </span>
            )}
            {t.tags.slice(0, 2).map(tag => (
              <span
                key={tag}
                className="inline-flex items-center px-1.5 py-px rounded text-[10px] bg-muted text-muted-foreground"
              >
                {tag}
              </span>
            ))}
          </div>
        </div>
      );
    },
  },
  {
    id: 'status',
    accessorKey: 'status',
    header: 'Status',
    cell: ({ row }: { row: { original: TicketSummary } }) => {
      const status = row.original.status as string;
      return (
        <StatusBadge
          status={
            status as
              | 'open'
              | 'resolved'
              | 'closed'
              | 'in_progress'
              | 'escalated'
          }
        />
      );
    },
  },
  {
    id: 'priority',
    accessorKey: 'priority',
    header: 'Priority',
    cell: ({ row }: { row: { original: TicketSummary } }) => {
      const t = row.original;
      return (
        <div className="flex items-center gap-1.5">
          {t.priority_level != null && (
            <span
              className={`inline-flex items-center px-1.5 py-px rounded text-[10px] font-bold ${P_LEVEL_COLORS[t.priority_level] ?? ''}`}
            >
              P{t.priority_level}
            </span>
          )}
          <span
            className={`inline-flex items-center px-2 py-0.5 rounded text-xs font-medium ${PRIORITY_COLORS[t.priority] ?? PRIORITY_COLORS.normal}`}
          >
            {t.priority}
          </span>
        </div>
      );
    },
  },
  {
    id: 'assignee',
    accessorKey: 'assignee_email',
    header: 'Assigned To',
    cell: ({ row }: { row: { original: TicketSummary } }) => {
      const email = row.original.assignee_email;
      if (!email)
        return (
          <span className="text-xs text-muted-foreground italic">
            Unassigned
          </span>
        );
      return (
        <span className="text-xs truncate max-w-[120px] block">
          {email.split('@')[0]}
        </span>
      );
    },
  },
  {
    id: 'message_count',
    accessorKey: 'message_count',
    header: 'Msgs',
    cell: ({ row }: { row: { original: TicketSummary } }) => (
      <div className="text-sm text-center">{row.original.message_count}</div>
    ),
  },
  {
    id: 'created_at',
    accessorKey: 'created_at',
    header: 'Created',
    cell: ({ row }: { row: { original: TicketSummary } }) => {
      const date = new Date(row.original.created_at);
      return (
        <div className="text-sm">
          {date.toLocaleDateString('en-US', {
            month: 'short',
            day: 'numeric',
            year: 'numeric',
          })}
        </div>
      );
    },
  },
];

// CSV Export function
function downloadCsv(rows: TicketSummary[]) {
  const headers = [
    'id',
    'title',
    'status',
    'message_count',
    'last_message_at',
    'created_at',
  ];
  const csvContent = [
    headers.join(','),
    ...rows.map(row =>
      [
        row.id,
        `"${row.title.replace(/"/g, '""')}"`, // Escape quotes in title
        row.status,
        row.message_count,
        row.last_message_at,
        row.created_at,
      ].join(',')
    ),
  ].join('\n');

  const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `tickets-${new Date().toISOString().split('T')[0]}.csv`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

// Empty State Component
const EmptyTicketState = ({ onCreateClick }: { onCreateClick: () => void }) => (
  <motion.div
    initial={{ opacity: 0, y: 20 }}
    animate={{ opacity: 1, y: 0 }}
    className="text-center py-16 px-4"
  >
    <div className="mx-auto w-24 h-24 mb-6 rounded-full bg-primary/10 flex items-center justify-center">
      <Plus className="w-12 h-12 text-primary" />
    </div>
    <h2 className="text-2xl font-semibold text-foreground mb-3">
      Welcome to TicketPilot! 👋
    </h2>
    <p className="text-muted-foreground max-w-md mx-auto mb-8">
      Get instant help from our AI assistant powered by your company&apos;s
      knowledge base. Create your first ticket to get started.
    </p>

    <Button size="lg" onClick={onCreateClick} className="mb-8">
      <Plus className="w-5 h-5 mr-2" />
      Create Your First Ticket
    </Button>

    <div className="max-w-2xl mx-auto grid grid-cols-1 md:grid-cols-3 gap-4 text-sm">
      <Card className="p-4">
        <div className="font-medium mb-2">📝 Be Specific</div>
        <div className="text-muted-foreground text-xs">
          Describe your issue clearly with relevant details
        </div>
      </Card>
      <Card className="p-4">
        <div className="font-medium mb-2">🤖 AI Helps First</div>
        <div className="text-muted-foreground text-xs">
          Our AI assistant will search our help docs instantly
        </div>
      </Card>
      <Card className="p-4">
        <div className="font-medium mb-2">👤 Human Backup</div>
        <div className="text-muted-foreground text-xs">
          If AI can&apos;t help, escalate to our support team
        </div>
      </Card>
    </div>
  </motion.div>
);

function TicketsPageInner() {
  const searchParams = useSearchParams();
  const router = useRouter();
  const filterParam = searchParams.get('filter');

  // Organization context
  const { currentOrganization, isReady, switchingOrg, user } =
    useOrganization();
  const orgId = currentOrganization?.id;
  const userRole = user?.role ?? 'customer';
  const isRepOrAdmin = userRole === 'rep' || userRole === 'admin';

  const [searchTerm, setSearchTerm] = useState('');
  const [debouncedSearch, setDebouncedSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState(filterParam || 'all');
  const [newTicketOpen, setNewTicketOpen] = useState(false);
  const [tickets, setTickets] = useState<TicketSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [csatBannerDismissed, setCsatBannerDismissed] = useState(false);
  const [creating, setCreating] = useState(false);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [bulkLoading, setBulkLoading] = useState(false);
  const [newTicket, setNewTicket] = useState({
    title: '',
    description: '',
    priority: 'normal',
    customer_email: '',
  });
  const [validationErrors, setValidationErrors] = useState({
    title: '',
    description: '',
    customer_email: '',
  });

  // Debounce search input — avoids an API call on every keystroke
  useEffect(() => {
    const timer = setTimeout(() => setDebouncedSearch(searchTerm), 300);

    // Auto-open create dialog when arriving via ?new=1 (e.g. dashboard CTA)
    if (typeof window !== 'undefined' && window.location.search.includes('new=1')) {
      setNewTicketOpen(true);
      window.history.replaceState({}, '', window.location.pathname);
    }
    return () => clearTimeout(timer);
  }, [searchTerm]);

  // Load tickets from API
  useEffect(() => {
    if (!isReady || !orgId) {
      setLoading(true);
      return;
    }

    const loadTickets = async () => {
      try {
        setLoading(true);
        const params = new URLSearchParams();
        if (statusFilter !== 'all')
          params.append('status_filter', statusFilter);
        if (debouncedSearch) params.append('q', debouncedSearch);
        const response = await api.get<TicketListResponse>(
          `/api/tickets?${params.toString()}`,
          orgId
        );
        setTickets(response.items || []);
        setError(null);
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to load tickets');
        setTickets([]);
      } finally {
        setLoading(false);
      }
    };

    loadTickets();
  }, [statusFilter, debouncedSearch, isReady, orgId]);

  const resetForm = () => {
    setNewTicket({
      title: '',
      description: '',
      priority: 'normal',
      customer_email: '',
    });
    setValidationErrors({ title: '', description: '', customer_email: '' });
  };

  const toggleSelect = (id: string) => {
    setSelectedIds(prev => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });
  };

  const toggleSelectAll = () => {
    if (selectedIds.size === filteredTickets.length) {
      setSelectedIds(new Set());
    } else {
      setSelectedIds(new Set(filteredTickets.map(t => t.id)));
    }
  };

  const bulkAction = async (action: string) => {
    if (!orgId || selectedIds.size === 0) return;
    setBulkLoading(true);
    try {
      const result = await api.post<{ updated: number }>(
        '/api/tickets/bulk',
        {
          ticket_ids: Array.from(selectedIds),
          action,
        },
        orgId
      );
      toast.success(
        `${result.updated} ticket${result.updated !== 1 ? 's' : ''} updated`
      );
      setSelectedIds(new Set());
      // Reload tickets
      const params = new URLSearchParams();
      if (statusFilter !== 'all') params.append('status_filter', statusFilter);
      if (debouncedSearch) params.append('q', debouncedSearch);
      const response = await api.get<{ items: TicketSummary[] }>(
        `/api/tickets?${params.toString()}`,
        orgId
      );
      setTickets(response.items || []);
    } catch {
      toast.error('Bulk action failed');
    } finally {
      setBulkLoading(false);
    }
  };

  // Create ticket function
  const createTicket = async () => {
    setValidationErrors({ title: '', description: '', customer_email: '' });

    const errors = { title: '', description: '', customer_email: '' };

    if (!newTicket.title.trim()) {
      errors.title = 'Title is required';
    } else if (newTicket.title.trim().length < 5) {
      errors.title = 'Title must be at least 5 characters';
    } else if (newTicket.title.trim().length > 200) {
      errors.title = 'Title must be less than 200 characters';
    }

    if (!newTicket.description.trim()) {
      errors.description = 'Description is required';
    } else if (newTicket.description.trim().length < 20) {
      errors.description =
        'Please provide more detail (at least 20 characters)';
    }

    if (
      isRepOrAdmin &&
      newTicket.customer_email &&
      !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(newTicket.customer_email)
    ) {
      errors.customer_email = 'Enter a valid email address';
    }

    if (errors.title || errors.description || errors.customer_email) {
      setValidationErrors(errors);
      toast.error(errors.title || errors.description || errors.customer_email);
      return;
    }

    if (!orgId) {
      toast.error('Organization context not loaded. Please refresh the page.');
      return;
    }

    try {
      setCreating(true);
      const body: Record<string, unknown> = {
        title: newTicket.title,
        description: newTicket.description,
        priority: newTicket.priority,
      };
      if (isRepOrAdmin && newTicket.customer_email.trim()) {
        body.customer_email = newTicket.customer_email.trim();
      }
      const response = await api.post<{ id: string }>(
        '/api/tickets',
        body,
        orgId
      );

      const sentToCustomer = isRepOrAdmin && newTicket.customer_email.trim();
      toast.success(
        sentToCustomer
          ? `Ticket created and sent to ${newTicket.customer_email}`
          : 'Ticket created! Our AI is analyzing your question…',
        { duration: 4000 }
      );

      resetForm();
      setNewTicketOpen(false);

      setTimeout(() => {
        router.push(`/tickets/${response.id}`);
      }, 500);
    } catch (error) {
      toast.error('Failed to create ticket. Please try again.');
      setError(
        error instanceof Error ? error.message : 'Failed to create ticket'
      );
    } finally {
      setCreating(false);
    }
  };

  // Filter tickets based on search and status (now applied to API data)
  const filteredTickets = tickets;

  // Calculate stats
  const totalTickets = tickets.length;
  const openTickets = tickets.filter(t => t.status === 'open').length;
  const inProgressTickets = tickets.filter(
    t => t.status === 'in_progress'
  ).length;
  const resolvedTickets = tickets.filter(t => t.status === 'resolved').length;

  // DataTable actions
  const tableActions = [
    {
      id: 'view',
      label: 'View',
      icon: Eye,
      onClick: (row: TicketSummary) => router.push(`/tickets/${row.id}`),
    },
    {
      id: 'edit',
      label: 'Edit',
      icon: Edit,
      onClick: (row: TicketSummary) =>
        router.push(`/tickets/${row.id}?mode=edit`),
    },
  ];

  return (
    <div className="flex flex-col space-y-8 p-8">
      {/* Header */}
      <div className="flex flex-col space-y-2">
        <h1 className="text-3xl font-bold tracking-tight">Tickets</h1>
        <p className="text-muted-foreground">
          Manage and track all customer support tickets
        </p>
      </div>

      {/* Error Alert */}
      {error && (
        <Card className="border-red-200 bg-red-50">
          <CardContent className="pt-4">
            <div className="flex items-center gap-2">
              <AlertCircle className="h-4 w-4 text-red-600" />
              <p className="text-sm text-red-800">{error}</p>
            </div>
          </CardContent>
        </Card>
      )}

      {/* CSAT pending banner (customers only) */}
      {!isRepOrAdmin &&
        !csatBannerDismissed &&
        (() => {
          const pending = tickets.filter(
            t => t.status === 'resolved' && !t.customer_rating
          );
          if (pending.length === 0) return null;
          return (
            <Card className="border-amber-200 bg-amber-50 dark:bg-amber-950/20 dark:border-amber-800">
              <CardContent className="pt-4">
                <div className="flex items-center justify-between gap-3">
                  <div className="flex items-center gap-2">
                    <AlertCircle className="h-4 w-4 text-amber-600 shrink-0" />
                    <p className="text-sm text-amber-800 dark:text-amber-300">
                      You have {pending.length} resolved ticket
                      {pending.length > 1 ? 's' : ''} awaiting your feedback.
                    </p>
                  </div>
                  <button
                    type="button"
                    onClick={() => setCsatBannerDismissed(true)}
                    className="text-amber-600 hover:text-amber-800 shrink-0"
                    aria-label="Dismiss"
                  >
                    <XIcon className="h-4 w-4" />
                  </button>
                </div>
              </CardContent>
            </Card>
          );
        })()}

      {/* Stats Cards */}
      <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-4">
        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">Total Tickets</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">
              {loading ? '...' : totalTickets}
            </div>
            <p className="text-xs text-muted-foreground">All time tickets</p>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">Open</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold text-red-600">
              {loading ? '...' : openTickets}
            </div>
            <p className="text-xs text-muted-foreground">Awaiting response</p>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">In Progress</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold text-blue-600">
              {loading ? '...' : inProgressTickets}
            </div>
            <p className="text-xs text-muted-foreground">Being worked on</p>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">Resolved</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold text-green-600">
              {loading ? '...' : resolvedTickets}
            </div>
            <p className="text-xs text-muted-foreground">Completed tickets</p>
          </CardContent>
        </Card>
      </div>

      {/* Filters and Actions */}
      <div className="flex flex-col gap-4 md:flex-row md:items-center md:justify-between">
        <div className="flex flex-1 gap-4">
          <div className="relative flex-1 max-w-sm">
            <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
            <Input
              placeholder="Search tickets..."
              value={searchTerm}
              onChange={e => setSearchTerm(e.target.value)}
              className="pl-8"
            />
          </div>
          <Select value={statusFilter} onValueChange={setStatusFilter}>
            <SelectTrigger className="w-[180px]">
              <Filter className="mr-2 h-4 w-4" />
              <SelectValue placeholder="Filter by status" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All Status</SelectItem>
              <SelectItem value="open">Open</SelectItem>
              <SelectItem value="in-progress">In Progress</SelectItem>
              <SelectItem value="resolved">Resolved</SelectItem>
              <SelectItem value="closed">Closed</SelectItem>
              <SelectItem value="urgent">Urgent Priority</SelectItem>
            </SelectContent>
          </Select>
        </div>
        <div className="flex gap-2">
          <Button
            variant="outline"
            onClick={() => downloadCsv(filteredTickets)}
          >
            <Download className="mr-2 h-4 w-4" />
            Export
          </Button>
          <Dialog open={newTicketOpen} onOpenChange={setNewTicketOpen}>
            <DialogTrigger asChild>
              <Button>
                <Plus className="mr-2 h-4 w-4" />
                New Ticket
              </Button>
            </DialogTrigger>
            <DialogContent className="sm:max-w-[500px]">
              <DialogHeader>
                <DialogTitle>Create New Ticket</DialogTitle>
                <DialogDescription>
                  Describe your issue below. Our AI will help find answers from
                  our knowledge base.
                </DialogDescription>
              </DialogHeader>
              <div className="grid gap-4 py-4">
                <div className="space-y-2">
                  <Label htmlFor="title">
                    Subject <span className="text-red-500">*</span>
                  </Label>
                  <Input
                    id="title"
                    placeholder="Brief summary of your issue"
                    value={newTicket.title}
                    onChange={e => {
                      setNewTicket({ ...newTicket, title: e.target.value });
                      // Clear error when user starts typing
                      if (validationErrors.title) {
                        setValidationErrors({ ...validationErrors, title: '' });
                      }
                    }}
                    className={
                      validationErrors.title
                        ? 'border-red-500 focus-visible:ring-red-500'
                        : ''
                    }
                    maxLength={200}
                  />
                  {validationErrors.title && (
                    <p className="text-sm text-red-500 flex items-center gap-1">
                      <svg
                        className="h-4 w-4"
                        fill="none"
                        viewBox="0 0 24 24"
                        stroke="currentColor"
                      >
                        <path
                          strokeLinecap="round"
                          strokeLinejoin="round"
                          strokeWidth={2}
                          d="M12 8v4m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z"
                        />
                      </svg>
                      {validationErrors.title}
                    </p>
                  )}
                  {!validationErrors.title && newTicket.title && (
                    <p className="text-xs text-muted-foreground">
                      {newTicket.title.length}/200 characters
                    </p>
                  )}
                </div>
                <div className="space-y-2">
                  <Label htmlFor="description">
                    Description <span className="text-red-500">*</span>
                  </Label>
                  <Textarea
                    id="description"
                    value={newTicket.description}
                    onChange={e => {
                      setNewTicket({
                        ...newTicket,
                        description: e.target.value,
                      });
                      // Clear error when user starts typing
                      if (validationErrors.description) {
                        setValidationErrors({
                          ...validationErrors,
                          description: '',
                        });
                      }
                    }}
                    placeholder="Describe your issue in detail. For example: 'I'm trying to reset my password, but the email link says it expired. I've tried 3 times in the last hour.'"
                    rows={6}
                    className={`resize-none ${validationErrors.description ? 'border-red-500 focus-visible:ring-red-500' : ''}`}
                    maxLength={500}
                  />
                  {validationErrors.description && (
                    <p className="text-sm text-red-500 flex items-center gap-1">
                      <svg
                        className="h-4 w-4"
                        fill="none"
                        viewBox="0 0 24 24"
                        stroke="currentColor"
                      >
                        <path
                          strokeLinecap="round"
                          strokeLinejoin="round"
                          strokeWidth={2}
                          d="M12 8v4m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z"
                        />
                      </svg>
                      {validationErrors.description}
                    </p>
                  )}
                  {!validationErrors.description && (
                    <p className="text-xs text-muted-foreground">
                      {newTicket.description.length}/500 characters • More
                      detail helps us assist you faster!
                    </p>
                  )}
                </div>

                {/* Priority */}
                <div className="space-y-2">
                  <Label htmlFor="priority">Priority</Label>
                  <Select
                    value={newTicket.priority}
                    onValueChange={v =>
                      setNewTicket({ ...newTicket, priority: v })
                    }
                  >
                    <SelectTrigger id="priority">
                      <SelectValue placeholder="Select priority" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="low">Low</SelectItem>
                      <SelectItem value="normal">Normal</SelectItem>
                      <SelectItem value="high">High</SelectItem>
                      <SelectItem value="urgent">Urgent</SelectItem>
                    </SelectContent>
                  </Select>
                </div>

                {/* Customer email — only shown to reps / admins */}
                {isRepOrAdmin && (
                  <div className="space-y-2">
                    <Label htmlFor="customer_email">
                      Create on behalf of customer{' '}
                      <span className="text-muted-foreground font-normal">
                        (optional)
                      </span>
                    </Label>
                    <Input
                      id="customer_email"
                      type="email"
                      placeholder="customer@example.com"
                      value={newTicket.customer_email}
                      onChange={e => {
                        setNewTicket({
                          ...newTicket,
                          customer_email: e.target.value,
                        });
                        if (validationErrors.customer_email) {
                          setValidationErrors({
                            ...validationErrors,
                            customer_email: '',
                          });
                        }
                      }}
                      className={
                        validationErrors.customer_email
                          ? 'border-red-500 focus-visible:ring-red-500'
                          : ''
                      }
                    />
                    {validationErrors.customer_email && (
                      <p className="text-sm text-red-500">
                        {validationErrors.customer_email}
                      </p>
                    )}
                    <p className="text-xs text-muted-foreground">
                      The ticket will be owned by this customer and they'll
                      receive an email notification.
                    </p>
                  </div>
                )}
              </div>
              <DialogFooter>
                <Button
                  variant="outline"
                  onClick={() => {
                    setNewTicketOpen(false);
                    resetForm();
                  }}
                  disabled={creating}
                >
                  Cancel
                </Button>
                <Button
                  type="submit"
                  onClick={createTicket}
                  disabled={
                    creating ||
                    !newTicket.title.trim() ||
                    !newTicket.description.trim() ||
                    newTicket.title.trim().length < 5 ||
                    newTicket.description.trim().length < 20
                  }
                >
                  {creating ? (
                    <>
                      <svg
                        className="animate-spin -ml-1 mr-2 h-4 w-4"
                        xmlns="http://www.w3.org/2000/svg"
                        fill="none"
                        viewBox="0 0 24 24"
                      >
                        <circle
                          className="opacity-25"
                          cx="12"
                          cy="12"
                          r="10"
                          stroke="currentColor"
                          strokeWidth="4"
                        ></circle>
                        <path
                          className="opacity-75"
                          fill="currentColor"
                          d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"
                        ></path>
                      </svg>
                      Creating…
                    </>
                  ) : isRepOrAdmin && newTicket.customer_email.trim() ? (
                    'Create & Notify Customer'
                  ) : (
                    'Create Ticket'
                  )}
                </Button>
              </DialogFooter>
            </DialogContent>
          </Dialog>
        </div>
      </div>

      {/* Bulk Action Bar */}
      {isRepOrAdmin && selectedIds.size > 0 && (
        <div className="flex items-center gap-3 p-3 rounded-lg bg-primary/10 border border-primary/30">
          <span className="text-sm font-medium text-primary">
            {selectedIds.size} selected
          </span>
          <div className="flex items-center gap-2 flex-wrap">
            <button
              type="button"
              onClick={() => bulkAction('resolve')}
              disabled={bulkLoading}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-md bg-green-600 text-white text-xs font-medium hover:bg-green-700 disabled:opacity-50"
            >
              <CheckCircle2 className="w-3.5 h-3.5" />
              Resolve
            </button>
            <button
              type="button"
              onClick={() => bulkAction('close')}
              disabled={bulkLoading}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-md bg-slate-600 text-white text-xs font-medium hover:bg-slate-700 disabled:opacity-50"
            >
              <XIcon className="w-3.5 h-3.5" />
              Close
            </button>
            <button
              type="button"
              onClick={() => bulkAction('reopen')}
              disabled={bulkLoading}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-md bg-blue-600 text-white text-xs font-medium hover:bg-blue-700 disabled:opacity-50"
            >
              <RotateCcw className="w-3.5 h-3.5" />
              Reopen
            </button>
            <button
              type="button"
              onClick={() => bulkAction('assign')}
              disabled={bulkLoading}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-md bg-purple-600 text-white text-xs font-medium hover:bg-purple-700 disabled:opacity-50"
            >
              <AssignIcon className="w-3.5 h-3.5" />
              Assign to me
            </button>
          </div>
          <button
            type="button"
            onClick={() => setSelectedIds(new Set())}
            className="ml-auto text-xs text-muted-foreground hover:text-foreground"
          >
            Clear selection
          </button>
        </div>
      )}

      {/* Data Table or Empty State */}
      {loading || switchingOrg ? (
        <TicketListSkeleton />
      ) : filteredTickets.length === 0 &&
        !searchTerm &&
        statusFilter === 'all' ? (
        <EmptyTicketState onCreateClick={() => setNewTicketOpen(true)} />
      ) : filteredTickets.length === 0 ? (
        <div className="flex flex-col items-center py-16 text-muted-foreground gap-3">
          <Search className="w-10 h-10 opacity-30" />
          <p className="font-medium">No tickets match your filters</p>
          <p className="text-sm">Try adjusting the search or status filter.</p>
          <button
            type="button"
            onClick={() => {
              setSearchTerm('');
              setStatusFilter('all');
            }}
            className="mt-1 text-sm text-primary hover:underline"
          >
            Clear filters
          </button>
        </div>
      ) : (
        <>
          {/* Mobile Card View (< 768px) */}
          <div className="md:hidden space-y-3">
            <div className="flex items-center justify-between px-1 mb-2">
              <p className="text-sm text-muted-foreground">
                Showing {filteredTickets.length} of {totalTickets} tickets
              </p>
            </div>
            {filteredTickets.map(ticket => (
              <MobileTicketCard key={ticket.id} ticket={ticket} />
            ))}
          </div>

          {/* Desktop Table View (>= 768px) */}
          <Card className="hidden md:block">
            <CardHeader>
              <div className="flex items-center justify-between">
                <div>
                  <CardTitle>All Tickets</CardTitle>
                  <CardDescription>
                    Showing {filteredTickets.length} of {totalTickets} tickets
                  </CardDescription>
                </div>
                {isRepOrAdmin && (
                  <button
                    type="button"
                    onClick={toggleSelectAll}
                    className="flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground transition-colors"
                  >
                    {selectedIds.size === filteredTickets.length &&
                    filteredTickets.length > 0 ? (
                      <CheckCheck className="w-4 h-4 text-primary" />
                    ) : (
                      <CheckSquare className="w-4 h-4" />
                    )}
                    {selectedIds.size === filteredTickets.length &&
                    filteredTickets.length > 0
                      ? 'Deselect all'
                      : 'Select all'}
                  </button>
                )}
              </div>
            </CardHeader>
            <CardContent>
              {isRepOrAdmin ? (
                <div className="space-y-1">
                  {filteredTickets.map(ticket => (
                    <div
                      key={ticket.id}
                      className="flex items-center gap-3 group"
                    >
                      <button
                        type="button"
                        onClick={() => toggleSelect(ticket.id)}
                        className="shrink-0 text-muted-foreground hover:text-primary transition-colors"
                        title="Select ticket"
                      >
                        {selectedIds.has(ticket.id) ? (
                          <CheckSquare className="w-4 h-4 text-primary" />
                        ) : (
                          <Square className="w-4 h-4 opacity-40 group-hover:opacity-100" />
                        )}
                      </button>
                      <div
                        className="flex-1 flex items-center justify-between py-2.5 px-3 rounded-lg hover:bg-accent/50 cursor-pointer transition-colors"
                        onClick={() => router.push(`/tickets/${ticket.id}`)}
                      >
                        <div className="flex items-center gap-3 min-w-0">
                          <StatusBadge
                            status={
                              ticket.status as
                                | 'open'
                                | 'resolved'
                                | 'closed'
                                | 'in_progress'
                                | 'escalated'
                            }
                          />
                          <span className="font-medium text-sm truncate max-w-[320px]">
                            {ticket.title}
                          </span>
                          {ticket.is_overdue && (
                            <span className="shrink-0 text-[10px] font-bold bg-red-100 text-red-700 dark:bg-red-900/40 dark:text-red-300 px-1.5 py-px rounded">
                              OVERDUE
                            </span>
                          )}
                          {ticket.tags.slice(0, 2).map(t => (
                            <span
                              key={t}
                              className="shrink-0 text-[10px] bg-muted text-muted-foreground px-1.5 py-px rounded hidden lg:inline-flex"
                            >
                              {t}
                            </span>
                          ))}
                        </div>
                        <div className="flex items-center gap-4 shrink-0 ml-4">
                          <span
                            className={`text-xs px-2 py-0.5 rounded font-medium ${PRIORITY_COLORS[ticket.priority] ?? PRIORITY_COLORS.normal}`}
                          >
                            {ticket.priority}
                          </span>
                          <span className="text-xs text-muted-foreground hidden xl:block">
                            {new Date(ticket.created_at).toLocaleDateString(
                              'en-US',
                              { month: 'short', day: 'numeric' }
                            )}
                          </span>
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              ) : (
                <DataTable
                  columns={columns}
                  data={filteredTickets}
                  actions={tableActions}
                  searchable={true}
                  searchPlaceholder="Search tickets..."
                  filterable={true}
                  sortable={true}
                  pagination={true}
                  pageSize={10}
                />
              )}
            </CardContent>
          </Card>
        </>
      )}
    </div>
  );
}

export default function TicketsPage() {
  return (
    <Suspense>
      <TicketsPageInner />
    </Suspense>
  );
}
