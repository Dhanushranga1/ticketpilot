'use client';

import { useState, useRef, useCallback, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { motion, AnimatePresence } from 'framer-motion';
import { supabase } from '@/lib/supabaseClient';
import { useOrganization } from '@/contexts/OrganizationContext';
import {
  Building2,
  BookOpen,
  Users,
  Rocket,
  CheckCircle2,
  Upload,
  Plus,
  Loader2,
  ArrowRight,
  Clock,
  Ticket,
  Zap,
  BookMarked,
  UserPlus,
} from 'lucide-react';

const API_BASE = (
  process.env.NEXT_PUBLIC_API_URL ||
  process.env.NEXT_PUBLIC_API_BASE ||
  'http://127.0.0.1:8000'
).replace(/\/$/, '');

async function getToken(): Promise<string> {
  const { data } = await supabase.auth.getSession();
  return data?.session?.access_token ?? '';
}

// ─── Step metadata ────────────────────────────────────────────────────────────

const STEPS = [
  {
    id: 1,
    icon: Building2,
    label: 'Workspace',
    time: '~30 sec',
    headline: 'Your workspace,\nyour brand.',
    sub: 'This is what your team and customers will see. Pick a name that means something.',
    accent: 'from-indigo-600 to-indigo-400',
    iconBg: 'bg-indigo-500/10 border-indigo-500/25',
    iconColor: 'text-indigo-400',
  },
  {
    id: 2,
    icon: BookOpen,
    label: 'Knowledge',
    time: '~2 min',
    headline: 'Answers, not\nguesswork.',
    sub: 'Every document you upload becomes an AI citation. Reps stop copy-pasting and start linking.',
    accent: 'from-violet-600 to-violet-400',
    iconBg: 'bg-violet-500/10 border-violet-500/25',
    iconColor: 'text-violet-400',
  },
  {
    id: 3,
    icon: Zap,
    label: 'AI Engine',
    time: '~15 sec',
    headline: 'Your AI,\nyour keys.',
    sub: 'TicketPilot runs on bring-your-own-key AI. See what engine is connected to your workspace.',
    accent: 'from-amber-600 to-amber-400',
    iconBg: 'bg-amber-500/10 border-amber-500/25',
    iconColor: 'text-amber-400',
  },
  {
    id: 4,
    icon: Users,
    label: 'Team',
    time: '~1 min',
    headline: 'Faster\ntogether.',
    sub: "Reps route smarter when CASPER knows the team. Add them now — they'll get email invites.",
    accent: 'from-emerald-600 to-emerald-400',
    iconBg: 'bg-emerald-500/10 border-emerald-500/25',
    iconColor: 'text-emerald-400',
  },
  {
    id: 5,
    icon: Rocket,
    label: 'Launch',
    time: 'Done',
    headline: "You're live.",
    sub: "Everything is working from minute one. Here's what CASPER is already doing for you.",
    accent: 'from-indigo-600 to-violet-500',
    iconBg: 'bg-indigo-500/10 border-indigo-500/25',
    iconColor: 'text-indigo-400',
  },
];

// ─── Confetti ──────────────────────────────────────────────────────────────────

const CONFETTI_COLORS = [
  'bg-indigo-500',
  'bg-violet-500',
  'bg-emerald-500',
  'bg-amber-400',
  'bg-rose-500',
  'bg-sky-400',
];

function Confetti() {
  const dots = Array.from({ length: 24 }, (_, i) => {
    const angle = (i / 24) * 2 * Math.PI;
    const dist = 60 + Math.random() * 60;
    return {
      x: Math.cos(angle) * dist,
      y: Math.sin(angle) * dist,
      color: CONFETTI_COLORS[i % CONFETTI_COLORS.length],
      size: 4 + Math.random() * 4,
      delay: Math.random() * 0.3,
    };
  });

  return (
    <div className="absolute inset-0 pointer-events-none flex items-center justify-center overflow-hidden">
      {dots.map((d, i) => (
        <motion.div
          key={i}
          className={`absolute rounded-full ${d.color}`}
          style={{ width: d.size, height: d.size }}
          initial={{ x: 0, y: 0, opacity: 1, scale: 1 }}
          animate={{ x: d.x, y: d.y, opacity: 0, scale: 0 }}
          transition={{
            duration: 0.8 + Math.random() * 0.4,
            delay: d.delay,
            ease: 'easeOut',
          }}
        />
      ))}
    </div>
  );
}

// ─── Left panel ───────────────────────────────────────────────────────────────

function LeftPanel({ step }: { step: number }) {
  const s = STEPS[step - 1];
  const timeRemaining = STEPS.slice(step - 1).filter(
    s => s.time !== 'Done'
  ).length;

  return (
    <div
      className={`hidden lg:flex flex-col justify-between h-full p-10 bg-gradient-to-br ${s.accent} relative overflow-hidden`}
    >
      {/* Background texture */}
      <div className="absolute inset-0 opacity-10">
        <div className="absolute top-0 left-0 w-64 h-64 rounded-full bg-white blur-3xl -translate-x-1/2 -translate-y-1/2" />
        <div className="absolute bottom-0 right-0 w-96 h-96 rounded-full bg-white blur-3xl translate-x-1/4 translate-y-1/4" />
      </div>

      {/* Logo */}
      <div className="flex items-center gap-2.5 relative z-10">
        <div className="w-8 h-8 bg-white/20 rounded-lg flex items-center justify-center backdrop-blur-sm">
          <Ticket className="w-4 h-4 text-white" />
        </div>
        <span className="font-bold text-white text-base tracking-tight">
          TicketPilot
        </span>
      </div>

      {/* Step-specific content */}
      <AnimatePresence mode="wait">
        <motion.div
          key={step}
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: -20 }}
          transition={{ duration: 0.4 }}
          className="relative z-10"
        >
          <h2 className="text-3xl font-bold text-white leading-tight whitespace-pre-line mb-4">
            {s.headline}
          </h2>
          <p className="text-white/75 text-sm leading-relaxed max-w-xs">
            {s.sub}
          </p>
        </motion.div>
      </AnimatePresence>

      {/* Footer — time remaining */}
      <div className="relative z-10 flex items-center gap-2 text-white/60 text-xs">
        <Clock className="w-3.5 h-3.5" />
        <span>
          {timeRemaining > 0
            ? `Step ${step} of ${STEPS.length} · ~${timeRemaining} min remaining`
            : 'Setup complete'}
        </span>
      </div>
    </div>
  );
}

