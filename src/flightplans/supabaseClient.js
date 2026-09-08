const { createClient } = require('@supabase/supabase-js');

let client = null;
let initialized = false;

/**
 * Returns a shared Supabase client, or null if flight plan lookup isn't
 * configured (SUPABASE_URL / SUPABASE_KEY unset). Flight plan awareness
 * is an optional feature - the bot works fine without it.
 */
function getSupabaseClient() {
  if (!initialized) {
    initialized = true;
    const url = process.env.SUPABASE_URL;
    const key = process.env.SUPABASE_KEY;
    if (url && key) {
      client = createClient(url, key);
    }
  }
  return client;
}

module.exports = { getSupabaseClient };
