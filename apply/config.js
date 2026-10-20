// Controller applications for the Halloween event (apply/): who can apply, which Discord servers we read
// roles and join dates from, and the interview questions. Secrets come from the environment (see README).

/** The event's human-controlled positions (Server 1). Rockford Approach is only staffed with a 10th controller. */
const POSITIONS = [
  { id: 'irfd', label: 'Greater Rockford (IRFD)' },
  { id: 'imlr', label: 'Mellor (IMLR)' },
  { id: 'ikfl', label: 'Keflavik (IKFL)' },
  { id: 'itko', label: 'Tokyo (ITKO)' },
  { id: 'ilar', label: 'Larnaca (ILAR)' },
  { id: 'ipap', label: 'Paphos (IPAP)' },
  { id: 'isau', label: 'Sauthemptona (ISAU)' },
  { id: 'ibth', label: 'Saint Barthélemy (IBTH)' },
  { id: 'ipph', label: 'Perth (IPPH)' },
  { id: 'rfdapp', label: 'Rockford Approach + Departure (IRFD APP/DEP)' },
];

/**
 * Question types: text (one line), textarea, select (options), rank (pick `picks` options in order).
 * `id`s are stored with each application, so don't rename one once applications are coming in.
 */
const QUESTIONS = [
  { id: 'roblox', type: 'text', label: 'Roblox username', required: true, max: 40 },
  { id: 'timezone', type: 'text', label: 'Your time zone', hint: 'e.g. EST, GMT+1', required: true, max: 40 },
  { id: 'availability', type: 'select', label: 'Can you control for the whole event on 31 October?', required: true,
    options: ['Yes, the whole event', 'Most of it', 'Only part of it'] },
  { id: 'positions', type: 'rank', label: 'Which positions do you want?', hint: 'Pick three, most wanted first.', required: true,
    picks: 3, options: POSITIONS.map((p) => p.label) },
  { id: 'experience', type: 'textarea', label: 'Your ATC experience', hint: 'Where you have controlled (PTFS servers, other communities), which positions, and for how long.', required: true, max: 1500 },
  { id: 'mic', type: 'select', label: 'Do you have a working microphone and can you speak clearly on Discord?', required: true,
    options: ['Yes', 'No'] },
  { id: 'clearance', type: 'textarea', label: 'Write the IFR clearance you would give', hint: 'DAL123, at Greater Rockford, filed to Tokyo, cruising FL350, departing runway 25L.', required: true, max: 800 },
  { id: 'goaround', type: 'textarea', label: 'Scenario: an aircraft on short final goes around while another is lined up and waiting on the same runway. What do you say to each, in order?', required: true, max: 1000 },
  { id: 'busy', type: 'textarea', label: 'Scenario: your frequency is packed, two pilots keep talking over each other and one ignores your instructions. How do you handle it?', required: true, max: 1000 },
  { id: 'merge', type: 'select', label: 'If the AI controllers on Server 2 fail, everyone moves to your server. Are you comfortable with double the traffic?', required: true,
    options: ['Yes', 'Probably', 'No'] },
  { id: 'other', type: 'textarea', label: 'Anything else we should know?', required: false, max: 800 },
];

/**
 * Discord servers whose roles and join date are read at sign-in. APPLY_GUILDS is a comma-separated list of
 * `id:Name` or `id:Name:required` (required = you must be a member to apply), e.g.
 *   APPLY_GUILDS=1234567890123456789:AutoATC:required,9876543210987654321:PTFS
 */
function parseGuilds(raw) {
  return String(raw || '').split(',').map((s) => s.trim()).filter(Boolean).map((entry) => {
    const [id, name, flag] = entry.split(':').map((x) => (x || '').trim());
    if (!/^\d{15,22}$/.test(id)) return null;
    return { id, name: name || `Server ${id}`, required: flag === 'required' };
  }).filter(Boolean);
}

function loadConfig(env = process.env) {
  return {
    clientId: env.DISCORD_CLIENT_ID || '',
    clientSecret: env.DISCORD_CLIENT_SECRET || '',
    botToken: env.APPLY_BOT_TOKEN || '', // optional: turns role ids into role names (the bot must be in the server)
    // where this app is reachable; Discord redirects back to <publicUrl>/apply/callback
    publicUrl: (env.APPLY_PUBLIC_URL
      || (env.RAILWAY_PUBLIC_DOMAIN ? `https://${env.RAILWAY_PUBLIC_DOMAIN}` : `http://localhost:${env.PORT || 3000}`)).replace(/\/+$/, ''),
    sessionSecret: env.APPLY_SESSION_SECRET || '',
    admins: String(env.APPLY_ADMIN_IDS || '').split(',').map((s) => s.trim()).filter((s) => /^\d{15,22}$/.test(s)),
    guilds: parseGuilds(env.APPLY_GUILDS),
    open: env.APPLY_OPEN !== 'false',
    dataDir: env.APPLY_DATA_DIR || env.RAILWAY_VOLUME_MOUNT_PATH || '',
  };
}

module.exports = { POSITIONS, QUESTIONS, parseGuilds, loadConfig };
