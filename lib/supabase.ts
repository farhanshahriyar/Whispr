/**
 * WHISPR — Supabase Client
 *
 * Initializes the Supabase client with environment variables.
 * NEVER hardcode keys here — always use .env (SECURITY.md rule #4).
 */

import 'react-native-url-polyfill/auto';
import { createClient } from '@supabase/supabase-js';

const supabaseUrl = process.env.EXPO_PUBLIC_SUPABASE_URL;
const supabaseAnonKey = process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY;

if (!supabaseUrl || !supabaseAnonKey) {
  throw new Error(
    'Missing Supabase environment variables. ' +
    'Copy .env.example to .env and fill in your Supabase project URL and anon key. ' +
    'See SECURITY.md for details.'
  );
}

export const supabase = createClient(supabaseUrl, supabaseAnonKey, {
  auth: {
    // Persist auth sessions across app restarts
    persistSession: true,
    // Auto-refresh tokens before they expire
    autoRefreshToken: true,
    // Detect session from URL (needed for OAuth, but we use email/password)
    detectSessionInUrl: false,
  },
});
