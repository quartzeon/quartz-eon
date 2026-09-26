/* Connects the site to Supabase (real accounts and data).
   The URL and key below are safe to be public: the anon/publishable key can only do what the
   database's row-level security rules (see supabase/schema.sql) allow it to do. */
window.QE_SUPABASE = supabase.createClient(
  'https://ubvmbgotksjqmpbpajaw.supabase.co',
  'sb_publishable_0EVcXBw60L1WTww1dP7Tfg__aQobvQ-'
);
