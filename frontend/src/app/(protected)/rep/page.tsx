'use client';

import { useState, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
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
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Checkbox } from '@/components/ui/checkbox';
import { StatusBadge } from '@/components/StatusBadge';
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import { RepActionBar } from '@/components/ui/RepActionBar';
import { AIMessage } from '@/components/ui/AIMessage';
import { AIResponseModal } from '@/components/rep/AIResponseModal';
import { KBIngestModal } from '@/components/ui/KBIngestModal';
import { RepQueueSkeleton } from '@/components/skeletons/RepQueueSkeleton';
import { buildAISuggestionQuery, prepareTicketContext } from '@/lib/ai/prompt';
import { useOrganization } from '@/contexts/OrganizationContext';
import { useEntitlements } from '@/hooks/useEntitlements';
import api from '@/lib/api-client';
import { toast } from 'sonner';
import { cn } from '@/lib/utils';
import {
  Clock,
  MessageSquare,
  User,
  AlertTriangle,
  ExternalLink,
  Upload,
  CheckCircle,
  Phone,
  Mail,
  Bot,
  CheckCheck,
  FileText,
  Loader2,
} from 'lucide-react';
import { m } from 'framer-motion';
import { v } from '@/ui/motion/variants';
import { PageShell } from '@/ui/motion/PageShell';

interface QueueItem {
  id: string;
  title: string;
  status: string;
  priority: string;
  priority_level?: number;
  needs_attention: boolean;
  assignee_id?: string;
  message_count: number;
  last_message_at: string;
  created_at: string;
  customer_email?: string;
  customer_phone?: string;
  escalated_to_name?: string;
  escalated_at?: string;
  expected_resolve_at?: string;
  etr_set_at?: string;
  accepted_at?: string;
}

interface QueueCounts {
  needs_attention: number;
  open_active: number;
  in_progress: number;
  escalated: number;
  all: number;
  resolved_today: number;
}

const API_BASE = process.env.NEXT_PUBLIC_API_BASE || 'http://127.0.0.1:8000';

// Utility function to calculate ticket age
const getTicketAge = (createdAt: string): { text: string; urgent: boolean } => {
  const now = new Date();
  const created = new Date(createdAt);
  const diffMs = now.getTime() - created.getTime();
  const diffHours = Math.floor(diffMs / (1000 * 60 * 60));
  const diffDays = Math.floor(diffHours / 24);

  if (diffDays > 0) {
    return { text: `${diffDays}d ago`, urgent: diffDays >= 1 };
  } else if (diffHours > 0) {
    return { text: `${diffHours}h ago`, urgent: diffHours >= 24 };
  } else {
    const diffMins = Math.floor(diffMs / (1000 * 60));
    return { text: `${diffMins}m ago`, urgent: false };
  }
};

// Simple skeleton loader component
const TicketCardSkeleton = () => (
  <Card>
    <CardHeader className="pb-3">
      <div className="flex justify-between items-start">
        <div className="space-y-2 flex-1">
          <div className="h-4 bg-muted rounded animate-pulse w-3/4"></div>
          <div className="h-3 bg-muted rounded animate-pulse w-1/2"></div>
        </div>
        <div className="h-6 bg-muted rounded animate-pulse w-16"></div>
      </div>
    </CardHeader>
    <CardContent>
      <div className="space-y-3">
        <div className="h-3 bg-muted rounded animate-pulse w-full"></div>
        <div className="h-3 bg-muted rounded animate-pulse w-2/3"></div>
        <div className="flex gap-2">
          <div className="h-8 bg-muted rounded animate-pulse w-20"></div>
          <div className="h-8 bg-muted rounded animate-pulse w-20"></div>
        </div>
      </div>
    </CardContent>
  </Card>
);

