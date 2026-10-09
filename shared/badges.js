// Badges and trophies, shared by the server (which awards them) and the profile page (which shows them).
// `stats` is a player's lifetime record; `m` is the match that just ended (absent when only showing progress).

export const BADGES = [
  { id: 'first_ko', icon: '🗡️', name: 'First Blood', desc: 'Knock out your first brawler.', goal: 1, value: (s) => s.kills },
  { id: 'first_win', icon: '🏆', name: 'Winner!', desc: 'Win your first match.', goal: 1, value: (s) => s.wins },
  { id: 'survivor', icon: '☠️', name: 'Last One Standing', desc: 'Win a Showdown.', goal: 1, value: (s) => s.byMode.showdown.wins },
  { id: 'gem_champ', icon: '💎', name: 'Gem Champion', desc: 'Win a Gem Grab match.', goal: 1, value: (s) => s.byMode.gemgrab.wins },
  { id: 'bounty_hunter', icon: '⭐', name: 'Bounty Hunter', desc: 'Win a Bounty match.', goal: 1, value: (s) => s.byMode.bounty.wins },
  { id: 'hat_trick', icon: '🎩', name: 'Hat Trick', desc: '3 knockouts in one match.', test: (s, m) => m && m.kills >= 3 },
  { id: 'rampage', icon: '🔥', name: 'Rampage', desc: '5 knockouts in one match.', test: (s, m) => m && m.kills >= 5 },
  { id: 'gem_hoarder', icon: '💰', name: 'Gem Hoarder', desc: 'Carry 10 gems at once.', test: (s, m) => m && m.maxGemsHeld >= 10 },
  { id: 'big_score', icon: '🌟', name: 'Big Score', desc: 'Steal a bounty worth 5 or more stars.', test: (s, m) => m && m.bestSteal >= 5 },
  { id: 'spooky', icon: '👻', name: 'Spooky', desc: 'Knock someone out with a ghost haunt.', goal: 1, value: (s) => s.hauntKOs },
  { id: 'smasher', icon: '📦', name: 'Crate Smasher', desc: 'Break 25 power cube crates.', goal: 25, value: (s) => s.crates },
  { id: 'super_user', icon: '⚡', name: 'Super User', desc: 'Use your Super 25 times.', goal: 25, value: (s) => s.supers },
  { id: 'on_fire', icon: '🌶️', name: 'On Fire', desc: 'Win 3 matches in a row.', goal: 3, value: (s) => s.bestStreak },
  { id: 'veteran', icon: '🎖️', name: 'Veteran', desc: 'Play 25 matches.', goal: 25, value: (s) => s.matches },
  { id: 'brick_master', icon: '🧱', name: 'Brick Master', desc: 'Win 5 matches as Brick.', goal: 5, value: (s) => s.byBrawler.brick.wins },
  { id: 'vex_master', icon: '🎯', name: 'Vex Master', desc: 'Win 5 matches as Vex.', goal: 5, value: (s) => s.byBrawler.vex.wins },
  { id: 'boom_master', icon: '💣', name: 'Boom Master', desc: 'Win 5 matches as Boom.', goal: 5, value: (s) => s.byBrawler.boom.wins },
  { id: 'party', icon: '🎉', name: 'Party Time', desc: 'Play a match with 3 or more friends.', test: (s, m) => m && m.humans >= 4 },
  { id: 'rising_star', icon: '🏅', name: 'Rising Star', desc: 'Reach 100 trophies.', goal: 100, value: (s, t) => t },
  { id: 'legend', icon: '👑', name: 'Legend', desc: 'Reach 500 trophies.', goal: 500, value: (s, t) => t },
];

export function emptyStats() {
  const mode = () => ({ played: 0, wins: 0 });
  const brawler = () => ({ played: 0, wins: 0, kills: 0 });
  return {
    matches: 0, wins: 0, losses: 0, kills: 0, deaths: 0, supers: 0, crates: 0, gems: 0, stars: 0, hauntKOs: 0,
    streak: 0, bestStreak: 0,
    byMode: { showdown: mode(), gemgrab: mode(), bounty: mode() },
    byBrawler: { brick: brawler(), vex: brawler(), boom: brawler() },
  };
}

// Brawl Stars-style trophy changes: Showdown pays by placement, other modes by result.
const SHOWDOWN_TROPHIES = [10, 7, 4, 1, -2, -4];
const BOUNTY_TROPHIES = [8, 5, 2, 0, -2, -3];
export function trophyDelta(m) {
  if (m.mode === 'showdown') return SHOWDOWN_TROPHIES[Math.min(m.rank, 6) - 1];
  if (m.mode === 'bounty') return BOUNTY_TROPHIES[Math.min(m.rank, 6) - 1];
  return m.won ? 8 : m.draw ? 0 : -3;
}

export function badgeEarned(b, stats, trophies, m) {
  if (b.test) return Boolean(b.test(stats, m));
  return b.value(stats, trophies) >= b.goal;
}