// ─── Progress bar ─────────────────────────────────────────────────────────────

function ProgressBar({ step, total }: { step: number; total: number }) {
  const pct = Math.round((step / total) * 100);
  return (
    <div className="w-full h-1 bg-zinc-800 rounded-full overflow-hidden mb-8">
      <motion.div
        className="h-full bg-indigo-500 rounded-full"
        initial={{ width: 0 }}
        animate={{ width: `${pct}%` }}
        transition={{ duration: 0.5, ease: 'easeInOut' }}
      />
    </div>
  );
}

// ─── Step 1 ───────────────────────────────────────────────────────────────────

function Step1({
  onNext,
  orgId,
  initialName,
}: {
  onNext: () => void;
  orgId: string;
  initialName: string;
}) {
  const [name, setName] = useState(initialName);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  const handleNext = async () => {
    const trimmed = name.trim();
    if (!trimmed) {
      setError('Workspace name is required');
      return;
    }
    setSaving(true);
    setError('');
    try {
      const token = await getToken();
      const res = await fetch(`${API_BASE}/api/organizations/${orgId}`, {
        method: 'PATCH',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
          'X-Organization-ID': orgId,
        },
        body: JSON.stringify({ name: trimmed }),
      });
      if (!res.ok) throw new Error(await res.text());
      onNext();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to save');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="space-y-5">
      <div>
        <div className="w-10 h-10 rounded-xl bg-indigo-500/10 border border-indigo-500/25 flex items-center justify-center mb-4">
          <Building2 className="w-5 h-5 text-indigo-400" />
        </div>
        <h2 className="text-xl font-bold text-white mb-1">
          Name your workspace
        </h2>
        <p className="text-sm text-zinc-400">
          This is what your team and customers will see.
        </p>
      </div>

      <div>
        <label className="block text-sm font-medium text-zinc-300 mb-1.5">
          Workspace name
        </label>
        <input
          autoFocus
          value={name}
          onChange={e => {
            setName(e.target.value);
            setError('');
          }}
          onKeyDown={e => e.key === 'Enter' && handleNext()}
          placeholder="Acme Support"
          className="w-full bg-zinc-800 border border-zinc-700 rounded-lg px-3.5 py-2.5 text-sm text-white placeholder-zinc-500 focus:outline-none focus:ring-2 focus:ring-indigo-500/50 focus:border-indigo-500 transition-colors"
        />
        {error && <p className="mt-1.5 text-xs text-red-400">{error}</p>}
      </div>

      <button
        type="button"
        onClick={handleNext}
        disabled={saving || !name.trim()}
        className="w-full flex items-center justify-center gap-2 bg-indigo-600 hover:bg-indigo-500 disabled:opacity-50 disabled:cursor-not-allowed text-white text-sm font-medium rounded-lg px-4 py-2.5 transition-colors"
      >
        {saving ? (
          <Loader2 className="w-4 h-4 animate-spin" />
        ) : (
          <>
            Continue <ArrowRight className="w-4 h-4" />
          </>
        )}
      </button>
    </div>
  );
}

