import { type EmailOtpType } from '@supabase/supabase-js';
import { NextResponse, type NextRequest } from 'next/server';
import { createClient } from '@/lib/supabase/server';

/**
 * SSR magic-link / email-OTP confirmation.
 * Supabase redirect URL: {site}/auth/confirm?token_hash=...
 */
export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const token_hash = searchParams.get('token_hash');
  const type = searchParams.get('type') as EmailOtpType | null;
  const next = searchParams.get('next') ?? '/dashboard';

  if (token_hash && type) {
    const supabase = await createClient();
    const { error } = await supabase.auth.verifyOtp({
      type,
      token_hash,
    });
    if (!error) {
      return NextResponse.redirect(
        new URL(next.startsWith('/') ? next : '/dashboard', request.url)
      );
    }
  }

  return NextResponse.redirect(
    new URL('/auth/callback?error=confirm_failed', request.url)
  );
}
