// Sleeper API client. Every call runs in the browser; Sleeper allows any origin.
window.GM = window.GM || {};

GM.api = (() => {
  const V1 = 'https://api.sleeper.app/v1';
  const PROJ = 'https://api.sleeper.com';
  const POSITIONS = ['QB', 'RB', 'WR', 'TE', 'K', 'DEF'];
  const cache = new Map();

  function get(url) {
    if (cache.has(url)) return cache.get(url);
    const req = fetch(url).then((res) => {
      if (!res.ok) throw new Error(`Sleeper answered ${res.status} for ${url.split('?')[0].replace(/^https:\/\/[^/]+/, '')}`);
      return res.json();
    });
    cache.set(url, req);
    req.catch(() => cache.delete(url));
    return req;
  }

  const posQuery = POSITIONS.map((p) => `position[]=${p}`).join('&');

  return {
    clear: () => cache.clear(),
    state: () => get(`${V1}/state/nfl`),
    user: (nameOrId) => get(`${V1}/user/${encodeURIComponent(nameOrId)}`),
    leagues: (userId, season) => get(`${V1}/user/${userId}/leagues/nfl/${season}`),
    league: (id) => get(`${V1}/league/${id}`),
    users: (id) => get(`${V1}/league/${id}/users`),
    rosters: (id) => get(`${V1}/league/${id}/rosters`),
    matchups: (id, week) => get(`${V1}/league/${id}/matchups/${week}`),
    trending: (type) => get(`${V1}/players/nfl/trending/${type}?lookback_hours=48&limit=150`),
    projections: (season, week) => get(`${PROJ}/projections/nfl/${season}/${week}?season_type=regular&${posQuery}`),
  };
})();
