// Scoring, player table and lineup optimizer.
window.GM = window.GM || {};

GM.model = (() => {
  // Which player positions can fill each lineup slot.
  const ELIG = {
    QB: ['QB'], RB: ['RB'], WR: ['WR'], TE: ['TE'], K: ['K'], DEF: ['DEF'],
    FLEX: ['RB', 'WR', 'TE'],
    WRRB_FLEX: ['RB', 'WR'],
    REC_FLEX: ['WR', 'TE'],
    SUPER_FLEX: ['QB', 'RB', 'WR', 'TE'],
  };
  const SLOT_LABEL = { FLEX: 'FLEX', WRRB_FLEX: 'W/R', REC_FLEX: 'W/T', SUPER_FLEX: 'SFLX' };
  const POSITIONS = ['QB', 'RB', 'WR', 'TE', 'K', 'DEF'];
  const SIDELINED = new Set(['Out', 'IR', 'PUP', 'Sus', 'NA', 'DNR']);

  const starterSlots = (rosterPositions) => rosterPositions.filter((s) => ELIG[s]);
  const slotLabel = (s) => SLOT_LABEL[s] || s;

  // Score a projected stat line with the league's own scoring settings.
  function points(stats, sc) {
    if (!stats) return 0;
    let total = 0;
    for (const key in sc) {
      const v = stats[key];
      if (v) total += v * sc[key];
    }
    // Projection feeds bucket long field goals and misses differently than most leagues.
    if (sc.fgm_50_59 != null && sc.fgm_50p == null && stats.fgm_50_59 == null && stats.fgm_50p) {
      total += stats.fgm_50p * sc.fgm_50_59;
    }
    if (sc.fgmiss != null && stats.fgmiss == null) {
      for (const key in stats) if (key.startsWith('fgmiss_')) total += stats[key] * sc.fgmiss;
    }
    return total;
  }

  /**
   * Build the player table from several weeks of projections.
   * Each player gets wk[week] (league points), opp[week], now (target week, injury-adjusted),
   * avg (mean over the first `horizon` weeks, byes count as zero) and rosRaw (same, over every week loaded).
   */
  function buildPlayers(projWeeks, scoring, targetWeek, horizon) {
    const map = new Map();
    for (const { week, rows } of projWeeks) {
      for (const r of rows) {
        const info = r.player;
        if (!info || !POSITIONS.includes(info.position)) continue;
        let p = map.get(r.player_id);
        if (!p) {
          const isDef = info.position === 'DEF';
          p = {
            id: r.player_id,
            name: `${info.first_name} ${info.last_name}`,
            short: isDef ? `${info.last_name} D/ST` : `${(info.first_name || '').charAt(0)}. ${info.last_name}`,
            pos: info.position,
            elig: (info.fantasy_positions || [info.position]).filter((x) => POSITIONS.includes(x)),
            team: info.team || r.team || null,
            inj: info.injury_status || null,
            injPart: info.injury_body_part || null,
            yrs: info.years_exp ?? null,
            wk: {},
            opp: {},
          };
          map.set(r.player_id, p);
        }
        p.wk[week] = points(r.stats, scoring);
        p.opp[week] = r.opponent || null;
      }
    }
    const weeks = projWeeks.map((w) => w.week);
    const mean = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
    for (const p of map.values()) {
      for (const w of weeks) if (p.wk[w] == null) p.wk[w] = 0;
      let now = p.wk[targetWeek] || 0;
      if (SIDELINED.has(p.inj)) now = 0;
      else if (p.inj === 'Doubtful') now *= 0.3;
      p.now = now;
      p.bye = !p.opp[targetWeek];
      p.series = weeks.map((w) => (w === targetWeek ? now : p.wk[w]));
      p.avg = mean(p.series.slice(0, horizon));
      p.rosRaw = mean(p.series);
      // Weekly output when healthy and playing; ignores byes and short injuries.
      const playing = weeks.map((w) => p.wk[w]).filter((v) => v > 0);
      p.talent = mean(playing);
    }
    return map;
  }

  /**
   * Rest-of-season points per week for trades. A week the player misses (injury or bye)
   * is filled by a replacement-level player at his position, since that's what a manager
   * would start instead. A short absence then only costs the gap to a waiver pickup.
   */
  function setRestOfSeason(players, replRos) {
    for (const p of players.values()) {
      if (p.unknown) continue;
      const fill = replRos[p.pos] || 0;
      p.ros = p.series.length ? p.series.reduce((a, v) => a + (v > 0 ? v : fill), 0) / p.series.length : 0;
    }
    // Positional rank by rest-of-season output (QB1 = best QB).
    for (const pos of POSITIONS) {
      [...players.values()].filter((p) => p.pos === pos && !p.unknown)
        .sort((a, b) => b.ros - a.ros)
        .forEach((p, i) => { p.posRank = i + 1; });
    }
  }

  // Placeholder for rostered players the projection feed doesn't cover (deep IR, practice squad).
  function unknownPlayer(id) {
    return { id, name: `Player ${id}`, short: `#${id}`, pos: '?', elig: [], team: null, inj: null, wk: {}, opp: {}, series: [], now: 0, avg: 0, rosRaw: 0, ros: 0, talent: 0, unknown: true };
  }

  /**
   * Fill starting slots with the best eligible players.
   * Slots are filled from most to least restrictive, which is optimal when
   * eligibility sets are nested (standard Sleeper slots are).
   */
  function optimize(ids, slots, players, metric) {
    const order = slots
      .map((s, i) => ({ s, i, n: ELIG[s].length }))
      .sort((a, b) => a.n - b.n || a.i - b.i);
    const pool = [];
    for (const id of ids) {
      const p = players.get(id);
      if (p) pool.push(p);
    }
    pool.sort((a, b) => b[metric] - a[metric]);
    const used = new Set();
    const out = new Array(slots.length);
    let total = 0;
    for (const { s, i } of order) {
      const allowed = ELIG[s];
      let pick = null;
      for (const p of pool) {
        if (used.has(p.id)) continue;
        if (p.elig.some((e) => allowed.includes(e))) { pick = p; break; }
      }
      if (pick) {
        used.add(pick.id);
        out[i] = { slot: s, id: pick.id, v: pick[metric] };
        total += pick[metric];
      } else {
        out[i] = { slot: s, id: null, v: 0 };
      }
    }
    return { total, slots: out, used };
  }

  // Total of the best possible lineup, without building the slot list.
  const lineupTotal = (ids, slots, players, metric) => optimize(ids, slots, players, metric).total;

  /**
   * Replacement level per position: fill every team's starting slots league-wide
   * from the whole player pool; the best player left over at each position is "replacement".
   * In 2-QB and superflex leagues this pushes QB replacement deep, which raises QB value.
   */
  function replacementLevels(players, slots, nTeams, metric = 'avg') {
    const all = [...players.keys()];
    const leagueSlots = slots.flatMap((s) => Array(nTeams).fill(s));
    const { used } = optimize(all, leagueSlots, players, metric);
    const repl = {};
    for (const pos of POSITIONS) {
      let best = 0;
      for (const p of players.values()) {
        if (p.pos === pos && !used.has(p.id) && p[metric] > best) best = p[metric];
      }
      repl[pos] = best;
    }
    return repl;
  }

  /**
   * Average output of the league's starters at each position: fill every team's starting
   * slots league-wide (flex included) from the whole pool, then average whoever starts at each position.
   */
  function starterAverages(players, slots, nTeams, metric) {
    const leagueSlots = slots.flatMap((s) => Array(nTeams).fill(s));
    const sum = {}, n = {};
    for (const s of optimize([...players.keys()], leagueSlots, players, metric).slots) {
      if (!s.id) continue;
      const p = players.get(s.id);
      // Count the player at the position he starts at; a few listed positions differ from fantasy eligibility.
      const pos = ELIG[s.slot].includes(p.pos) ? p.pos : p.elig.find((e) => ELIG[s.slot].includes(e));
      sum[pos] = (sum[pos] || 0) + p[metric];
      n[pos] = (n[pos] || 0) + 1;
    }
    const out = {};
    for (const pos in sum) out[pos] = sum[pos] / n[pos];
    return out;
  }

  return { ELIG, POSITIONS, SIDELINED, starterSlots, slotLabel, points, buildPlayers, setRestOfSeason, unknownPlayer, optimize, lineupTotal, replacementLevels, starterAverages };
})();
