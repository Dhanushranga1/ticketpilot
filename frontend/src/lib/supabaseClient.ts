/**
 * Legacy-compatible browser Supabase client.
 * Backed by @supabase/ssr createBrowserClient — cookie-based sessions
 * instead of localStorage. All existing `supabase.auth.*` call sites
 * keep working unchanged.
 */
import { createClient as createBrowserClient } from '@/lib/supabase/client';

export const supabase = createBrowserClient();

export { createBrowserClient as createClient };
