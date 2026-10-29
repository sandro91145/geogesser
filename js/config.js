// Mapillary client token (starts with "MLY|"). It's read-only and meant to be
// used in web pages, so it's fine to commit. Leave empty to use Panoramax only.
// Get one free at https://www.mapillary.com/dashboard/developers
export const MAPILLARY_TOKEN = 'MLY|39631951146453181|266712ed7b2b32fec12a4b823dfb0151';

// Supabase project for the daily leaderboard. The publishable key is meant to be
// public: the database's row-level security rules decide what it may do
// (read scores, add today's score; never edit or delete). Leave empty to hide
// the leaderboard.
export const SUPABASE_URL = 'https://sxsunxmgcyyeacktbisv.supabase.co';
export const SUPABASE_KEY = 'sb_publishable_VW4nAQL3i7_1gYFuXxstJw_rPAaZ1wK';
