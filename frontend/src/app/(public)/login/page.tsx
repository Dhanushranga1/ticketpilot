'use client';

import { useState, Suspense } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import Link from 'next/link';
import { motion } from 'framer-motion';
import { supabase } from '@/lib/supabaseClient';
import {
  Mail,
  Lock,
  Eye,
  EyeOff,
  ArrowRight,
  Loader2,
  CheckCircle2,
  BrainCircuit,
  BookOpenCheck,
  SlidersHorizontal,
} from 'lucide-react';

const highlights = [
  {
    icon: BrainCircuit,
    title: 'CASPER auto-routing',
    body: 'Every ticket is profiled and assigned to the right rep — zero manual triage.',
    color: 'text-indigo-400',
    bg: 'bg-indigo-500/10 border-indigo-500/20',
  },
  {
    icon: BookOpenCheck,
    title: 'Cited KB answers',
    body: 'AI drafts replies with inline [1][2] citations from your knowledge base.',
    color: 'text-violet-400',
    bg: 'bg-violet-500/10 border-violet-500/20',
  },
  {
    icon: SlidersHorizontal,
    title: 'P1–P7 priority scoring',
    body: 'Urgency and complexity scored automatically on every incoming ticket.',
    color: 'text-emerald-400',
    bg: 'bg-emerald-500/10 border-emerald-500/20',
  },
];