export default function RepConsolePage() {
  const router = useRouter();

  // Use org context — eliminates a separate /api/me auth round-trip
  const { currentOrganization, isReady, switchingOrg, user, loading } =
    useOrganization();
  const orgId = currentOrganization?.id;
  const { can, upgradeUrl } = useEntitlements();

  const [ticketsLoading, setTicketsLoading] = useState(false);
  const [countsLoading, setCountsLoading] = useState(false);
  const [tickets, setTickets] = useState<QueueItem[]>([]);
  const [counts, setCounts] = useState<QueueCounts>({
    needs_attention: 0,
    open_active: 0,
    in_progress: 0,
    escalated: 0,
    all: 0,
    resolved_today: 0,
  });
  const [currentLane, setCurrentLane] = useState('needs_attention');
  const [searchQuery, setSearchQuery] = useState('');
  const [mineOnly, setMineOnly] = useState(true);
  const [offset, setOffset] = useState(0);
  const [total, setTotal] = useState(0);
  const [actionLoading, setActionLoading] = useState<string | null>(null);
  const [showKBModal, setShowKBModal] = useState(false);
  const [lastRefresh, setLastRefresh] = useState(Date.now());
  const [now, setNow] = useState(Date.now());

  // AI-related state
  const [aiModalOpen, setAiModalOpen] = useState(false);
  const [aiResponse, setAiResponse] = useState<any>(null);
  const [aiCooldowns, setAiCooldowns] = useState<Record<string, number>>({});
  const [currentAiTicket, setCurrentAiTicket] = useState<string | null>(null);

  // Escalation dialog state
  const [escalateDialog, setEscalateDialog] = useState<{
    open: boolean;
    ticketId: string | null;
    reason: string;
    toUserId: string;
  }>({ open: false, ticketId: null, reason: '', toUserId: '' });
  const [orgMembers, setOrgMembers] = useState<
    Array<{ user_id: string; user_email: string; role: string }>
  >([]);
  const [membersLoading, setMembersLoading] = useState(false);
  const [bulkAssigning, setBulkAssigning] = useState(false);

  // ETR dialog state
  const [etrDialog, setEtrDialog] = useState<{
    open: boolean;
    ticketId: string | null;
    value: string; // datetime-local string
  }>({ open: false, ticketId: null, value: '' });

  const limit = 20;

  // Role guard — redirect non-reps to dashboard
  useEffect(() => {
    if (!loading && user && !['rep', 'admin'].includes(user.role || '')) {
      router.replace('/dashboard');
    }
  }, [loading, user, router]);

  // Load data when filters change
  useEffect(() => {
    if (user && isReady && orgId) {
      loadQueue();
    }
  }, [user, currentLane, searchQuery, mineOnly, offset, isReady, orgId]);

  // Auto-refresh every 30 seconds
  useEffect(() => {
    if (!user || !isReady || !orgId) return;

    const interval = setInterval(() => {
      loadQueue(true);
      setLastRefresh(Date.now());
    }, 30000);

    return () => clearInterval(interval);
  }, [user, currentLane, searchQuery, mineOnly, offset, isReady, orgId]);

  // Tick every second — drives live accept timers and AI cooldown counters
  useEffect(() => {
    const interval = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(interval);
  }, []);

  // AI cooldown timer
  useEffect(() => {
    const interval = setInterval(() => {
      setAiCooldowns(prev => {
        const now = Date.now();
        const updated = { ...prev };
        let hasChanges = false;

        Object.keys(updated).forEach(ticketId => {
          if (updated[ticketId] <= now) {
            delete updated[ticketId];
            hasChanges = true;
          }
        });

        return hasChanges ? updated : prev;
      });
    }, 1000);

    return () => clearInterval(interval);
  }, []);

  const getAuthToken = async () => {
    const { data } = await supabase.auth.getSession();
    return data.session?.access_token;
  };

  // Run tickets + counts in parallel so the page populates in one round-trip
  const loadQueue = async (silent = false) => {
    await Promise.all([loadTickets(silent), loadCounts(silent)]);
  };

  const loadTickets = async (silent = false) => {
    if (!orgId) return;

    try {
      if (!silent) setTicketsLoading(true);

      const params = new URLSearchParams({
        lane: currentLane,
        offset: offset.toString(),
        limit: limit.toString(),
      });

      if (searchQuery) params.append('q', searchQuery);
      if (mineOnly) params.append('mine', 'true');

      const data = await api.get(`/api/rep/queue?${params}`, orgId);
      setTickets(data.items);
      setTotal(data.total);
    } catch (error) {
      console.error('Failed to load tickets:', error);
      if (!silent) {
        toast.error('Failed to load tickets');
      }
    } finally {
      if (!silent) setTicketsLoading(false);
    }
  };

  const loadCounts = async (silent = false) => {
    if (!orgId) return;

    try {
      if (!silent) setCountsLoading(true);

      const data = await api.get(`/api/rep/counts`, orgId);
      setCounts(data);
    } catch (error) {
      console.error('Failed to load counts:', error);
      if (!silent) {
        toast.error('Failed to load queue counts');
      }
    } finally {
      if (!silent) setCountsLoading(false);
    }
  };

  // Quick Action Handlers
  const handleQuickRespond = (ticket: QueueItem) => {
    // Navigate to ticket detail page and focus on composer
    toast.success('Opening ticket composer...');
    router.push(`/tickets/${ticket.id}#compose`);
  };

  const handleQuickCall = async (ticket: QueueItem) => {
    if (!orgId) return;

    try {
      setActionLoading(ticket.id + 'call');

      if (ticket.customer_phone) {
        // Open tel: link for phone call
        window.open(`tel:${ticket.customer_phone}`, '_self');
        toast.success(`Calling ${ticket.customer_phone}`);

        // Also log a system message about the call
        await api.post(
          `/api/tickets/${ticket.id}/messages`,
          {
            body: `📞 Call initiated to ${ticket.customer_phone}`,
            sender_role: 'system',
          },
          orgId
        );

        // Optimistically update message count
        setTickets(prev =>
          prev.map(t =>
            t.id === ticket.id
              ? { ...t, message_count: t.message_count + 1 }
              : t
          )
        );

        // Reload tickets to sync with server
        await loadTickets(true);
      } else {
        // No phone number available, open modal to log call manually
        const callNote = prompt(
          'Phone number not available. Log call details:'
        );
        if (callNote) {
          await api.post(
            `/api/tickets/${ticket.id}/messages`,
            {
              body: `📞 Call logged: ${callNote}`,
              sender_role: 'system',
            },
            orgId
          );

          toast.success('Call logged successfully');
          // Optimistically update message count
          setTickets(prev =>
            prev.map(t =>
              t.id === ticket.id
                ? { ...t, message_count: t.message_count + 1 }
                : t
            )
          );
          await loadTickets(true);
        }
      }
    } catch (error) {
      console.error('Failed to log call:', error);
      toast.error('Failed to log call');
    } finally {
      setActionLoading(null);
    }
  };

  const handleQuickEmail = async (ticket: QueueItem) => {
    if (!orgId) return;

    try {
      setActionLoading(ticket.id + 'email');

      const subject = `[Ticket #${ticket.id.slice(0, 8)}] ${ticket.title}`;
      const body = `Hi,\n\nRegarding your support ticket "${ticket.title}":\n\n[Your message here]\n\nBest regards,\nSupport Team`;
      const mailtoUrl = `mailto:${ticket.customer_email || ''}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;

      window.open(mailtoUrl, '_self');
      toast.success('Email client opened');

      // Log that an email was sent
      const shouldLog = confirm(
        'Email client opened. Log this email in the ticket?'
      );
      if (shouldLog) {
        await api.post(
          `/api/tickets/${ticket.id}/messages`,
          {
            body: `📧 Email sent to ${ticket.customer_email || 'customer'}`,
            sender_role: 'system',
          },
          orgId
        );

        toast.success('Email logged successfully');
        // Optimistically update message count
        setTickets(prev =>
          prev.map(t =>
            t.id === ticket.id
              ? { ...t, message_count: t.message_count + 1 }
              : t
          )
        );
        await loadTickets(true);
      }
    } catch (error) {
      console.error('Failed to handle email:', error);
      toast.error('Failed to handle email');
    } finally {
      setActionLoading(null);
    }
  };

  const handleQuickAI = async (ticket: QueueItem) => {
    // Check cooldown
    const now = Date.now();
    const cooldownEnd = aiCooldowns[ticket.id];
    if (cooldownEnd && cooldownEnd > now) {
      const remainingSeconds = Math.ceil((cooldownEnd - now) / 1000);
      toast.error(
        `Please wait ${remainingSeconds} seconds before requesting another AI suggestion`,
        {
          id: 'ai-cooldown-' + ticket.id,
        }
      );
      return;
    }

    try {
      setActionLoading(ticket.id + 'ai');
      toast.loading('Getting AI suggestion...', { id: 'ai-' + ticket.id });

      // Fetch detailed ticket information including messages
      let ticketDetails = ticket;
      let messages: any[] = [];

      try {
        // Get full ticket details
        ticketDetails = await api.get(`/api/tickets/${ticket.id}`, orgId);

        // Get recent messages (last 5)
        const messagesResponse = await api.get(
          `/api/tickets/${ticket.id}/messages?limit=5&order=desc`,
          orgId
        );
        messages = Array.isArray(messagesResponse)
          ? messagesResponse.reverse()
          : [];
      } catch (detailError) {
        console.warn('Could not fetch detailed ticket context:', detailError);
        // Continue with basic ticket info
      }

      // Prepare context and build query
      const context = prepareTicketContext(
        ticketDetails as unknown as Record<string, unknown>,
        messages
      );
      const query = buildAISuggestionQuery(context);

      if (!orgId) {
        toast.error('Organization context not loaded', {
          id: 'ai-' + ticket.id,
        });
        return;
      }

      // Make AI request using api client
      const aiResponseData = await api.post(
        `/api/tickets/${ticket.id}/chat`,
        {
          query: query,
        },
        orgId
      );

      toast.success('AI suggestion ready!', { id: 'ai-' + ticket.id });

      // Show in modal instead of alert
      setAiResponse(aiResponseData);
      setCurrentAiTicket(ticket.id);
      setAiModalOpen(true);
    } catch (error: any) {
      console.error('AI suggestion failed:', error);

      // Handle rate limiting
      if (error.message && error.message.includes('429')) {
        const cooldownSeconds = 8;
        setAiCooldowns(prev => ({
          ...prev,
          [ticket.id]: Date.now() + cooldownSeconds * 1000,
        }));
        toast.error(`Rate limited. Please wait ${cooldownSeconds} seconds.`, {
          id: 'ai-' + ticket.id,
        });
      } else if (error.message && error.message.includes('401')) {
        toast.error('Authentication required. Please log in again.', {
          id: 'ai-' + ticket.id,
        });
        router.push('/login');
      } else if (error.message && error.message.includes('404')) {
        toast.error('Ticket not found', { id: 'ai-' + ticket.id });
      } else if (
        error instanceof TypeError &&
        error.message.includes('fetch')
      ) {
        toast.error('Network error. Please check your connection.', {
          id: 'ai-' + ticket.id,
        });
      } else {
        toast.error(`AI request failed: ${error.message || 'Unknown error'}`, {
          id: 'ai-' + ticket.id,
        });
      }
    } finally {
      setActionLoading(null);
    }
  };

  // AI Modal Handlers
  const handleAiInsert = async (content: string) => {
    if (!currentAiTicket || !orgId) {
      toast.error('No ticket context');
      return;
    }
    try {
      await api.post(
        `/api/tickets/${currentAiTicket}/messages`,
        { body: content },
        orgId
      );
      toast.success('Reply sent to customer');
      setAiModalOpen(false);
      addAuditMessage(
        currentAiTicket,
        `AI drafted reply sent (confidence ${Math.round((aiResponse?.confidence || 0) * 100)}%)`
      );
      await loadTickets();
    } catch (error) {
      console.error('Failed to send draft:', error);
      toast.error('Failed to send reply');
    }
  };

  const handleAiEscalate = async () => {
    if (!currentAiTicket) return;

    try {
      await performAction(currentAiTicket, 'escalate', {
        reason: `AI suggested escalation (confidence ${Math.round((aiResponse?.confidence || 0) * 100)}%)`,
      });

      // Add audit trail
      addAuditMessage(
        currentAiTicket,
        `AI suggested escalation (confidence ${Math.round((aiResponse?.confidence || 0) * 100)}%)`
      );
    } catch (error) {
      console.error('Failed to escalate:', error);
      toast.error('Failed to escalate ticket');
    }
  };

  const handleAiFeedback = async (positive: boolean) => {
    const messageId = aiResponse?.message_id;
    if (!messageId || !orgId) return;
    try {
      await api.post(
        '/api/ai/feedback',
        {
          message_id: messageId,
          feedback_type: positive ? 'positive' : 'negative',
        },
        orgId
      );
      toast.success('Thanks for the feedback!');
    } catch {
      toast.error('Failed to submit feedback');
    }
  };

  const addAuditMessage = async (ticketId: string, message: string) => {
    if (!orgId) return;

    try {
      await api.post(
        `/api/tickets/${ticketId}/messages`,
        {
          body: `[system] ${message}`,
          sender_role: 'system',
        },
        orgId
      );
    } catch (error) {
      console.warn('Failed to add audit message:', error);
    }
  };

  const runBulkAutoAssign = async () => {
    if (!orgId) return;
    try {
      setBulkAssigning(true);
      const result = await api.post<{ assigned: number }>(
        '/api/admin/auto-assign',
        {},
        orgId
      );
      if (result.assigned === 0) {
        toast.info('No unassigned tickets — everything is already routed');
      } else {
        toast.success(
          `Auto-assigned ${result.assigned} ticket${result.assigned !== 1 ? 's' : ''} to your team`
        );
        loadTickets();
      }
    } catch {
      toast.error('Auto-assign failed');
    } finally {
      setBulkAssigning(false);
    }
  };

  const performAction = async (
    ticketId: string,
    action: string,
    payload: any = {}
  ) => {
    if (!orgId) {
      toast.error('Organization context not loaded', {
        id: 'action-' + ticketId,
      });
      return;
    }

    try {
      setActionLoading(ticketId + action);
      toast.loading(`Performing ${action}...`, { id: 'action-' + ticketId });

      // Use api client to automatically include org header
      await api.post(`/api/rep/tickets/${ticketId}/${action}`, payload, orgId);

      // Add specific toasts based on action
      const toastMessages: Record<string, string> = {
        assign: '✅ Ticket assigned to you',
        acknowledge: '✅ Attention acknowledged',
        escalate: '🚨 Ticket escalated to senior support',
        status:
          payload.status === 'closed'
            ? '✅ Ticket marked as closed'
            : '🔄 Ticket status updated',
        priority: `📌 Priority set to ${payload.priority}`,
      };

      toast.success(
        toastMessages[action] ||
          `✅ ${action.charAt(0).toUpperCase() + action.slice(1)} successful!`,
        {
          id: 'action-' + ticketId,
        }
      );

      // Optimistic UI update for certain actions
      if (action === 'assign') {
        setTickets(prev =>
          prev.map(t =>
            t.id === ticketId ? { ...t, assignee_id: user?.id } : t
          )
        );
      } else if (action === 'acknowledge') {
        setTickets(prev =>
          prev.map(t =>
            t.id === ticketId ? { ...t, needs_attention: false } : t
          )
        );
      }

      // Reload data to sync with server
      await loadTickets(true);
      await loadCounts(true);
    } catch (error) {
      console.error('Action failed:', error);
      const errorMsg =
        error instanceof Error ? error.message : `${action} failed`;
      toast.error(`❌ ${errorMsg}`, { id: 'action-' + ticketId });
    } finally {
      setActionLoading(null);
    }
  };

  const loadOrgMembers = async () => {
    if (!orgId || orgMembers.length > 0) return;
    try {
      setMembersLoading(true);
      const data: Array<{ user_id: string; user_email: string; role: string }> =
        await api.get(`/api/organizations/${orgId}/members`, orgId);
      setOrgMembers(
        data.filter(m => ['rep', 'admin', 'owner'].includes(m.role))
      );
    } catch (e) {
      console.error('Failed to load org members:', e);
    } finally {
      setMembersLoading(false);
    }
  };

  const handleEscalate = (ticketId: string) => {
    setEscalateDialog({ open: true, ticketId, reason: '', toUserId: '' });
    loadOrgMembers();
  };

  const submitEscalation = async () => {
    if (!escalateDialog.ticketId) return;
    await performAction(escalateDialog.ticketId, 'escalate', {
      reason: escalateDialog.reason || null,
      escalated_to_user_id: escalateDialog.toUserId || null,
    });
    setEscalateDialog({
      open: false,
      ticketId: null,
      reason: '',
      toUserId: '',
    });
  };

  const handleSetETR = (ticketId: string) => {
    const suggested = new Date(Date.now() + 24 * 60 * 60 * 1000);
    const pad = (n: number) => n.toString().padStart(2, '0');
    const local = `${suggested.getFullYear()}-${pad(suggested.getMonth() + 1)}-${pad(suggested.getDate())}T${pad(suggested.getHours())}:${pad(suggested.getMinutes())}`;
    setEtrDialog({ open: true, ticketId, value: local });
  };

  const submitETR = async () => {
    if (!etrDialog.ticketId || !etrDialog.value) return;
    await performAction(etrDialog.ticketId, 'etr', {
      expected_resolve_at: new Date(etrDialog.value).toISOString(),
    });
    setEtrDialog({ open: false, ticketId: null, value: '' });
  };

  const handleManualRefresh = async () => {
    toast.loading('Refreshing...', { id: 'manual-refresh' });
    try {
      await loadQueue();
      setLastRefresh(Date.now());
      toast.success('Refreshed successfully', { id: 'manual-refresh' });
    } catch (error) {
      toast.error('Refresh failed', { id: 'manual-refresh' });
    }
  };

  const handleStatusChange = (ticketId: string, status: string) => {
    performAction(ticketId, 'status', { status });
  };

  const handlePriorityChange = (ticketId: string, priority: string) => {
    performAction(ticketId, 'priority', { priority });
  };

  const handleKBIngest = async (sources: any[]) => {
    if (!orgId) {
      setShowKBModal(false);
      return;
    }

    for (const source of sources) {
      try {
        const formData = new FormData();

        if (source.type === 'file' && source.file) {
          formData.append('file', source.file);
        } else if (source.type === 'text' && source.content) {
          formData.append('raw_text', source.content);
          if (source.name) {
            formData.append('filename', source.name);
          }
        } else if (source.type === 'url' && source.url) {
          formData.append('raw_text', `URL: ${source.url}`);
          formData.append('filename', `url-${Date.now()}.txt`);
        }

        const { data: sessionData } = await supabase.auth.getSession();
        const token = sessionData?.session?.access_token;

        const response = await fetch(
          `${process.env.NEXT_PUBLIC_API_URL || 'http://127.0.0.1:8000'}/api/kb/ingest`,
          {
            method: 'POST',
            headers: {
              Authorization: `Bearer ${token}`,
              'X-Organization-ID': orgId, // Add org header
            },
            body: formData,
          }
        );

        if (!response.ok) {
          const errorText = await response.text();
          throw new Error(`Upload failed: ${errorText}`);
        }

        await response.json();
      } catch (error) {
        // non-fatal per source
      }
    }

    // Close modal after processing
    setShowKBModal(false);
  };

  // ── KB Draft from resolved ticket (agent action) ──
  const [kbDraftOpen, setKbDraftOpen] = useState(false);
  const [kbDraftLoading, setKbDraftLoading] = useState(false);
  const [kbDraftSaving, setKbDraftSaving] = useState(false);
  const [kbDraft, setKbDraft] = useState<{
    ticket_id: string;
    title: string;
    content: string;
  } | null>(null);

  const handleKBDraft = async (ticket: any) => {
    if (!orgId) return;
    setKbDraftLoading(true);
    setKbDraft(null);
    setKbDraftOpen(true);
    try {
      const draft = await api.post(
        `/api/tickets/${ticket.id}/ai-kb-draft`,
        {},
        orgId
      );
      setKbDraft(draft);
    } catch (error: any) {
      const msg =
        error?.message?.includes('402')
          ? 'AI features require Starter plan or above'
          : 'Failed to generate KB draft';
      toast.error(msg);
      setKbDraftOpen(false);
    } finally {
      setKbDraftLoading(false);
    }
  };

  const handleKBCreateFromDraft = async () => {
    if (!kbDraft || !orgId) return;
    setKbDraftSaving(true);
    try {
      const formData = new FormData();
      formData.append('raw_text', kbDraft.content);
      formData.append('filename', `${kbDraft.title}.md`);

      const { data: sessionData } = await supabase.auth.getSession();
      const token = sessionData?.session?.access_token;

      const response = await fetch(
        `${process.env.NEXT_PUBLIC_API_URL || 'http://127.0.0.1:8000'}/api/kb/ingest`,
        {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${token}`,
            'X-Organization-ID': orgId,
          },
          body: formData,
        }
      );

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`KB ingest failed: ${errorText}`);
      }

      toast.success('KB document created from ticket');
      setKbDraftOpen(false);
      setKbDraft(null);
    } catch {
      toast.error('Failed to create KB document');
    } finally {
      setKbDraftSaving(false);
    }
  };

  const formatTimeAgo = (dateString: string) => {
    const date = new Date(dateString);
    const now = new Date();
    const diffMs = now.getTime() - date.getTime();
    const diffMins = Math.floor(diffMs / 60000);
    const diffHours = Math.floor(diffMins / 60);
    const diffDays = Math.floor(diffHours / 24);

    if (diffMins < 1) return 'just now';
    if (diffMins < 60) return `${diffMins}m ago`;
    if (diffHours < 24) return `${diffHours}h ago`;
    return `${diffDays}d ago`;
  };

  const getStatusBadge = (status: string) => {
    const colors: Record<string, string> = {
      open: 'bg-blue-900/40 text-blue-300',
      in_progress: 'bg-yellow-900/40 text-yellow-300',
      resolved: 'bg-green-900/40 text-green-300',
      closed: 'bg-zinc-800 text-zinc-400',
      escalated: 'bg-red-900/40 text-red-300',
    };
    return colors[status] || 'bg-zinc-800 text-zinc-400';
  };

  const getPriorityBadge = (priority: string) => {
    const colors: Record<string, string> = {
      low: 'bg-green-900/40 text-green-300',
      normal: 'bg-blue-900/40 text-blue-300',
      high: 'bg-red-900/40 text-red-300',
      urgent: 'bg-red-900/60 text-red-200 font-semibold',
    };
    return colors[priority] || 'bg-zinc-800 text-zinc-400';
  };

  const getPriorityLevelBadge = (
    level: number
  ): { label: string; className: string } => {
    const map: Record<number, { label: string; className: string }> = {
      1: {
        label: 'P1',
        className: 'bg-red-900/50 text-red-300 border border-red-700',
      },
      2: {
        label: 'P2',
        className: 'bg-orange-900/50 text-orange-300 border border-orange-700',
      },
      3: {
        label: 'P3',
        className: 'bg-yellow-900/50 text-yellow-300 border border-yellow-700',
      },
      4: {
        label: 'P4',
        className: 'bg-blue-900/50 text-blue-300 border border-blue-700',
      },
      5: {
        label: 'P5',
        className: 'bg-indigo-900/50 text-indigo-300 border border-indigo-700',
      },
      6: {
        label: 'P6',
        className: 'bg-purple-900/50 text-purple-300 border border-purple-700',
      },
      7: {
        label: 'P7',
        className: 'bg-zinc-800 text-zinc-400 border border-zinc-700',
      },
    };
    return (
      map[level] ?? {
        label: `P${level}`,
        className: 'bg-zinc-800 text-zinc-400',
      }
    );
  };

  const formatElapsed = (fromStr: string): string => {
    const diffMs = now - new Date(fromStr).getTime();
    const totalMins = Math.floor(diffMs / 60000);
    const days = Math.floor(totalMins / 1440);
    const hours = Math.floor((totalMins % 1440) / 60);
    const mins = totalMins % 60;
    if (days > 0) return `${days}d ${hours}h`;
    if (hours > 0) return `${hours}h ${mins}m`;
    return `${mins}m`;
  };

  const handleAccept = async (ticket: QueueItem) => {
    if (!orgId) return;
    try {
      setActionLoading(ticket.id + 'accept');
      await api.post(`/api/rep/tickets/${ticket.id}/accept`, {}, orgId);
      toast.success('Ticket accepted — now in progress');
      setTickets(prev =>
        prev.map(t =>
          t.id === ticket.id
            ? {
                ...t,
                status: 'in_progress',
                accepted_at: new Date().toISOString(),
                needs_attention: false,
              }
            : t
        )
      );
      await loadCounts(true);
    } catch (err: any) {
      toast.error(err?.message || 'Failed to accept ticket');
    } finally {
      setActionLoading(null);
    }
  };

  const formatETR = (etrStr: string): { text: string; className: string } => {
    const etr = new Date(etrStr);
    const now = new Date();
    const diffMs = etr.getTime() - now.getTime();
    const diffHours = diffMs / (1000 * 60 * 60);
    const formatted = etr.toLocaleDateString(undefined, {
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    });
    if (diffMs < 0)
      return { text: `ETR: ${formatted} (overdue)`, className: 'text-danger' };
    if (diffHours < 2)
      return { text: `ETR: ${formatted}`, className: 'text-amber-600' };
    return { text: `ETR: ${formatted}`, className: 'text-muted-foreground' };
  };

  // AppLayout handles the auth loading + unauthenticated redirect.
  // We only gate on role here.
  if (!loading && user && !['rep', 'admin'].includes(user.role || '')) {
    return (
      <div className="min-h-screen grid place-items-center">
        <div className="text-center space-y-3">
          <h1 className="text-xl font-bold text-danger">Access Denied</h1>
          <p className="text-muted-foreground text-sm">
            You need rep or admin access to view this page.
          </p>
          <Link
            href="/dashboard"
            className="text-sm text-primary hover:underline"
          >
            Go to Dashboard
          </Link>
        </div>
      </div>
    );
  }

  return (
    <PageShell>
      <div className="flex flex-col space-y-8 p-8 bg-gradient-to-br from-background to-muted/20 min-h-screen">
        {/* Header */}
        <div className="flex flex-col space-y-2">
          <div className="flex items-center justify-between">
            <div>
              <h1 className="text-3xl font-bold tracking-tight">Rep Console</h1>
              <p className="text-muted-foreground">
                Manage customer support tickets and prioritize urgent issues
              </p>
            </div>
            <div className="flex flex-col sm:flex-row gap-3">
              {user?.role === 'admin' && (
                <Button
                  variant="outline"
                  className="min-h-[44px]"
                  onClick={runBulkAutoAssign}
                  disabled={bulkAssigning}
                >
                  <CheckCheck className="mr-2 h-4 w-4" />
                  {bulkAssigning ? 'Assigning…' : 'Auto-assign'}
                </Button>
              )}
              <Button
                onClick={() => setShowKBModal(true)}
                className="min-h-[44px]"
              >
                <Upload className="mr-2 h-4 w-4" />
                Upload Documents
              </Button>
              <KBIngestModal
                open={showKBModal}
                onOpenChange={setShowKBModal}
                onIngest={handleKBIngest}
              />
              <AIResponseModal
                open={aiModalOpen}
                onClose={() => {
                  setAiModalOpen(false);
                  setAiResponse(null);
                  setCurrentAiTicket(null);
                }}
                response={aiResponse}
                ticketId={currentAiTicket || ''}
                onInsert={handleAiInsert}
                onEscalate={handleAiEscalate}
                onFeedback={handleAiFeedback}
              />

              {/* KB draft from resolved ticket */}
              <Dialog open={kbDraftOpen} onOpenChange={setKbDraftOpen}>
                <DialogContent className="max-w-2xl max-h-[85vh] overflow-y-auto">
                  <DialogHeader>
                    <DialogTitle className="flex items-center gap-2">
                      <FileText className="h-5 w-5 text-indigo-500" />
                      KB Article Draft
                    </DialogTitle>
                  </DialogHeader>
                  {kbDraftLoading ? (
                    <div className="flex justify-center py-12">
                      <Loader2 className="h-6 w-6 animate-spin text-primary" />
                    </div>
                  ) : kbDraft ? (
                    <div className="space-y-4">
                      <div className="space-y-1">
                        <Label>Title</Label>
                        <Input
                          value={kbDraft.title}
                          onChange={e =>
                            setKbDraft({ ...kbDraft, title: e.target.value })
                          }
                        />
                      </div>
                      <div className="space-y-1">
                        <Label>Content</Label>
                        <Textarea
                          value={kbDraft.content}
                          onChange={e =>
                            setKbDraft({ ...kbDraft, content: e.target.value })
                          }
                          className="min-h-[240px] font-mono text-xs"
                        />
                      </div>
                      <DialogFooter>
                        <Button
                          variant="outline"
                          onClick={() => {
                            setKbDraftOpen(false);
                            setKbDraft(null);
                          }}
                        >
                          Cancel
                        </Button>
                        <Button
                          onClick={handleKBCreateFromDraft}
                          disabled={kbDraftSaving || !kbDraft.content.trim()}
                        >
                          {kbDraftSaving ? 'Creating…' : 'Create KB Document'}
                        </Button>
                      </DialogFooter>
                    </div>
                  ) : null}
                </DialogContent>
              </Dialog>

              {/* Escalation dialog */}
              <Dialog
                open={escalateDialog.open}
                onOpenChange={open =>
                  !open && setEscalateDialog(prev => ({ ...prev, open: false }))
                }
              >
                <DialogContent className="max-w-md">
                  <DialogHeader>
                    <DialogTitle>Escalate Ticket</DialogTitle>
                  </DialogHeader>
                  <div className="space-y-4 py-2">
                    <div className="space-y-1.5">
                      <Label htmlFor="escalate-to">
                        Escalate to (optional)
                      </Label>
                      <Select
                        value={escalateDialog.toUserId}
                        onValueChange={v =>
                          setEscalateDialog(prev => ({ ...prev, toUserId: v }))
                        }
                        disabled={membersLoading}
                      >
                        <SelectTrigger id="escalate-to">
                          <SelectValue
                            placeholder={
                              membersLoading
                                ? 'Loading members…'
                                : 'Select a rep or admin…'
                            }
                          />
                        </SelectTrigger>
                        <SelectContent>
                          {orgMembers.map(m => (
                            <SelectItem key={m.user_id} value={m.user_id}>
                              {m.user_email}{' '}
                              <span className="text-muted-foreground">
                                ({m.role})
                              </span>
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </div>
                    <div className="space-y-1.5">
                      <Label htmlFor="escalate-reason">Reason (optional)</Label>
                      <Textarea
                        id="escalate-reason"
                        placeholder="Why is this being escalated?"
                        value={escalateDialog.reason}
                        onChange={e =>
                          setEscalateDialog(prev => ({
                            ...prev,
                            reason: e.target.value,
                          }))
                        }
                        rows={3}
                      />
                    </div>
                  </div>
                  <DialogFooter>
                    <Button
                      variant="outline"
                      onClick={() =>
                        setEscalateDialog(prev => ({ ...prev, open: false }))
                      }
                    >
                      Cancel
                    </Button>
                    <Button variant="destructive" onClick={submitEscalation}>
                      <AlertTriangle className="h-4 w-4 mr-2" />
                      Escalate
                    </Button>
                  </DialogFooter>
                </DialogContent>
              </Dialog>

              {/* ETR dialog */}
              <Dialog
                open={etrDialog.open}
                onOpenChange={open =>
                  !open && setEtrDialog(prev => ({ ...prev, open: false }))
                }
              >
                <DialogContent className="max-w-sm">
                  <DialogHeader>
                    <DialogTitle>Set Expected Time to Resolve</DialogTitle>
                  </DialogHeader>
                  <div className="space-y-4 py-2">
                    <div className="space-y-1.5">
                      <Label htmlFor="etr-datetime">Expected resolve by</Label>
                      <input
                        id="etr-datetime"
                        type="datetime-local"
                        title="Expected resolve date and time"
                        className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
                        value={etrDialog.value}
                        onChange={e =>
                          setEtrDialog(prev => ({
                            ...prev,
                            value: e.target.value,
                          }))
                        }
                      />
                    </div>
                  </div>
                  <DialogFooter>
                    <Button
                      variant="outline"
                      onClick={() =>
                        setEtrDialog(prev => ({ ...prev, open: false }))
                      }
                    >
                      Cancel
                    </Button>
                    <Button onClick={submitETR} disabled={!etrDialog.value}>
                      <Clock className="h-4 w-4 mr-2" />
                      Confirm ETR
                    </Button>
                  </DialogFooter>
                </DialogContent>
              </Dialog>
            </div>
          </div>

          {/* Refresh Controls */}
          <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-2 pt-2 border-t">
            <span className="text-xs sm:text-sm text-muted-foreground">
              Last updated: {new Date(lastRefresh).toLocaleTimeString()}
            </span>
            <Button
              size="sm"
              variant="outline"
              onClick={handleManualRefresh}
              disabled={ticketsLoading || countsLoading}
              className="min-h-[44px] w-full sm:w-auto"
            >
              Refresh
            </Button>
          </div>
        </div>

        {/* Stats Overview - Mobile Optimized */}
        <div className="grid gap-3 grid-cols-2 lg:grid-cols-5">
          {[
            {
              label: 'Needs Attention',
              value: counts.needs_attention,
              icon: AlertTriangle,
              color: 'text-danger',
              bg: 'bg-danger/10',
              desc: 'Require immediate action',
            },
            {
              label: 'Open / Active',
              value: counts.open_active,
              icon: MessageSquare,
              color: 'text-primary',
              bg: 'bg-primary/10',
              desc: 'Currently open or active',
            },
            {
              label: 'Escalated',
              value: counts.escalated,
              icon: User,
              color: 'text-warning',
              bg: 'bg-warning/10',
              desc: 'Escalated to higher tiers',
            },
            {
              label: 'In Progress',
              value: counts.in_progress,
              icon: Clock,
              color: 'text-success',
              bg: 'bg-success/10',
              desc: 'Actively being worked on',
            },
            {
              label: 'Resolved Today',
              value: counts.resolved_today,
              icon: CheckCheck,
              color: 'text-info',
              bg: 'bg-info/10',
              desc: 'Closed since midnight',
            },
          ].map(stat => (
            <Card key={stat.label} className="relative overflow-hidden">
              <CardContent className="p-4 flex items-center gap-3">
                <div
                  className={`w-10 h-10 rounded-xl ${stat.bg} flex items-center justify-center shrink-0`}
                >
                  <stat.icon className={`h-5 w-5 ${stat.color}`} />
                </div>
                <div className="min-w-0">
                  <p className="text-xs text-muted-foreground truncate">
                    {stat.label}
                  </p>
                  <p
                    className={`text-2xl font-bold leading-tight ${stat.color}`}
                  >
                    {countsLoading ? (
                      <span className="inline-block h-7 w-10 bg-muted rounded animate-pulse" />
                    ) : (
                      stat.value
                    )}
                  </p>
                  <p className="text-[10px] text-muted-foreground truncate">
                    {stat.desc}
                  </p>
                </div>
              </CardContent>
            </Card>
          ))}
        </div>

        {/* Filters and Queue Management */}
        <Card className="backdrop-blur-sm bg-card/40 border border-border/50">
          <CardHeader>
            <CardTitle>Queue Management</CardTitle>
            <CardDescription>
              Filter and manage your ticket queue efficiently
            </CardDescription>
          </CardHeader>
          <CardContent>
            <div className="flex flex-col gap-4">
              {/* Lane Tabs - Mobile Optimized */}
              <Tabs
                value={currentLane}
                onValueChange={value => {
                  setCurrentLane(value);
                  setOffset(0);
                }}
              >
                <TabsList className="grid w-full grid-cols-2 sm:grid-cols-5 h-auto">
                  <TabsTrigger
                    value="needs_attention"
                    className="text-xs sm:text-sm min-h-[44px] whitespace-normal py-2"
                  >
                    <span className="hidden sm:inline">Needs Attention</span>
                    <span className="sm:hidden">Attention</span>
                  </TabsTrigger>
                  <TabsTrigger
                    value="open"
                    className="text-xs sm:text-sm min-h-[44px] whitespace-normal py-2"
                  >
                    <span className="hidden sm:inline">Open/Active</span>
                    <span className="sm:hidden">Open</span>
                  </TabsTrigger>
                  <TabsTrigger
                    value="escalated"
                    className="text-xs sm:text-sm min-h-[44px] whitespace-normal py-2"
                  >
                    Escalated
                  </TabsTrigger>
                  <TabsTrigger
                    value="resolved_today"
                    className="text-xs sm:text-sm min-h-[44px] whitespace-normal py-2"
                  >
                    <span className="hidden sm:inline">Resolved Today</span>
                    <span className="sm:hidden">Done</span>
                  </TabsTrigger>
                  <TabsTrigger
                    value="all"
                    className="text-xs sm:text-sm min-h-[44px] whitespace-normal py-2"
                  >
                    <span className="hidden sm:inline">All Tickets</span>
                    <span className="sm:hidden">All</span>
                  </TabsTrigger>
                </TabsList>
              </Tabs>

              {/* Search and Filters - Mobile Optimized */}
              <div className="flex flex-col gap-3">
                <div className="flex-1">
                  <Input
                    type="text"
                    placeholder="Search tickets..."
                    value={searchQuery}
                    onChange={e => {
                      setSearchQuery(e.target.value);
                      setOffset(0);
                    }}
                    className="bg-background/50 min-h-[44px] text-base"
                  />
                </div>
                <div className="flex items-center gap-2">
                  <Checkbox
                    id="mine-only"
                    checked={mineOnly}
                    onCheckedChange={checked => {
                      setMineOnly(checked as boolean);
                      setOffset(0);
                    }}
                    className="min-h-[24px] min-w-[24px]"
                  />
                  <label
                    htmlFor="mine-only"
                    className="text-sm font-medium cursor-pointer"
                  >
                    My tickets only
                  </label>
                </div>
              </div>
            </div>
          </CardContent>
        </Card>

        {/* Tickets List */}
        <m.div
          className="space-y-4"
          variants={v.list}
          initial="initial"
          animate="animate"
        >
          {(ticketsLoading && tickets.length === 0) || switchingOrg ? (
            <RepQueueSkeleton />
          ) : !ticketsLoading && tickets.length === 0 ? (
            <div className="flex flex-col items-center py-16 text-muted-foreground gap-3">
              <div className="w-16 h-16 rounded-full bg-primary/10 flex items-center justify-center">
                <svg
                  className="w-8 h-8 text-primary/40"
                  fill="none"
                  viewBox="0 0 24 24"
                  stroke="currentColor"
                >
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth={1.5}
                    d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z"
                  />
                </svg>
              </div>
              <p className="font-medium text-lg">Queue is clear</p>
              <p className="text-sm text-center max-w-xs">
                No tickets in this lane right now. New tickets assigned to you
                will appear here.
              </p>
            </div>
          ) : (
            tickets.map(ticket => {
              const age = getTicketAge(ticket.created_at);

              return (
                <m.div key={ticket.id} variants={v.item}>
                  <Card
                    className={cn(
                      'relative overflow-hidden hover:shadow-lg transition-all duration-200 bg-surface border',
                      age.urgent && 'border-l-4 border-l-red-500'
                    )}
                  >
                    {ticket.needs_attention && (
                      <div className="absolute top-0 left-0 w-1 h-full bg-danger" />
                    )}
                    <CardContent className="p-4 sm:p-6">
                      <div className="flex flex-col gap-4">
                        <div className="flex-1 space-y-3">
                          {/* Title and Flagged Status */}
                          <div className="flex flex-col sm:flex-row sm:items-center gap-2 sm:gap-3">
                            <Link
                              href={`/tickets/${ticket.id}`}
                              className="text-base sm:text-lg font-semibold text-primary hover:underline line-clamp-2 sm:line-clamp-1 min-h-[44px] flex items-center"
                            >
                              {ticket.title}
                            </Link>
                            <div className="flex items-center gap-2 flex-wrap">
                              {ticket.needs_attention && (
                                <Badge
                                  variant="destructive"
                                  className="text-xs"
                                >
                                  <AlertTriangle className="mr-1 h-3 w-3" />
                                  FLAGGED
                                </Badge>
                              )}
                              {ticket.priority === 'urgent' && (
                                <Badge
                                  variant="destructive"
                                  className="text-xs"
                                >
                                  🔥 Urgent
                                </Badge>
                              )}
                            </div>
                          </div>

                          {/* Metadata - Mobile Optimized */}
                          <div className="flex flex-wrap items-center gap-2 sm:gap-4 text-xs sm:text-sm">
                            <StatusBadge
                              status={
                                ticket.status as
                                  | 'escalated'
                                  | 'open'
                                  | 'in_progress'
                                  | 'resolved'
                                  | 'closed'
                              }
                            />
                            <Badge
                              variant={
                                ticket.priority === 'high'
                                  ? 'destructive'
                                  : ticket.priority === 'normal'
                                    ? 'default'
                                    : 'secondary'
                              }
                            >
                              {ticket.priority}
                            </Badge>
                            {ticket.priority_level != null &&
                              (() => {
                                const { label, className } =
                                  getPriorityLevelBadge(ticket.priority_level!);
                                return (
                                  <span
                                    className={cn(
                                      'text-xs font-semibold px-1.5 py-0.5 rounded',
                                      className
                                    )}
                                  >
                                    {label}
                                  </span>
                                );
                              })()}
                            {ticket.status === 'escalated' &&
                              ticket.escalated_to_name && (
                                <Badge
                                  variant="outline"
                                  className="text-xs border-orange-400 text-orange-700"
                                >
                                  <User className="mr-1 h-3 w-3" />
                                  Escalated to: {ticket.escalated_to_name}
                                </Badge>
                              )}
                            {ticket.expected_resolve_at &&
                              (() => {
                                const { text, className } = formatETR(
                                  ticket.expected_resolve_at
                                );
                                return (
                                  <div
                                    className={cn(
                                      'flex items-center gap-1 text-xs font-medium',
                                      className
                                    )}
                                  >
                                    <Clock className="h-3 w-3" />
                                    {text}
                                  </div>
                                );
                              })()}
                            <div className="flex items-center gap-1 text-muted-foreground">
                              <User className="h-3 w-3" />
                              <span className="hidden sm:inline">
                                {ticket.assignee_id ? 'Assigned' : 'Unassigned'}
                              </span>
                              <span className="sm:hidden">
                                {ticket.assignee_id ? 'Asgnd' : 'Free'}
                              </span>
                            </div>
                            <div className="flex items-center gap-1 text-muted-foreground">
                              <MessageSquare className="h-3 w-3" />
                              {ticket.message_count}
                            </div>
                            <div className="flex items-center gap-2 text-muted-foreground">
                              <Clock className="h-3 w-3 shrink-0" />
                              <span
                                className={cn(
                                  age.urgent && 'text-danger font-medium'
                                )}
                              >
                                {age.text}
                              </span>
                              {age.urgent && (
                                <Badge
                                  variant="destructive"
                                  className="text-xs"
                                >
                                  OVERDUE
                                </Badge>
                              )}
                            </div>
                            <div className="hidden sm:flex items-center gap-1 text-muted-foreground">
                              <MessageSquare className="h-3 w-3 shrink-0" />
                              <span className="text-xs">
                                {formatTimeAgo(ticket.last_message_at)}
                              </span>
                            </div>
                            {ticket.status === 'in_progress' &&
                              ticket.accepted_at && (
                                <div className="flex items-center gap-1 text-xs font-medium text-success">
                                  <Clock className="h-3 w-3" />
                                  In progress:{' '}
                                  {formatElapsed(ticket.accepted_at)}
                                </div>
                              )}
                          </div>
                        </div>

                        {/* Action Bar */}
                        <RepActionBar
                          ticketId={ticket.id}
                          status={
                            ticket.status as
                              | 'open'
                              | 'resolved'
                              | 'closed'
                              | 'in_progress'
                              | 'escalated'
                          }
                          priority={
                            ticket.priority as 'low' | 'normal' | 'high'
                          }
                          quickActions={[
                            {
                              id: 'respond',
                              label: 'Respond',
                              description: 'Send message to customer',
                              icon: MessageSquare,
                              color: 'text-blue-500',
                              onClick: () => handleQuickRespond(ticket),
                            },
                            {
                              id: 'call',
                              label: 'Call',
                              description: 'Start phone call',
                              icon: Phone,
                              color: 'text-green-500',
                              onClick: () => handleQuickCall(ticket),
                            },
                            {
                              id: 'email',
                              label: 'Email',
                              description: 'Send email update',
                              icon: Mail,
                              color: 'text-purple-500',
                              onClick: () => handleQuickEmail(ticket),
                            },
                            ...(can('ai_rag')
                              ? [
                                  {
                                    id: 'ai-assist',
                                    label: (() => {
                                      const cooldownEnd =
                                        aiCooldowns[ticket.id];
                                      if (
                                        cooldownEnd &&
                                        cooldownEnd > Date.now()
                                      ) {
                                        const remainingSeconds = Math.ceil(
                                          (cooldownEnd - Date.now()) / 1000
                                        );
                                        return `AI (${remainingSeconds}s)`;
                                      }
                                      return 'Get AI Suggestion';
                                    })(),
                                    description: (() => {
                                      const cooldownEnd =
                                        aiCooldowns[ticket.id];
                                      if (
                                        cooldownEnd &&
                                        cooldownEnd > Date.now()
                                      ) {
                                        return 'Rate limited - please wait';
                                      }
                                      return 'AI will analyze this ticket and suggest a response';
                                    })(),
                                    icon: Bot,
                                    color:
                                      aiCooldowns[ticket.id] &&
                                      aiCooldowns[ticket.id] > Date.now()
                                        ? 'text-muted-foreground'
                                        : 'text-primary',
                                    onClick: () => {
                                      const cooldownEnd =
                                        aiCooldowns[ticket.id];
                                      if (
                                        cooldownEnd &&
                                        cooldownEnd > Date.now()
                                      ) {
                                        const remainingSeconds = Math.ceil(
                                          (cooldownEnd - Date.now()) / 1000
                                        );
                                        toast.error(
                                          `Please wait ${remainingSeconds} seconds`,
                                          { id: 'ai-cooldown-' + ticket.id }
                                        );
                                        return;
                                      }
                                      handleQuickAI(ticket);
                                    },
                                  },
                                ]
                              : []),
                            ...(can('ai_rag') &&
                            can('kb') &&
                            ['resolved', 'closed'].includes(ticket.status)
                              ? [
                                  {
                                    id: 'kb-draft',
                                    label: 'Draft KB Article',
                                    description:
                                      'AI summarises this ticket into a knowledge base article',
                                    icon: FileText,
                                    color: 'text-indigo-500',
                                    onClick: () => handleKBDraft(ticket),
                                  },
                                ]
                              : []),
                          ]}
                          primaryActions={[
                            ...(['open', 'escalated'].includes(ticket.status)
                              ? [
                                  {
                                    id: 'accept',
                                    label:
                                      actionLoading === ticket.id + 'accept'
                                        ? 'Accepting…'
                                        : 'Accept',
                                    icon: CheckCircle,
                                    variant: 'default' as const,
                                    onClick: () => handleAccept(ticket),
                                    disabled:
                                      actionLoading?.startsWith(ticket.id) ||
                                      false,
                                  },
                                ]
                              : []),
                            {
                              id: 'assign',
                              label: 'Assign to Me',
                              icon: User,
                              variant: 'secondary',
                              onClick: () =>
                                performAction(ticket.id, 'assign', {}),
                              disabled:
                                actionLoading?.startsWith(ticket.id) || false,
                            },
                            ...(ticket.needs_attention
                              ? [
                                  {
                                    id: 'acknowledge',
                                    label: 'Acknowledge',
                                    icon: CheckCircle,
                                    variant: 'outline' as const,
                                    onClick: () =>
                                      performAction(
                                        ticket.id,
                                        'acknowledge',
                                        {}
                                      ),
                                    disabled:
                                      actionLoading?.startsWith(ticket.id) ||
                                      false,
                                  },
                                ]
                              : []),
                            {
                              id: 'escalate',
                              label: 'Escalate',
                              icon: AlertTriangle,
                              variant: 'destructive',
                              onClick: () => handleEscalate(ticket.id),
                              disabled:
                                actionLoading?.startsWith(ticket.id) || false,
                            },
                            {
                              id: 'set-etr',
                              label: ticket.expected_resolve_at
                                ? 'Update ETR'
                                : 'Set ETR',
                              icon: Clock,
                              variant: 'outline' as const,
                              onClick: () => handleSetETR(ticket.id),
                              disabled:
                                actionLoading?.startsWith(ticket.id) || false,
                            },
                          ]}
                        />
                      </div>
                    </CardContent>
                  </Card>
                </m.div>
              );
            })
          )}
        </m.div>

        {/* AI Assistant */}
        <AIMessage
          content="I'm here to help you manage your ticket queue efficiently. Use 'AI Suggestion' on any ticket to get a draft reply."
          type="suggestion"
          showActions={false}
        />

        {/* Pagination */}
        {total > limit && (
          <Card>
            <CardContent className="p-6">
              <div className="flex justify-center items-center gap-4">
                <Button
                  variant="outline"
                  onClick={() => setOffset(Math.max(0, offset - limit))}
                  disabled={offset === 0}
                >
                  Previous
                </Button>
                <div className="text-sm text-muted-foreground">
                  Showing {offset + 1}-{Math.min(offset + limit, total)} of{' '}
                  {total} tickets
                </div>
                <Button
                  variant="outline"
                  onClick={() => setOffset(offset + limit)}
                  disabled={offset + limit >= total}
                >
                  Next
                </Button>
              </div>
            </CardContent>
          </Card>
        )}
      </div>
    </PageShell>
  );
}