// ─── Step 2 ───────────────────────────────────────────────────────────────────

function Step2({
  onNext,
  onSkip,
  orgId,
}: {
  onNext: () => void;
  onSkip: () => void;
  orgId: string;
}) {
  const fileRef = useRef<HTMLInputElement>(null);
  const [file, setFile] = useState<File | null>(null);
  const [dragging, setDragging] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [done, setDone] = useState(false);
  const [error, setError] = useState('');

  const handleUpload = async () => {
    if (!file) return;
    setUploading(true);
    setError('');
    try {
      const token = await getToken();
      const form = new FormData();
      form.append('file', file);
      const res = await fetch(`${API_BASE}/api/kb/ingest`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'X-Organization-ID': orgId,
        },
        body: form,
      });
      if (!res.ok) throw new Error(await res.text());
      setDone(true);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Upload failed');
    } finally {
      setUploading(false);
    }
  };

  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setDragging(false);
    const dropped = e.dataTransfer.files[0];
    if (dropped) {
      setFile(dropped);
      setError('');
    }
  }, []);

  return (
    <div className="space-y-5">
      <div>
        <div className="w-10 h-10 rounded-xl bg-violet-500/10 border border-violet-500/25 flex items-center justify-center mb-4">
          <BookOpen className="w-5 h-5 text-violet-400" />
        </div>
        <h2 className="text-xl font-bold text-white mb-1">
          Add your first doc
        </h2>
        <p className="text-sm text-zinc-400">
          PDF, DOCX, Markdown, or text. CASPER embeds it so AI answers can cite
          it immediately.
        </p>
      </div>

      {done ? (
        <div className="flex items-center gap-2.5 text-emerald-400 bg-emerald-500/10 border border-emerald-500/20 rounded-lg px-4 py-3 text-sm">
          <CheckCircle2 className="w-4 h-4 shrink-0" />
          <span>
            <strong>{file?.name}</strong> uploaded and indexed.
          </span>
        </div>
      ) : (
        <>
          <div
            onClick={() => fileRef.current?.click()}
            onDragOver={e => {
              e.preventDefault();
              setDragging(true);
            }}
            onDragLeave={() => setDragging(false)}
            onDrop={handleDrop}
            className={`border-2 border-dashed rounded-xl p-6 text-center cursor-pointer transition-colors ${
              dragging
                ? 'border-indigo-500 bg-indigo-500/5'
                : 'border-zinc-700 hover:border-zinc-500'
            }`}
          >
            <Upload
              className={`w-6 h-6 mx-auto mb-2 transition-colors ${dragging ? 'text-indigo-400' : 'text-zinc-500'}`}
            />
            {file ? (
              <p className="text-sm text-zinc-300">{file.name}</p>
            ) : (
              <>
                <p className="text-sm text-zinc-400">
                  Drop a file here or{' '}
                  <span className="text-indigo-400 underline">
                    click to choose
                  </span>
                </p>
                <p className="text-xs text-zinc-600 mt-1">
                  PDF · DOCX · MD · TXT
                </p>
              </>
            )}
            <input
              ref={fileRef}
              type="file"
              title="Upload a knowledge base document"
              aria-label="Upload a knowledge base document"
              className="hidden"
              accept=".pdf,.docx,.md,.txt,.markdown"
              onChange={e => {
                setFile(e.target.files?.[0] ?? null);
                setError('');
              }}
            />
          </div>
          {error && <p className="text-xs text-red-400">{error}</p>}
          {file && (
            <button
              type="button"
              onClick={handleUpload}
              disabled={uploading}
              className="w-full flex items-center justify-center gap-2 bg-violet-600 hover:bg-violet-500 disabled:opacity-50 text-white text-sm font-medium rounded-lg px-4 py-2.5 transition-colors"
            >
              {uploading ? (
                <Loader2 className="w-4 h-4 animate-spin" />
              ) : (
                <>
                  <Upload className="w-4 h-4" /> Upload &amp; Index
                </>
              )}
            </button>
          )}
        </>
      )}

      <div className="flex gap-3">
        <button
          type="button"
          onClick={onSkip}
          className="flex-1 text-sm text-zinc-500 hover:text-zinc-300 border border-zinc-800 hover:border-zinc-700 rounded-lg px-4 py-2.5 transition-colors"
        >
          Skip for now
        </button>
        <button
          type="button"
          onClick={onNext}
          className="flex-1 flex items-center justify-center gap-2 bg-zinc-800 hover:bg-zinc-700 text-white text-sm font-medium rounded-lg px-4 py-2.5 transition-colors"
        >
          Continue <ArrowRight className="w-4 h-4" />
        </button>
      </div>
    </div>
  );
}

