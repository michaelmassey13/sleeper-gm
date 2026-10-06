// League context plus the lineup, waiver, trade and team-needs analyses.
window.GM = window.GM || {};

GM.engine = (() => {
  const M = GM.model;
  const LAST_REG_WEEK = 18;
  const HORIZON = 4;

  /** Load everything for one league and target week, and build the shared context. */
  async function loadLeague(leagueId, targetWeek, nflState) {
    const api = GM.api;
    const [league, users, rosters] = await Promise.all([api.league(leagueId), api.users(leagueId), api.rosters(leagueId)]);
    const season = league.season;
    // Load every remaining regular-season week: the first HORIZON drive lineups and waivers,
    // the full run drives trade values.
    const rosWeeks = [];
    for (let w = targetWeek; w <= LAST_REG_WEEK; w++) rosWeeks.push(w);
    const weeks = rosWeeks.slice(0, HORIZON);

    const [projRows, matchups, trendAdd, trendDrop] = await Promise.all([
      Promise.all(rosWeeks.map((w) => api.projections(season, w).then((rows) => ({ week: w, rows })))),
      api.matchups(leagueId, targetWeek).catch(() => []),
      api.trending('add').catch(() => []),
      api.trending('drop').catch(() => []),
    ]);

    const scoring = league.scoring_settings;
    const slots = M.starterSlots(league.roster_positions);
    const players = M.buildPlayers(projRows, scoring, targetWeek, HORIZON);
    const userById = new Map(users.map((u) => [u.user_id, u]));
    const matchupByRoster = new Map(matchups.map((m) => [m.roster_id, m]));

    const rosteredBy = new Map();
    const teams = rosters.map((r) => {
      const u = userById.get(r.owner_id) || {};
      const ids = (r.players || []).filter(Boolean);
      for (const id of ids) {
        rosteredBy.set(id, r.roster_id);
        if (!players.has(id)) players.set(id, M.unknownPlayer(id));
      }
      const m = matchupByRoster.get(r.roster_id);
      const s = r.settings || {};
      return {
        rosterId: r.roster_id,
        ownerId: r.owner_id,
        owner: u.display_name || 'Open team',
        name: (u.metadata && u.metadata.team_name) || u.display_name || `Team ${r.roster_id}`,
        avatar: u.avatar || null,
        ids,
        reserve: new Set(r.reserve || []),
        starters: ((m && m.starters) || r.starters || []).map((x) => (x === '0' ? null : x)),
        matchupId: m ? m.matchup_id : null,
        livePoints: m ? m.points || 0 : 0,
        wins: s.wins || 0, losses: s.losses || 0, ties: s.ties || 0,
        pf: (s.fpts || 0) + (s.fpts_decimal || 0) / 100,
        pa: (s.fpts_against || 0) + (s.fpts_against_decimal || 0) / 100,
      };
    });

    const repl = M.replacementLevels(players, slots, teams.length);
    const replRos = M.replacementLevels(players, slots, teams.length, 'rosRaw');
    M.setRestOfSeason(players, replRos);
    const rosterSize = league.roster_positions.filter((s) => s !== 'IR' && s !== 'TAXI').length;

    return {
      league, season, targetWeek, weeks, rosWeeks, scoring, slots, players, teams, rosteredBy, repl, replRos, rosterSize,
      nflWeek: nflState.week,
      trendAdd: new Map(trendAdd.map((t) => [t.player_id, t.count])),
      trendDrop: new Map(trendDrop.map((t) => [t.player_id, t.count])),
      byRoster: new Map(teams.map((t) => [t.rosterId, t])),
    };
  }

  const P = (ctx, id) => ctx.players.get(id) || M.unknownPlayer(id);
  // Players who can actually be started (IR slot players are excluded).
  const activeIds = (team) => team.ids.filter((id) => !team.reserve.has(id));

  /** Points above replacement per week, over the horizon. */
  const vor = (ctx, p) => (p.unknown ? 0 : p.avg - (ctx.repl[p.pos] || 0));
  /**
   * Trade value: rest-of-season points per week above replacement, plus a little credit
   * for raw volume so depth isn't worth zero. Missed weeks are already filled at replacement level in p.ros.
   */
  const tradeValue = (ctx, p) => (p.unknown ? 0 : Math.max(0, p.ros - (ctx.replRos[p.pos] || 0)) + 0.1 * p.rosRaw);

  /* ---------------- Lineup ---------------- */

  function lineup(ctx, team) {
    const ids = activeIds(team);
    const best = M.optimize(ids, ctx.slots, ctx.players, 'now');
    const current = ctx.slots.map((slot, i) => {
      const id = team.starters[i] || null;
      return { slot, id, v: id ? P(ctx, id).now : 0 };
    });
    const currentTotal = current.reduce((a, s) => a + s.v, 0);
    const currentSet = new Set(current.map((s) => s.id).filter(Boolean));

    // Pair players to start with players to sit, biggest upgrade first.
    const ins = best.slots.filter((s) => s.id && !currentSet.has(s.id)).map((s) => P(ctx, s.id)).sort((a, b) => b.now - a.now);
    const outs = current.filter((s) => !s.id || !best.used.has(s.id)).map((s) => (s.id ? P(ctx, s.id) : null))
      .sort((a, b) => (a ? a.now : -1) - (b ? b.now : -1));
    const swaps = ins.map((pIn, i) => ({ in: pIn, out: outs[i] || null, gain: pIn.now - (outs[i] ? outs[i].now : 0) }));

    const flags = current
      .filter((s) => s.id)
      .map((s) => P(ctx, s.id))
      .filter((p) => p.bye || M.SIDELINED.has(p.inj) || p.inj === 'Doubtful' || p.inj === 'Questionable');

    best.slots = keepSlots(ctx, best, current);
    const bench = ids.filter((id) => !best.used.has(id)).map((id) => P(ctx, id)).sort((a, b) => b.now - a.now);
    const reserve = [...team.reserve].map((id) => P(ctx, id));
    return { best, current, currentTotal, optimalTotal: best.total, swaps, flags, bench, reserve };
  }

  // Rearrange the best lineup so players already starting keep their current slot;
  // only real swaps then show up as changes. Falls back to the optimizer's layout if it can't fit.
  function keepSlots(ctx, best, current) {
    const fits = (id, slot) => P(ctx, id).elig.some((e) => M.ELIG[slot].includes(e));
    const out = current.map((c) => (c.id && best.used.has(c.id) && fits(c.id, c.slot) ? { slot: c.slot, id: c.id, v: P(ctx, c.id).now } : null));
    const placed = new Set(out.filter(Boolean).map((s) => s.id));
    const rest = best.slots.filter((s) => s.id && !placed.has(s.id)).map((s) => s.id);
    const open = out.map((s, i) => (s ? null : i)).filter((i) => i != null)
      .sort((a, b) => M.ELIG[ctx.slots[a]].length - M.ELIG[ctx.slots[b]].length);
    for (const i of open) {
      const k = rest.findIndex((id) => fits(id, ctx.slots[i]));
      if (k === -1) {
        if (rest.length) return best.slots;
        out[i] = { slot: ctx.slots[i], id: null, v: 0 };
        continue;
      }
      const id = rest.splice(k, 1)[0];
      out[i] = { slot: ctx.slots[i], id, v: P(ctx, id).now };
    }
    return rest.length ? best.slots : out;
  }

  /* ---------------- Matchup ---------------- */

  const normCdf = (z) => 1 / (1 + Math.exp(-1.702 * z));

  function matchup(ctx, team) {
    if (team.matchupId == null) return null;
    const opp = ctx.teams.find((t) => t.matchupId === team.matchupId && t.rosterId !== team.rosterId);
    if (!opp) return null;
    const mine = lineup(ctx, team).optimalTotal;
    const theirs = M.lineupTotal(activeIds(opp), ctx.slots, ctx.players, 'now');
    const sd = Math.sqrt((0.24 * mine) ** 2 + (0.24 * theirs) ** 2) || 1;
    return { opp, mine, theirs, winProb: normCdf((mine - theirs) / sd), liveMine: team.livePoints, liveTheirs: opp.livePoints };
  }

  /* ---------------- Waivers ---------------- */

  function waivers(ctx, team) {
    const ids = activeIds(team);
    const baseNow = M.lineupTotal(ids, ctx.slots, ctx.players, 'now');
    const baseAvg = M.lineupTotal(ids, ctx.slots, ctx.players, 'avg');
    const openSpots = Math.max(0, ctx.rosterSize - ids.length);

    // Cheapest player to cut: the one whose loss hurts the lineup least, now and over the horizon.
    // Healthy weekly output is weighted in so a star who is out this week is never the cut.
    const cutCost = ids.map((id) => {
      const rest = ids.filter((x) => x !== id);
      const p = P(ctx, id);
      const lossAvg = baseAvg - M.lineupTotal(rest, ctx.slots, ctx.players, 'avg');
      const lossNow = baseNow - M.lineupTotal(rest, ctx.slots, ctx.players, 'now');
      return { p, lossAvg, lossNow, cost: lossAvg + 0.5 * lossNow + 0.25 * p.talent };
    }).sort((a, b) => a.cost - b.cost);
    const drop = openSpots > 0 ? null : (cutCost[0] ? cutCost[0].p : null);

    const neededPos = new Set(ctx.slots.flatMap((s) => M.ELIG[s]));
    const pool = [...ctx.players.values()].filter((p) =>
      !p.unknown && !ctx.rosteredBy.has(p.id) && p.team && neededPos.has(p.pos) && !M.SIDELINED.has(p.inj));
    pool.sort((a, b) => b.avg - a.avg);
    const trendingIds = new Set([...ctx.trendAdd.keys()]);
    const candidates = pool.filter((p, i) => i < 220 || trendingIds.has(p.id));

    const after = drop ? ids.filter((x) => x !== drop.id) : ids;
    const rows = candidates.map((p) => {
      const withP = [...after, p.id];
      const gainNow = M.lineupTotal(withP, ctx.slots, ctx.players, 'now') - baseNow;
      const gainAvg = M.lineupTotal(withP, ctx.slots, ctx.players, 'avg') - baseAvg;
      const adds = ctx.trendAdd.get(p.id) || 0;
      const score = gainAvg + 0.5 * gainNow + Math.min(1, adds / 40000) * 0.6;
      return { p, gainNow, gainAvg, adds, score, vor: vor(ctx, p) };
    });
    rows.sort((a, b) => b.score - a.score || b.p.avg - a.p.avg);
    return { rows, drop, cutCost, openSpots };
  }

  /* ---------------- Trades ---------------- */

  function evaluateTrade(ctx, me, other, give, get) {
    const giveSet = new Set(give), getSet = new Set(get);
    const meIds = activeIds(me), otherIds = activeIds(other);
    const meAfter = meIds.filter((id) => !giveSet.has(id)).concat(get);
    const otherAfter = otherIds.filter((id) => !getSet.has(id)).concat(give);
    const S = ctx.slots, PL = ctx.players;
    const gMe = M.lineupTotal(meAfter, S, PL, 'ros') - M.lineupTotal(meIds, S, PL, 'ros');
    const gThem = M.lineupTotal(otherAfter, S, PL, 'ros') - M.lineupTotal(otherIds, S, PL, 'ros');
    const gMeNow = M.lineupTotal(meAfter, S, PL, 'now') - M.lineupTotal(meIds, S, PL, 'now');
    const gThemNow = M.lineupTotal(otherAfter, S, PL, 'now') - M.lineupTotal(otherIds, S, PL, 'now');
    const tvGive = give.reduce((a, id) => a + tradeValue(ctx, P(ctx, id)), 0);
    const tvGet = get.reduce((a, id) => a + tradeValue(ctx, P(ctx, id)), 0);
    let verdict;
    if (gMe > 0.25 && gThem > 0.25) verdict = 'Win-win';
    else if (gMe > 0.25 && tvGet <= tvGive * 1.12 + 0.5) verdict = 'Fair value';
    else if (gMe > 0.25) verdict = 'Tough sell';
    else if (gMe < -0.25) verdict = 'Hurts you';
    else verdict = 'Neutral';
    return { give, get, gMe, gThem, gMeNow, gThemNow, tvGive, tvGet, verdict, otherId: other.rosterId };
  }

  function combos(list, k) {
    if (k === 1) return list.map((x) => [x]);
    const out = [];
    for (let i = 0; i < list.length; i++) for (let j = i + 1; j < list.length; j++) out.push([list[i], list[j]]);
    return out;
  }

  function tradeIdeas(ctx, me) {
    const tradeable = (team) => activeIds(team)
      .map((id) => P(ctx, id))
      .filter((p) => !p.unknown && p.pos !== 'K' && p.pos !== 'DEF')
      .sort((a, b) => b.ros - a.ros)
      .slice(0, 13)
      .map((p) => p.id);

    const S = ctx.slots, PL = ctx.players;
    const meIds = activeIds(me);
    const baseMe = M.lineupTotal(meIds, S, PL, 'ros');
    const mine = tradeable(me);
    const myGives = [...combos(mine, 1), ...combos(mine, 2)];
    const ideas = [];

    for (const other of ctx.teams) {
      if (other.rosterId === me.rosterId) continue;
      const otherIds = activeIds(other);
      const baseThem = M.lineupTotal(otherIds, S, PL, 'ros');
      const theirs = tradeable(other);
      const theirGets = [...combos(theirs, 1), ...combos(theirs, 2)];
      const best = new Map();

      for (const give of myGives) {
        const tvGive = give.reduce((a, id) => a + tradeValue(ctx, P(ctx, id)), 0);
        const giveSet = new Set(give);
        const meLess = meIds.filter((id) => !giveSet.has(id));
        for (const get of theirGets) {
          if (give.length === 2 && get.length === 2) continue;
          const tvGet = get.reduce((a, id) => a + tradeValue(ctx, P(ctx, id)), 0);
          if (tvGet > tvGive * 1.12 + 0.5) continue; // they'd say no
          const gMe = M.lineupTotal(meLess.concat(get), S, PL, 'ros') - baseMe;
          if (gMe < 0.4) continue;
          const getSet = new Set(get);
          const gThem = M.lineupTotal(otherIds.filter((id) => !getSet.has(id)).concat(give), S, PL, 'ros') - baseThem;
          if (gThem < -0.25) continue;
          const score = gMe + 0.5 * Math.min(gThem, 3) - 0.15 * Math.max(0, tvGive - tvGet) - 0.2 * (give.length + get.length - 2);
          const key = get.slice().sort().join('+');
          const prev = best.get(key);
          if (!prev || score > prev.score) best.set(key, { give, get, score });
        }
      }
      const top = [...best.values()].sort((a, b) => b.score - a.score).slice(0, 4);
      for (const t of top) ideas.push({ ...evaluateTrade(ctx, me, other, t.give, t.get), score: t.score });
    }
    ideas.sort((a, b) => b.score - a.score);
    return ideas;
  }

  /* ---------------- Team needs ---------------- */

  function profiles(ctx) {
    const posList = M.POSITIONS.filter((pos) => ctx.slots.some((s) => M.ELIG[s].includes(pos)));
    const rows = ctx.teams.map((t) => {
      const ids = activeIds(t);
      const best = M.optimize(ids, ctx.slots, ctx.players, 'avg');
      const starters = {}, depth = {};
      for (const pos of posList) { starters[pos] = 0; depth[pos] = 0; }
      for (const s of best.slots) if (s.id) {
        const p = P(ctx, s.id);
        if (starters[p.pos] != null) starters[p.pos] += s.v;
      }
      for (const id of ids) if (!best.used.has(id)) {
        const p = P(ctx, id);
        if (depth[p.pos] != null) depth[p.pos] = Math.max(depth[p.pos], p.avg);
      }
      return { team: t, total: best.total, starters, depth };
    });
    // Rank each position across the league (1 = strongest).
    const ranks = new Map(rows.map((r) => [r.team.rosterId, {}]));
    for (const pos of posList) {
      const sorted = rows.slice().sort((a, b) => b.starters[pos] - a.starters[pos]);
      sorted.forEach((r, i) => { ranks.get(r.team.rosterId)[pos] = i + 1; });
    }
    const totalRank = rows.slice().sort((a, b) => b.total - a.total).map((r) => r.team.rosterId);
    return { posList, rows, ranks, totalRank };
  }

  function standings(ctx) {
    return ctx.teams.slice().sort((a, b) => (b.wins + b.ties / 2) - (a.wins + a.ties / 2) || b.pf - a.pf);
  }

  return { HORIZON, loadLeague, lineup, matchup, waivers, tradeIdeas, evaluateTrade, profiles, standings, vor, tradeValue, activeIds, P };
})();
