'use client';

import { useState, Suspense } from 'react';
import { useSearchParams } from 'next/navigation';
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
  AlertCircle,
  BrainCircuit,
  Rocket,
  Users,
} from 'lucide-react';

const steps = [
  {
    icon: BrainCircuit,
    title: 'Set up your workspace',
    body: 'Name it, upload a KB doc, and invite your team — the onboarding wizard walks you through everything.',
    color: 'text-indigo-400',
    bg: 'bg-indigo-500/10 border-indigo-500/20',
  },
  {
    icon: Users,
    title: 'Invite reps & admins',
    body: 'Everyone gets an email invite. Role-based access keeps customers, reps, and admins in their lanes.',
    color: 'text-violet-400',
    bg: 'bg-violet-500/10 border-violet-500/20',
  },
  {
    icon: Rocket,
    title: 'Go live in minutes',
    body: 'CASPER starts routing tickets the moment your first KB doc is indexed. No configuration required.',
    color: 'text-emerald-400',
    bg: 'bg-emerald-500/10 border-emerald-500/20',
  },
];

function getStrength(pw: string): number {
  let s = 0;
  if (pw.length >= 8) s++;
  if (/[a-z]/.test(pw)) s++;
  if (/[A-Z]/.test(pw)) s++;
  if (/[0-9]/.test(pw)) s++;
  if (/[^A-Za-z0-9]/.test(pw)) s++;
  return s;
}

function StrengthBar({ strength }: { strength: number }) {
  const color =
    strength >= 4
      ? 'bg-emerald-500'
      : strength >= 2
        ? 'bg-amber-500'
        : 'bg-red-500';
  const label = strength >= 4 ? 'Strong' : strength >= 2 ? 'Medium' : 'Weak';
  const labelColor =
    strength >= 4
      ? 'text-emerald-400'
      : strength >= 2
        ? 'text-amber-400'
        : 'text-red-400';
  return (
    <div className="space-y-1.5">
      <div className="flex gap-1">
        {[1, 2, 3, 4, 5].map(l => (
          <div
            key={l}
            className={`h-1 flex-1 rounded-full transition-all duration-200 ${strength >= l ? color : 'bg-zinc-700'}`}
          />
        ))}
      </div>
      <p className={`text-xs ${labelColor}`}>Strength: {label}</p>
    </div>
  );
}