// ─── Step 3 ───────────────────────────────────────────────────────────────────

function Step3({ onNext, onSkip }: { onNext: () => void; onSkip: () => void }) {
  const [status, setStatus] = useState<{
    gen_model: string;
    embed_model: string;
    keys_configured: boolean;
  } | null>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    let active = true;
    fetch(`${API_BASE}/api/ai/status`)
      .then(res => (res.ok ? res.json() : Promise.reject(new Error('unavailable'))))
      .then(data => {
        if (active) setStatus(data);
      })
      .catch(() => {
        if (active) setError('Could not reach AI engine');
      });
    return () => {
      active = false;
    };
  }, []);

  return (
    <div className="space-y-5">
      <div>
        <div className="w-10 h-10 rounded-xl bg-amber-500/10 border border-amber-500/25 flex items-center justify-center mb-4">
          <Zap className="w-5 h-5 text-amber-400" />
        </div>
        <h2 className="text-xl font-bold text-white mb-1">AI engine status</h2>
        <p className="text-sm text-zinc-400">
          AI runs on bring-your-own-key providers. During the pilot, we configure
          keys for you.
        </p>
      </div>

      {status ? (
        <div className="space-y-2 rounded-xl border border-zinc-800 bg-zinc-900/60 p-4">
          <div className="flex items-center justify-between text-sm">
            <span className="text-zinc-400">Generation model</span>
            <span className="font-mono text-zinc-200">{status.gen_model}</span>
          </div>
          <div className="flex items-center justify-between text-sm">
            <span className="text-zinc-400">Embedding model</span>
            <span className="font-mono text-zinc-200">{status.embed_model}</span>
          </div>
          <div className="flex items-center justify-between text-sm">
            <span className="text-zinc-400">Status</span>
            {status.keys_configured ? (
              <span className="flex items-center gap-1.5 text-emerald-400">
                <CheckCircle2 className="w-4 h-4" /> Connected
              </span>
            ) : (
              <span className="flex items-center gap-1.5 text-amber-400">
                <Clock className="w-4 h-4" /> Keys not configured yet
              </span>
            )}
          </div>
          {!status.keys_configured && (
            <p className="text-xs text-zinc-500 pt-1">
              Contact us to bring your own keys — AI chat and citations turn on
              immediately after.
            </p>
          )}
        </div>
      ) : (
        <p className="text-sm text-zinc-500">
          {error || 'Checking AI engine…'}
        </p>
      )}

      <div className="flex gap-3">
        <button
          type="button"
          onClick={onSkip}
          className="flex-1 text-sm text-zinc-500 hover:text-zinc-300 border border-zinc-800 hover:border-zinc-700 rounded-lg px-4 py-2.5 transition-colors"
        >
          Skip for now
        </button>
        <button
          type="button"
          onClick={onNext}
          className="flex-1 flex items-center justify-center gap-2 bg-zinc-800 hover:bg-zinc-700 text-white text-sm font-medium rounded-lg px-4 py-2.5 transition-colors"
        >
          Continue <ArrowRight className="w-4 h-4" />
        </button>
      </div>
    </div>
  );
}