function LoginPageInner() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const redirectTo = searchParams.get('redirect') || '/dashboard';

  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [loading, setLoading] = useState(false);
  const [magicLoading, setMagicLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [magicSent, setMagicSent] = useState(false);
  const [success, setSuccess] = useState(false);

  const signIn = async () => {
    if (!email || !password) return;
    setLoading(true);
    setError(null);
    const { data, error } = await supabase.auth.signInWithPassword({
      email,
      password,
    });
    setLoading(false);
    if (error) {
      setError(error.message);
      return;
    }
    if (data.session?.access_token) {
      setSuccess(true);
      setTimeout(() => router.replace(redirectTo), 1200);
    } else {
      setError('Authentication failed: no token received');
    }
  };

  const signInMagic = async () => {
    if (!email) return;
    setMagicLoading(true);
    setError(null);
    const next =
      redirectTo !== '/dashboard'
        ? `?next=${encodeURIComponent(redirectTo)}`
        : '';
    const { error } = await supabase.auth.signInWithOtp({
      email,
      options: {
        emailRedirectTo: `${window.location.origin}/auth/confirm${next}`,
      },
    });
    setMagicLoading(false);
    if (error) {
      setError(error.message);
      return;
    }
    setMagicSent(true);
  };

  const resetPassword = async () => {
    if (!email) return;
    setMagicLoading(true);
    setError(null);
    const { error } = await supabase.auth.resetPasswordForEmail(email, {
      redirectTo: `${window.location.origin}/auth/callback?type=recovery`,
    });
    setMagicLoading(false);
    if (error) {
      setError(error.message);
      return;
    }
    setMagicSent(true);
  };

  if (success) {
    return (
      <main className="min-h-screen bg-zinc-950 flex items-center justify-center">
        <motion.div
          initial={{ scale: 0.9, opacity: 0 }}
          animate={{ scale: 1, opacity: 1 }}
          className="text-center space-y-4"
        >
          <div className="w-16 h-16 rounded-full bg-indigo-500/15 border border-indigo-500/25 flex items-center justify-center mx-auto">
            <CheckCircle2 className="w-8 h-8 text-indigo-400" />
          </div>
          <h1 className="text-xl font-bold text-white font-geist">
            Welcome back!
          </h1>
          <p className="text-sm text-zinc-400">
            Redirecting to your dashboard…
          </p>
        </motion.div>
      </main>
    );
  }

  return (
    <main className="min-h-screen bg-zinc-950 flex">
      {/* ── Left panel (desktop only) ── */}
      <div className="hidden lg:flex lg:w-[480px] xl:w-[520px] shrink-0 flex-col justify-between p-12 border-r border-zinc-800/60 bg-zinc-900/30">
        {/* Wordmark */}
        <span className="font-bold text-white text-lg font-geist tracking-tight">
          TicketPilot
        </span>

        {/* Centre copy */}
        <div className="space-y-8">
          <div>
            <h2 className="text-3xl font-bold text-white font-geist leading-snug mb-3">
              Support that thinks
              <br />
              before you do.
            </h2>
            <p className="text-zinc-400 text-sm leading-relaxed">
              CASPER profiles, prioritises, and routes every ticket the moment
              it arrives — so your team focuses on resolution, not triage.
            </p>
          </div>

          <div className="space-y-3">
            {highlights.map(h => {
              const Icon = h.icon;
              return (
                <div
                  key={h.title}
                  className={`flex items-start gap-3 rounded-xl border p-3.5 ${h.bg}`}
                >
                  <Icon className={`w-4 h-4 mt-0.5 shrink-0 ${h.color}`} />
                  <div>
                    <p className="text-sm font-semibold text-white">
                      {h.title}
                    </p>
                    <p className="text-xs text-zinc-400 mt-0.5 leading-relaxed">
                      {h.body}
                    </p>
                  </div>
                </div>
              );
            })}
          </div>
        </div>

        <p className="text-xs text-zinc-600">
          © 2026 TicketPilot. All rights reserved.
        </p>
      </div>

      {/* ── Right panel (form) ── */}
      <div className="flex-1 flex flex-col items-center justify-center px-6 py-12">
        {/* Mobile wordmark */}
        <span className="font-bold text-white text-lg font-geist mb-10 lg:hidden block">
          TicketPilot
        </span>

        <motion.div
          initial={{ opacity: 0, y: 16 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.35 }}
          className="w-full max-w-sm"
        >
          <div className="mb-8">
            <h1 className="text-2xl font-bold text-white font-geist mb-1.5">
              Welcome back
            </h1>
            <p className="text-sm text-zinc-400">
              Sign in to your account to continue.
            </p>
          </div>

          <div className="space-y-4">
            {/* Email */}
            <div>
              <label className="block text-sm font-medium text-zinc-300 mb-1.5">
                Email
              </label>
              <div className="relative">
                <Mail className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-zinc-500 pointer-events-none" />
                <input
                  type="email"
                  autoComplete="email"
                  autoFocus
                  placeholder="you@company.com"
                  value={email}
                  onChange={e => {
                    setEmail(e.target.value);
                    setError(null);
                  }}
                  onKeyDown={e => e.key === 'Enter' && !loading && signIn()}
                  disabled={loading}
                  className="w-full bg-zinc-800 border border-zinc-700 rounded-lg pl-9 pr-4 py-2.5 text-sm text-white placeholder-zinc-500 focus:outline-none focus:ring-1 focus:ring-indigo-500 focus:border-indigo-500 transition-colors disabled:opacity-50"
                />
              </div>
            </div>

            {/* Password */}
            <div>
              <div className="flex items-center justify-between mb-1.5">
                <label className="text-sm font-medium text-zinc-300">
                  Password
                </label>
                <button
                  type="button"
                  onClick={resetPassword}
                  disabled={!email || magicLoading}
                  className="text-xs text-zinc-500 hover:text-indigo-400 transition-colors disabled:opacity-40"
                >
                  Reset password
                </button>
              </div>
              <div className="relative">
                <Lock className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-zinc-500 pointer-events-none" />
                <input
                  type={showPassword ? 'text' : 'password'}
                  autoComplete="current-password"
                  placeholder="Your password"
                  value={password}
                  onChange={e => {
                    setPassword(e.target.value);
                    setError(null);
                  }}
                  onKeyDown={e => e.key === 'Enter' && !loading && signIn()}
                  disabled={loading}
                  className="w-full bg-zinc-800 border border-zinc-700 rounded-lg pl-9 pr-10 py-2.5 text-sm text-white placeholder-zinc-500 focus:outline-none focus:ring-1 focus:ring-indigo-500 focus:border-indigo-500 transition-colors disabled:opacity-50"
                />
                <button
                  type="button"
                  onClick={() => setShowPassword(v => !v)}
                  className="absolute right-3 top-1/2 -translate-y-1/2 text-zinc-500 hover:text-zinc-300 transition-colors"
                  tabIndex={-1}
                >
                  {showPassword ? (
                    <EyeOff className="w-4 h-4" />
                  ) : (
                    <Eye className="w-4 h-4" />
                  )}
                </button>
              </div>
            </div>

            {/* Error */}
            {error && (
              <motion.p
                initial={{ opacity: 0, y: -4 }}
                animate={{ opacity: 1, y: 0 }}
                className="text-xs text-red-400 bg-red-500/10 border border-red-500/20 rounded-lg px-3 py-2"
              >
                {error}
              </motion.p>
            )}

            {/* Sign in button */}
            <button
              type="button"
              onClick={signIn}
              disabled={loading || !email || !password}
              className="w-full flex items-center justify-center gap-2 bg-indigo-600 hover:bg-indigo-500 disabled:opacity-50 disabled:cursor-not-allowed text-white text-sm font-medium rounded-lg px-4 py-2.5 transition-colors"
            >
              {loading ? (
                <>
                  <Loader2 className="w-4 h-4 animate-spin" /> Signing in…
                </>
              ) : (
                <>
                  Sign in <ArrowRight className="w-4 h-4" />
                </>
              )}
            </button>

            {/* Divider */}
            <div className="flex items-center gap-3 py-1">
              <div className="flex-1 h-px bg-zinc-800" />
              <span className="text-xs text-zinc-600">or</span>
              <div className="flex-1 h-px bg-zinc-800" />
            </div>

            {/* Magic link */}
            {magicSent ? (
              <div className="flex items-center gap-2.5 text-emerald-400 bg-emerald-500/10 border border-emerald-500/20 rounded-lg px-4 py-3 text-sm">
                <CheckCircle2 className="w-4 h-4 shrink-0" />
                <span>Magic link sent — check your inbox.</span>
              </div>
            ) : (
              <button
                type="button"
                onClick={signInMagic}
                disabled={magicLoading || !email}
                className="w-full flex items-center justify-center gap-2 bg-zinc-800 hover:bg-zinc-700 disabled:opacity-50 disabled:cursor-not-allowed text-zinc-300 text-sm font-medium rounded-lg px-4 py-2.5 transition-colors border border-zinc-700"
              >
                {magicLoading ? (
                  <>
                    <Loader2 className="w-4 h-4 animate-spin" /> Sending…
                  </>
                ) : (
                  <>
                    <Mail className="w-4 h-4" /> Send magic link
                  </>
                )}
              </button>
            )}
          </div>

          <p className="mt-8 text-center text-sm text-zinc-500">
            No account?{' '}
            <Link
              href={
                redirectTo !== '/dashboard'
                  ? `/signup?redirect=${encodeURIComponent(redirectTo)}`
                  : '/signup'
              }
              className="text-indigo-400 hover:text-indigo-300 transition-colors font-medium"
            >
              Sign up free
            </Link>
          </p>
        </motion.div>
      </div>
    </main>
  );
}

export default function LoginPage() {
  return (
    <Suspense>
      <LoginPageInner />
    </Suspense>
  );
}