function SignupPageInner() {
  const searchParams = useSearchParams();
  const redirectTo = searchParams.get('redirect') || '/dashboard';

  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [showPw, setShowPw] = useState(false);
  const [showCf, setShowCf] = useState(false);
  const [loading, setLoading] = useState(false);
  const [magicLoading, setMagicLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  const [doneMessage, setDoneMessage] = useState('');

  const strength = getStrength(password);

  const signUp = async () => {
    if (password !== confirm) {
      setError("Passwords don't match");
      return;
    }
    if (password.length < 6) {
      setError('Password must be at least 6 characters');
      return;
    }
    setLoading(true);
    setError(null);
    const next =
      redirectTo !== '/dashboard'
        ? `?next=${encodeURIComponent(redirectTo)}`
        : '';
    const { error } = await supabase.auth.signUp({
      email,
      password,
      options: {
        emailRedirectTo: `${window.location.origin}/auth/confirm${next}`,
      },
    });
    setLoading(false);
    if (error) {
      setError(error.message);
      return;
    }
    setDoneMessage(
      'Check your email for a confirmation link to activate your account.'
    );
    setDone(true);
  };

  const signUpMagic = async () => {
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
    setDoneMessage('Magic link sent — check your inbox to finish signing up.');
    setDone(true);
  };

  if (done) {
    return (
      <main className="min-h-screen bg-zinc-950 flex items-center justify-center px-6">
        <motion.div
          initial={{ scale: 0.9, opacity: 0 }}
          animate={{ scale: 1, opacity: 1 }}
          className="text-center space-y-4 max-w-sm"
        >
          <div className="w-16 h-16 rounded-full bg-indigo-500/15 border border-indigo-500/25 flex items-center justify-center mx-auto">
            <CheckCircle2 className="w-8 h-8 text-indigo-400" />
          </div>
          <h1 className="text-xl font-bold text-white font-geist">
            Almost there!
          </h1>
          <p className="text-sm text-zinc-400 leading-relaxed">{doneMessage}</p>
          <Link
            href={
              redirectTo !== '/dashboard'
                ? `/login?redirect=${encodeURIComponent(redirectTo)}`
                : '/login'
            }
            className="inline-flex items-center gap-1.5 text-sm text-indigo-400 hover:text-indigo-300 transition-colors mt-2"
          >
            Back to sign in
          </Link>
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
              From sign-up to
              <br />
              live in minutes.
            </h2>
            <p className="text-zinc-400 text-sm leading-relaxed">
              Create your account, upload a doc, invite your team — CASPER
              handles everything else automatically from day one.
            </p>
          </div>

          <div className="space-y-3">
            {steps.map(s => {
              const Icon = s.icon;
              return (
                <div
                  key={s.title}
                  className={`flex items-start gap-3 rounded-xl border p-3.5 ${s.bg}`}
                >
                  <Icon className={`w-4 h-4 mt-0.5 shrink-0 ${s.color}`} />
                  <div>
                    <p className="text-sm font-semibold text-white">
                      {s.title}
                    </p>
                    <p className="text-xs text-zinc-400 mt-0.5 leading-relaxed">
                      {s.body}
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
              Create your account
            </h1>
            <p className="text-sm text-zinc-400">
              Free to start. No credit card required.
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
                  disabled={loading}
                  className="w-full bg-zinc-800 border border-zinc-700 rounded-lg pl-9 pr-4 py-2.5 text-sm text-white placeholder-zinc-500 focus:outline-none focus:ring-1 focus:ring-indigo-500 focus:border-indigo-500 transition-colors disabled:opacity-50"
                />
              </div>
            </div>

            {/* Password */}
            <div>
              <label className="block text-sm font-medium text-zinc-300 mb-1.5">
                Password
              </label>
              <div className="relative">
                <Lock className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-zinc-500 pointer-events-none" />
                <input
                  type={showPw ? 'text' : 'password'}
                  autoComplete="new-password"
                  placeholder="At least 6 characters"
                  value={password}
                  onChange={e => {
                    setPassword(e.target.value);
                    setError(null);
                  }}
                  disabled={loading}
                  className="w-full bg-zinc-800 border border-zinc-700 rounded-lg pl-9 pr-10 py-2.5 text-sm text-white placeholder-zinc-500 focus:outline-none focus:ring-1 focus:ring-indigo-500 focus:border-indigo-500 transition-colors disabled:opacity-50"
                />
                <button
                  type="button"
                  onClick={() => setShowPw(v => !v)}
                  className="absolute right-3 top-1/2 -translate-y-1/2 text-zinc-500 hover:text-zinc-300 transition-colors"
                  tabIndex={-1}
                >
                  {showPw ? (
                    <EyeOff className="w-4 h-4" />
                  ) : (
                    <Eye className="w-4 h-4" />
                  )}
                </button>
              </div>
              {password && (
                <div className="mt-2">
                  <StrengthBar strength={strength} />
                </div>
              )}
            </div>

            {/* Confirm password */}
            <div>
              <label className="block text-sm font-medium text-zinc-300 mb-1.5">
                Confirm password
              </label>
              <div className="relative">
                <Lock className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-zinc-500 pointer-events-none" />
                <input
                  type={showCf ? 'text' : 'password'}
                  autoComplete="new-password"
                  placeholder="Repeat your password"
                  value={confirm}
                  onChange={e => {
                    setConfirm(e.target.value);
                    setError(null);
                  }}
                  onKeyDown={e => e.key === 'Enter' && !loading && signUp()}
                  disabled={loading}
                  className="w-full bg-zinc-800 border border-zinc-700 rounded-lg pl-9 pr-10 py-2.5 text-sm text-white placeholder-zinc-500 focus:outline-none focus:ring-1 focus:ring-indigo-500 focus:border-indigo-500 transition-colors disabled:opacity-50"
                />
                <button
                  type="button"
                  onClick={() => setShowCf(v => !v)}
                  className="absolute right-3 top-1/2 -translate-y-1/2 text-zinc-500 hover:text-zinc-300 transition-colors"
                  tabIndex={-1}
                >
                  {showCf ? (
                    <EyeOff className="w-4 h-4" />
                  ) : (
                    <Eye className="w-4 h-4" />
                  )}
                </button>
              </div>
              {confirm && (
                <div className="flex items-center gap-1.5 mt-1.5">
                  {password === confirm ? (
                    <>
                      <CheckCircle2 className="w-3.5 h-3.5 text-emerald-400" />
                      <span className="text-xs text-emerald-400">
                        Passwords match
                      </span>
                    </>
                  ) : (
                    <>
                      <AlertCircle className="w-3.5 h-3.5 text-red-400" />
                      <span className="text-xs text-red-400">
                        Passwords don&apos;t match
                      </span>
                    </>
                  )}
                </div>
              )}
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

            {/* Create account */}
            <button
              type="button"
              onClick={signUp}
              disabled={
                loading ||
                !email ||
                !password ||
                !confirm ||
                password !== confirm
              }
              className="w-full flex items-center justify-center gap-2 bg-indigo-600 hover:bg-indigo-500 disabled:opacity-50 disabled:cursor-not-allowed text-white text-sm font-medium rounded-lg px-4 py-2.5 transition-colors"
            >
              {loading ? (
                <>
                  <Loader2 className="w-4 h-4 animate-spin" /> Creating account…
                </>
              ) : (
                <>
                  Create account <ArrowRight className="w-4 h-4" />
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
            <button
              type="button"
              onClick={signUpMagic}
              disabled={magicLoading || !email}
              className="w-full flex items-center justify-center gap-2 bg-zinc-800 hover:bg-zinc-700 disabled:opacity-50 disabled:cursor-not-allowed text-zinc-300 text-sm font-medium rounded-lg px-4 py-2.5 transition-colors border border-zinc-700"
            >
              {magicLoading ? (
                <>
                  <Loader2 className="w-4 h-4 animate-spin" /> Sending…
                </>
              ) : (
                <>
                  <Mail className="w-4 h-4" /> Sign up with magic link
                </>
              )}
            </button>
          </div>

          <p className="mt-8 text-center text-sm text-zinc-500">
            Already have an account?{' '}
            <Link
              href={
                redirectTo !== '/dashboard'
                  ? `/login?redirect=${encodeURIComponent(redirectTo)}`
                  : '/login'
              }
              className="text-indigo-400 hover:text-indigo-300 transition-colors font-medium"
            >
              Sign in
            </Link>
          </p>

          <p className="mt-4 text-center text-xs text-zinc-600">
            By signing up you agree to our{' '}
            <Link
              href="/terms"
              className="text-zinc-500 hover:text-zinc-400 transition-colors"
            >
              Terms
            </Link>{' '}
            and{' '}
            <Link
              href="/privacy"
              className="text-zinc-500 hover:text-zinc-400 transition-colors"
            >
              Privacy Policy
            </Link>
            .
          </p>
        </motion.div>
      </div>
    </main>
  );
}

export default function SignupPage() {
  return (
    <Suspense>
      <SignupPageInner />
    </Suspense>
  );
}