function Step4({
  onNext,
  onSkip,
  orgId,
}: {
  onNext: () => void;
  onSkip: () => void;
  orgId: string;
}) {
  const [email, setEmail] = useState('');
  const [role, setRole] = useState<'rep' | 'admin'>('rep');
  const [sent, setSent] = useState<{ email: string; role: string }[]>([]);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState('');

  const handleInvite = async () => {
    const trimmed = email.trim().toLowerCase();
    if (!trimmed.includes('@')) {
      setError('Enter a valid email');
      return;
    }
    if (sent.some(s => s.email === trimmed)) {
      setError('Already invited');
      return;
    }
    setSending(true);
    setError('');
    try {
      const token = await getToken();
      const res = await fetch(
        `${API_BASE}/api/organizations/${orgId}/invites`,
        {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${token}`,
            'Content-Type': 'application/json',
            'X-Organization-ID': orgId,
          },
          body: JSON.stringify({ email: trimmed, role }),
        }
      );
      if (!res.ok) throw new Error(await res.text());
      setSent(prev => [...prev, { email: trimmed, role }]);
      setEmail('');
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Invite failed');
    } finally {
      setSending(false);
    }
  };

  return (
    <div className="space-y-5">
      <div>
        <div className="w-10 h-10 rounded-xl bg-emerald-500/10 border border-emerald-500/25 flex items-center justify-center mb-4">
          <Users className="w-5 h-5 text-emerald-400" />
        </div>
        <h2 className="text-xl font-bold text-white mb-1">Invite your team</h2>
        <p className="text-sm text-zinc-400">
          Reps handle tickets; admins manage the workspace. Everyone gets an
          email invite.
        </p>
      </div>

      <div className="space-y-3">
        <div className="flex gap-2">
          <input
            value={email}
            onChange={e => {
              setEmail(e.target.value);
              setError('');
            }}
            onKeyDown={e => e.key === 'Enter' && handleInvite()}
            placeholder="teammate@company.com"
            type="email"
            className="flex-1 bg-zinc-800 border border-zinc-700 rounded-lg px-3.5 py-2.5 text-sm text-white placeholder-zinc-500 focus:outline-none focus:ring-2 focus:ring-indigo-500/50 focus:border-indigo-500 transition-colors"
          />
          <select
            value={role}
            title="Invite role"
            aria-label="Invite role"
            onChange={e => setRole(e.target.value as 'rep' | 'admin')}
            className="bg-zinc-800 border border-zinc-700 rounded-lg px-2.5 py-2.5 text-sm text-zinc-300 focus:outline-none focus:ring-2 focus:ring-indigo-500/50"
          >
            <option value="rep">Rep</option>
            <option value="admin">Admin</option>
          </select>
          <button
            type="button"
            onClick={handleInvite}
            disabled={sending || !email.trim()}
            className="flex items-center gap-1.5 bg-indigo-600 hover:bg-indigo-500 disabled:opacity-50 text-white text-sm font-medium rounded-lg px-3 py-2.5 transition-colors shrink-0"
          >
            {sending ? (
              <Loader2 className="w-4 h-4 animate-spin" />
            ) : (
              <Plus className="w-4 h-4" />
            )}
          </button>
        </div>

        {error && <p className="text-xs text-red-400">{error}</p>}

        {sent.length > 0 && (
          <div className="space-y-1.5">
            {sent.map(s => (
              <div
                key={s.email}
                className="flex items-center gap-2 bg-zinc-800/60 border border-zinc-700/50 rounded-lg px-3 py-2"
              >
                <CheckCircle2 className="w-3.5 h-3.5 text-emerald-400 shrink-0" />
                <span className="text-sm text-zinc-300 flex-1 truncate">
                  {s.email}
                </span>
                <span className="text-xs text-zinc-500 border border-zinc-700 rounded px-1.5 py-0.5 uppercase tracking-wider shrink-0">
                  {s.role}
                </span>
              </div>
            ))}
          </div>
        )}
      </div>

      <div className="flex gap-3">
        <button
          type="button"
          onClick={onSkip}
          className="flex-1 text-sm text-zinc-500 hover:text-zinc-300 border border-zinc-800 hover:border-zinc-700 rounded-lg px-4 py-2.5 transition-colors"
        >
          Skip for now
        </button>
        <button
          type="button"
          onClick={onNext}
          className="flex-1 flex items-center justify-center gap-2 bg-zinc-800 hover:bg-zinc-700 text-white text-sm font-medium rounded-lg px-4 py-2.5 transition-colors"
        >
          Continue <ArrowRight className="w-4 h-4" />
        </button>
      </div>
    </div>
  );
}

// ─── Step 4 ───────────────────────────────────────────────────────────────────

const HIGHLIGHTS = [
  {
    icon: Zap,
    color: 'text-indigo-400',
    bg: 'bg-indigo-500/10 border-indigo-500/20',
    label: 'CASPER auto-routes every incoming ticket',
  },
  {
    icon: BookMarked,
    color: 'text-violet-400',
    bg: 'bg-violet-500/10 border-violet-500/20',
    label: 'AI drafts cited answers from your KB',
  },
  {
    icon: CheckCircle2,
    color: 'text-emerald-400',
    bg: 'bg-emerald-500/10 border-emerald-500/20',
    label: 'P1–P7 priority scoring — zero manual triage',
  },
  {
    icon: UserPlus,
    color: 'text-orange-400',
    bg: 'bg-orange-500/10 border-orange-500/20',
    label: 'Confidence-based escalation to your reps',
  },
];

function Step5({
  orgId,
  refreshOrganizations,
}: {
  orgId: string;
  refreshOrganizations: () => Promise<void>;
}) {
  const router = useRouter();
  const [launching, setLaunching] = useState(false);
  const [showConfetti, setShowConfetti] = useState(true);

  const handleLaunch = async () => {
    setLaunching(true);
    try {
      const token = await getToken();
      await fetch(`${API_BASE}/api/organizations/${orgId}`, {
        method: 'PATCH',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
          'X-Organization-ID': orgId,
        },
        body: JSON.stringify({ settings: { onboarding_completed: true } }),
      });
      await refreshOrganizations();
      router.push('/dashboard');
    } catch {
      router.push('/dashboard');
    }
  };

  return (
    <div className="space-y-5">
      <div className="text-center">
        <div className="relative inline-flex mb-4">
          {showConfetti && <Confetti />}
          <div className="w-14 h-14 rounded-2xl bg-indigo-500/10 border border-indigo-500/25 flex items-center justify-center">
            <Rocket className="w-7 h-7 text-indigo-400" />
          </div>
        </div>
        <h2 className="text-xl font-bold text-white mb-1">
          You&apos;re all set!
        </h2>
        <p className="text-sm text-zinc-400">
          Here&apos;s what&apos;s already working from minute one:
        </p>
      </div>

      <div className="grid grid-cols-2 gap-2">
        {HIGHLIGHTS.map(h => (
          <div
            key={h.label}
            className={`flex items-start gap-2.5 p-3 rounded-xl border ${h.bg}`}
          >
            <h.icon className={`w-4 h-4 shrink-0 mt-0.5 ${h.color}`} />
            <span className="text-xs text-zinc-300 leading-snug">
              {h.label}
            </span>
          </div>
        ))}
      </div>

      <button
        type="button"
        onClick={handleLaunch}
        disabled={launching}
        onMouseEnter={() => setShowConfetti(false)}
        className="w-full flex items-center justify-center gap-2 bg-indigo-600 hover:bg-indigo-500 disabled:opacity-50 text-white text-sm font-semibold rounded-lg px-4 py-3 transition-colors"
      >
        {launching ? (
          <Loader2 className="w-4 h-4 animate-spin" />
        ) : (
          <>
            Open Dashboard <ArrowRight className="w-4 h-4" />
          </>
        )}
      </button>
    </div>
  );
}

// ─── Main wizard ──────────────────────────────────────────────────────────────

export default function OnboardingPage() {
  const [step, setStep] = useState(1);
  const { currentOrganization, refreshOrganizations } = useOrganization();
  const orgId = currentOrganization?.id ?? '';
  const orgName = currentOrganization?.name ?? '';
  const current = STEPS[step - 1];

  return (
    <div className="min-h-screen bg-zinc-950 flex">
      {/* Left brand panel */}
      <div className="w-[40%] shrink-0">
        <LeftPanel step={step} />
      </div>

      {/* Right form panel */}
      <div className="flex-1 flex flex-col items-center justify-center px-6 py-12 min-h-screen">
        <div className="w-full max-w-md">
          {/* Step indicator chip */}
          <div className="flex items-center justify-between mb-3">
            <div className="flex items-center gap-2 text-xs text-zinc-500">
              <current.icon className={`w-3.5 h-3.5 ${current.iconColor}`} />
              <span>
                Step {step} of {STEPS.length} — {current.label}
              </span>
            </div>
            <div className="flex items-center gap-1.5 text-xs text-zinc-600">
              <Clock className="w-3 h-3" />
              <span>{current.time}</span>
            </div>
          </div>

          {/* Progress bar */}
          <ProgressBar step={step} total={STEPS.length} />

          {/* Step card */}
          <AnimatePresence mode="wait">
            <motion.div
              key={step}
              initial={{ opacity: 0, x: 24 }}
              animate={{ opacity: 1, x: 0 }}
              exit={{ opacity: 0, x: -24 }}
              transition={{ duration: 0.25 }}
              className="bg-zinc-900 border border-zinc-800 rounded-2xl p-8"
            >
              {step === 1 && (
                <Step1
                  orgId={orgId}
                  initialName={orgName}
                  onNext={() => setStep(2)}
                />
              )}
              {step === 2 && (
                <Step2
                  orgId={orgId}
                  onNext={() => setStep(3)}
                  onSkip={() => setStep(3)}
                />
              )}
              {step === 3 && (
                <Step3 onNext={() => setStep(4)} onSkip={() => setStep(4)} />
              )}
              {step === 4 && (
                <Step4
                  orgId={orgId}
                  onNext={() => setStep(5)}
                  onSkip={() => setStep(5)}
                />
              )}
              {step === 5 && (
                <Step5
                  orgId={orgId}
                  refreshOrganizations={refreshOrganizations}
                />
              )}
            </motion.div>
          </AnimatePresence>
        </div>
      </div>
    </div>
  );
}
