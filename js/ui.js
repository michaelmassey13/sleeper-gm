// View renderers. Each returns an HTML string for the main panel.
window.GM = window.GM || {};

GM.ui = (() => {
  const M = GM.model;
  const E = GM.engine;

  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const f1 = (n) => (Math.round(n * 10) / 10).toFixed(1);
  const signed = (n, digits = 1) => `${n >= 0 ? '+' : '−'}${Math.abs(n).toFixed(digits)}`;
  const deltaCls = (n) => (n > 0.05 ? 'up' : n < -0.05 ? 'down' : '');
  const pct = (x) => `${Math.round(x * 100)}%`;

  const ICON_ARROW = '<svg class="arrow" viewBox="0 0 20 20" width="18" height="18" aria-hidden="true"><path d="M4 10h12M12 5.5 16.5 10 12 14.5" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/></svg>';
  const ICON_TREND = '<svg viewBox="0 0 12 12" aria-hidden="true"><path d="M1.5 9 4.5 6l2 2 4-4.5M7.5 3.5h3v3" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round"/></svg>';

  const pos = (p) => `<span class="pos pos-${esc(p.pos)}">${esc(p.pos === '?' ? '—' : p.pos)}</span>`;
  const slotBadge = (s) => `<span class="pos slot">${esc(M.slotLabel(s))}</span>`;

  function injChip(p) {
    if (!p.inj) return '';
    const sev = M.SIDELINED.has(p.inj) || p.inj === 'Doubtful' ? 'chip-bad' : 'chip-warn';
    const label = p.inj === 'Questionable' ? 'Q' : p.inj === 'Doubtful' ? 'D' : p.inj;
    return `<span class="chip ${sev}" title="${esc(p.inj)}${p.injPart ? ` · ${esc(p.injPart)}` : ''}">${esc(label)}</span>`;
  }
  function oppText(p, week) {
    if (p.unknown) return 'No projection';
    const o = p.opp[week];
    return o ? `${esc(p.team || 'FA')} vs ${esc(o)}` : `${esc(p.team || 'FA')} · <span class="chip chip-neutral">BYE</span>`;
  }
  function trend(count) {
    if (!count) return '';
    const k = count >= 1000 ? `${Math.round(count / 1000)}k` : String(count);
    return `<span class="trend" title="${count.toLocaleString()} adds across Sleeper in 48h">${ICON_TREND}${k}</span>`;
  }
  const playerBlock = (p, ctx, extra = '') => `
    <div class="grow">
      <div class="pname">${esc(p.name)}</div>
      <div class="pmeta">${oppText(p, ctx.targetWeek)} ${injChip(p)} ${extra}</div>
    </div>`;

  const panel = (span, inner, extraCls = '') => `<section class="panel span-${span} ${extraCls}"><div class="panel-core">${inner}</div></section>`;
  const head = (title, sub = '', kicker = '') =>
    `<div class="panel-head"><div>${kicker ? `<p class="kicker">${kicker}</p>` : ''}<h2>${title}</h2></div>${sub ? `<p>${sub}</p>` : ''}</div>`;
  const empty = (title, body) => `<div class="empty" role="status"><strong>${title}</strong>${body}</div>`;

  // Best three claims, one per position: you only need one streaming defense.
  function topClaims(wv) {
    const seen = new Set();
    return wv.rows.filter((r) => {
      if (seen.has(r.p.pos) || (r.gainAvg < 0.2 && r.gainNow < 0.5)) return false;
      seen.add(r.p.pos);
      return true;
    }).slice(0, 3);
  }

  /* ---------------- Overview ---------------- */

  function overview(ctx, me, d) {
    const { lu, mu, wv, ideas, prof } = d;
    const standing = E.standings(ctx).findIndex((t) => t.rosterId === me.rosterId) + 1;
    const powerRank = prof.totalRank.indexOf(me.rosterId) + 1;

    const matchupHtml = mu ? (() => {
      const lead = mu.mine >= mu.theirs;
      const started = mu.liveMine > 0 || mu.liveTheirs > 0;
      return `
        ${head(`Week ${ctx.targetWeek} matchup`, 'Projected, both teams in their best lineup', 'Head to head')}
        <div class="scoreboard">
          <div class="side">
            <div class="team-name">${esc(me.name)}</div><div class="owner">You · ${me.wins}–${me.losses}${me.ties ? `–${me.ties}` : ''}</div>
            <div class="big-score ${lead ? 'lead' : ''}">${f1(mu.mine)}</div>
          </div>
          <div class="vs">VS</div>
          <div class="side right">
            <div class="team-name">${esc(mu.opp.name)}</div><div class="owner">${mu.opp.owner !== mu.opp.name ? `${esc(mu.opp.owner)} · ` : ''}${mu.opp.wins}–${mu.opp.losses}</div>
            <div class="big-score ${lead ? '' : 'lead'}">${f1(mu.theirs)}</div>
          </div>
        </div>
        <div class="winbar" role="img" aria-label="Estimated win chance ${pct(mu.winProb)}">
          <div class="winbar-track"><div class="winbar-fill" style="width:${(mu.winProb * 100).toFixed(1)}%"></div></div>
          <div class="winbar-labels"><span>Win chance <b class="num">${pct(mu.winProb)}</b></span><span>${pct(1 - mu.winProb)}</span></div>
        </div>
        ${started ? `<p class="live-note">Scored so far: <b class="num">${f1(mu.liveMine)}</b> to <b class="num">${f1(mu.liveTheirs)}</b>.</p>` : ''}`;
    })() : `${head(`Week ${ctx.targetWeek}`, '', 'Head to head')}${empty('No matchup this week', 'This team has a bye or the schedule isn’t set yet.')}`;

    const left = lu.optimalTotal - lu.currentTotal;
    const statHtml = `
      ${head('Your team', '', 'Season')}
      <div class="stat-row">
        <div class="stat"><div class="label">Record</div><div class="value">${me.wins}–${me.losses}${me.ties ? `–${me.ties}` : ''}</div><div class="sub">${ordinal(standing)} of ${ctx.teams.length}</div></div>
        <div class="stat"><div class="label">Points for</div><div class="value num">${Math.round(me.pf)}</div><div class="sub">${Math.round(me.pa)} against</div></div>
        <div class="stat"><div class="label">Lineup left on bench</div><div class="value num" style="color:${left > 0.5 ? 'var(--accent)' : 'var(--good)'}">${f1(left)}</div><div class="sub">${left > 0.5 ? 'points this week' : 'You’re set'}</div></div>
        <div class="stat"><div class="label">Roster strength</div><div class="value">${ordinal(powerRank)}</div><div class="sub">next ${ctx.weeks.length} weeks</div></div>
      </div>`;

    const swaps = lu.swaps.filter((s) => s.gain > 0.05);
    const moves = [];
    for (const s of swaps.slice(0, 4)) {
      moves.push(`<li class="swap">
        <div class="who">${pos(s.in)}<div class="grow"><div class="tag">Start</div><div class="pname">${esc(s.in.name)}</div></div></div>
        ${ICON_ARROW}
        <div class="who">${s.out ? `${pos(s.out)}<div class="grow"><div class="tag">Bench ${injChip(s.out)}${s.out.bye ? '<span class="chip chip-neutral">BYE</span>' : ''}</div><div class="pname">${esc(s.out.name)}</div></div>` : '<div class="grow"><div class="tag">Fill</div><div class="pname muted">Empty slot</div></div>'}</div>
        <span class="delta up">${signed(s.gain)}</span>
      </li>`);
    }
    for (const p of lu.flags.filter((p) => !swaps.some((s) => s.out && s.out.id === p.id)).slice(0, 3)) {
      moves.push(`<li>${pos(p)}${playerBlock(p, ctx)}<span class="chip ${p.bye ? 'chip-neutral' : 'chip-warn'}">${p.bye ? 'On bye' : 'Check status'}</span></li>`);
    }
    const topAdds = topClaims(wv);
    for (const r of topAdds) {
      moves.push(`<li>${pos(r.p)}${playerBlock(r.p, ctx, trend(r.adds))}<span class="chip chip-accent">Claim</span><span class="delta up">${signed(r.gainAvg)}/wk</span></li>`);
    }
    const movesHtml = `${head('Moves to make', `${moves.length ? `${moves.length} suggestions` : ''}`, 'This week')}
      ${moves.length ? `<ul class="list">${moves.join('')}</ul>` : empty('Nothing to change', 'Your best lineup is set and no free agent beats your roster.')}`;

    const best = ideas[0];
    const tradeHtml = `${head('Best trade idea', best ? `with ${esc(ctx.byRoster.get(best.otherId).name)}` : '', 'Trade desk')}
      ${best ? tradeCard(ctx, best, { compact: true }) : empty('No clear trade right now', 'Nothing found that helps you without overpaying.')}
      ${best ? `<p style="margin:1rem 0 0"><button type="button" class="btn-ghost" data-go="trades">See all ${ideas.length} ideas</button></p>` : ''}`;

    const mine = prof.ranks.get(me.rosterId);
    const n = ctx.teams.length;
    const needHtml = `${head('Where you stand', `Starting-lineup rank by position over the next ${ctx.weeks.length} weeks`, 'Roster shape')}
      <div class="needs">${prof.posList.map((ps) => {
        const rk = mine[ps];
        const cls = rk <= Math.ceil(n * 0.3) ? 'strong' : rk > n - Math.ceil(n * 0.3) ? 'weak' : '';
        return `<div class="need ${cls}"><span class="pos pos-${ps}">${ps}</span><div class="rk">${ordinal(rk)}<small>of ${n}</small></div><div class="pmeta">${cls === 'strong' ? 'Surplus to trade from' : cls === 'weak' ? 'Upgrade target' : 'Middle of the pack'}</div></div>`;
      }).join('')}</div>`;

    return `<div class="bento">
      ${panel(8, matchupHtml)}
      ${panel(4, statHtml)}
      ${panel(7, movesHtml)}
      ${panel(5, tradeHtml)}
      ${panel(12, needHtml)}
    </div>`;
  }

  /* ---------------- Lineup ---------------- */

  function weekCells(ctx, p) {
    return ctx.weeks.map((w) => {
      if (p.unknown) return '<td class="wkcell bye">—</td>';
      if (!p.opp[w]) return '<td class="wkcell bye">BYE</td>';
      const v = w === ctx.targetWeek ? p.now : p.wk[w];
      return `<td class="wkcell ${v >= 12 ? 'hot' : ''}">${f1(v)}</td>`;
    }).join('');
  }
  const weekHeads = (ctx) => ctx.weeks.map((w) => `<th class="r">Wk ${w}</th>`).join('');

  function lineupView(ctx, me, lu) {
    const rows = ctx.slots.map((slot, i) => {
      const cur = lu.current[i];
      const rec = lu.best.slots[i];
      const curP = cur.id ? E.P(ctx, cur.id) : null;
      const recP = rec.id ? E.P(ctx, rec.id) : null;
      const changed = (cur.id || null) !== (rec.id || null);
      return `<tr class="${changed ? 'is-change' : ''}">
        <td>${slotBadge(slot)}</td>
        <td><div class="cell-player">${curP ? `${pos(curP)}<div class="grow"><div class="pname">${esc(curP.name)}</div><div class="pmeta">${oppText(curP, ctx.targetWeek)} ${injChip(curP)}</div></div>` : '<span class="muted">Empty</span>'}</div></td>
        <td class="r num">${curP ? f1(curP.now) : '—'}</td>
        <td><div class="cell-player">${recP ? `${pos(recP)}<div class="grow"><div class="pname">${esc(recP.name)}</div><div class="pmeta">${oppText(recP, ctx.targetWeek)} ${injChip(recP)}</div></div>` : '<span class="muted">No eligible player</span>'}</div></td>
        <td class="r num">${recP ? f1(recP.now) : '—'}</td>
        <td class="c">${changed ? '<span class="chip chip-accent">Swap</span>' : '<span class="chip chip-good">Keep</span>'}</td>
      </tr>`;
    }).join('');

    const gain = lu.optimalTotal - lu.currentTotal;
    const slotTable = `${head(`Week ${ctx.targetWeek} lineup`, gain > 0.05 ? `Best lineup adds <b class="num">${signed(gain)}</b> projected points` : 'Your set lineup is already the best one', 'Start / sit')}
      <div class="table-wrap"><table>
        <thead><tr><th>Slot</th><th>Set in Sleeper</th><th class="r">Proj</th><th>Recommended</th><th class="r">Proj</th><th class="c">Call</th></tr></thead>
        <tbody>${rows}</tbody>
        <tfoot><tr><td></td><td class="muted">Total</td><td class="r num">${f1(lu.currentTotal)}</td><td></td><td class="r num"><b>${f1(lu.optimalTotal)}</b></td><td></td></tr></tfoot>
      </table></div>`;

    const roster = [...lu.best.slots.filter((s) => s.id).map((s) => ({ p: E.P(ctx, s.id), role: M.slotLabel(s.slot) })),
      ...lu.bench.map((p) => ({ p, role: 'BN' })), ...lu.reserve.map((p) => ({ p, role: 'IR' }))];
    const horizonTable = `${head('Bye and matchup planner', `Projected points with your league’s scoring, weeks ${ctx.weeks[0]}–${ctx.weeks[ctx.weeks.length - 1]}`, 'Next weeks')}
      <div class="table-wrap"><table>
        <thead><tr><th>Role</th><th>Player</th>${weekHeads(ctx)}<th class="r">Avg</th></tr></thead>
        <tbody>${roster.map(({ p, role }) => `<tr><td><span class="pos slot">${esc(role)}</span></td><td><div class="cell-player">${pos(p)}<div class="grow"><div class="pname">${esc(p.name)}</div><div class="pmeta">${esc(p.team || 'FA')} ${injChip(p)}</div></div></div></td>${weekCells(ctx, p)}<td class="r num"><b>${p.unknown ? '—' : f1(p.avg)}</b></td></tr>`).join('')}</tbody>
      </table></div>`;

    return `<div class="bento">${panel(12, slotTable)}${panel(12, horizonTable)}</div>`;
  }

  /* ---------------- Waivers ---------------- */

  function waiversView(ctx, me, wv, filter) {
    const positions = ['ALL', ...new Set(ctx.slots.flatMap((s) => M.ELIG[s]))].filter((p, i, a) => a.indexOf(p) === i);
    const q = filter.q.trim().toLowerCase();
    let rows = wv.rows;
    if (filter.pos !== 'ALL') rows = rows.filter((r) => r.p.pos === filter.pos);
    if (filter.trending) rows = rows.filter((r) => r.adds > 0);
    if (q) rows = rows.filter((r) => r.p.name.toLowerCase().includes(q) || (r.p.team || '').toLowerCase() === q);
    if (filter.sort === 'avg') rows = rows.slice().sort((a, b) => b.p.avg - a.p.avg);
    if (filter.sort === 'adds') rows = rows.slice().sort((a, b) => b.adds - a.adds);

    const top = topClaims(wv);
    const dropTxt = wv.drop ? `Drop <b>${esc(wv.drop.name)}</b> <span class="muted">(${wv.drop.pos}, ${f1(wv.drop.avg)}/wk)</span>` : `You have ${wv.openSpots} open roster spot${wv.openSpots === 1 ? '' : 's'}`;
    const claims = `${head('Recommended claims', 'Ranked by how much each player improves your best lineup', 'Waiver wire')}
      ${top.length ? `<div class="claims">${top.map((r, i) => `
        <article class="claim">
          <div style="display:flex;justify-content:space-between;align-items:flex-start;gap:.5rem">
            <span class="rank">${i + 1}</span>
            <span style="display:flex;gap:.4rem;align-items:center">${trend(r.adds)}${pos(r.p)}</span>
          </div>
          <div><div class="cname">${esc(r.p.name)}</div><div class="pmeta">${oppText(r.p, ctx.targetWeek)} ${injChip(r.p)}</div></div>
          <div class="gains">
            <div><span class="v">${signed(r.gainNow)}</span><span class="l">Week ${ctx.targetWeek}</span></div>
            <div><span class="v">${signed(r.gainAvg)}</span><span class="l">Per week, next ${ctx.weeks.length}</span></div>
            <div><span class="v" style="color:var(--ink)">${f1(r.p.avg)}</span><span class="l">Proj avg</span></div>
          </div>
          <div class="dropline">${dropTxt}</div>
        </article>`).join('')}</div>`
        : empty('No free agent improves your lineup', 'Check the trending column for stash candidates.')}`;

    const seg = (name, val, label, cur) => `<button type="button" data-filter="${name}" data-value="${val}" aria-pressed="${cur === val}">${label}</button>`;
    const table = `${head('Free agents', `${rows.length} players`, 'Full wire')}
      <div class="toolbar">
        <div class="seg" role="group" aria-label="Position">${positions.map((p) => seg('pos', p, p === 'ALL' ? 'All' : p, filter.pos)).join('')}</div>
        <div class="seg" role="group" aria-label="Sort by">${seg('sort', 'fit', 'Best fit', filter.sort)}${seg('sort', 'avg', 'Projection', filter.sort)}${seg('sort', 'adds', 'Trending', filter.sort)}</div>
        <input class="search" type="search" id="wv-search" placeholder="Search name or team" aria-label="Search free agents" value="${esc(filter.q)}">
        <label class="check"><input type="checkbox" id="wv-trending" ${filter.trending ? 'checked' : ''}> Trending only</label>
      </div>
      ${rows.length ? `<div class="table-wrap"><table>
        <thead><tr><th>Player</th><th class="r">Wk ${ctx.targetWeek} gain</th><th class="r">Gain / wk</th>${weekHeads(ctx)}<th class="r">Avg</th><th class="r">Adds 48h</th></tr></thead>
        <tbody>${rows.slice(0, 80).map((r) => `<tr>
          <td><div class="cell-player">${pos(r.p)}<div class="grow"><div class="pname">${esc(r.p.name)}</div><div class="pmeta">${esc(r.p.team)} ${injChip(r.p)}</div></div></div></td>
          <td class="r"><span class="delta ${deltaCls(r.gainNow)}">${r.gainNow > 0.05 ? signed(r.gainNow) : '—'}</span></td>
          <td class="r"><span class="delta ${deltaCls(r.gainAvg)}">${r.gainAvg > 0.05 ? signed(r.gainAvg) : '—'}</span></td>
          ${weekCells(ctx, r.p)}
          <td class="r num"><b>${f1(r.p.avg)}</b></td>
          <td class="r">${trend(r.adds) || '<span class="muted">—</span>'}</td>
        </tr>`).join('')}</tbody></table></div>`
        : empty('No players match', 'Try another position or clear the search.')}`;

    return `<div class="bento">${panel(12, claims)}${panel(12, table)}</div>`;
  }

  /* ---------------- Trades ---------------- */

  // Rest-of-season average of the league's starters at the player's position, flex included.
  const avgLine = (ctx, p) => (ctx.starterAvg[p.pos] != null ? `<small class="faint">${p.pos} avg ${f1(ctx.starterAvg[p.pos])}</small>` : '');

  const VERDICT_CLASS = { 'Win-win': 'chip-good', 'Fair value': 'chip-accent', 'Long shot': 'chip-warn', 'Tough sell': 'chip-warn', 'Hurts you': 'chip-bad', Neutral: 'chip-neutral' };

  function tradeCard(ctx, t, { compact = false } = {}) {
    const other = ctx.byRoster.get(t.otherId);
    const sideList = (ids) => `<ul>${ids.map((id) => { const p = E.P(ctx, id); return `<li>${pos(p)}<span class="pname">${esc(p.name)}</span>${p.posRank ? `<span class="muted" style="font-size:.75rem;white-space:nowrap">${p.pos}${p.posRank}</span>` : ''}<span class="trade-val"><b>${f1(E.tradeValue(ctx, p))}</b><small>${p.unknown ? '—' : f1(p.ros)} pts</small>${avgLine(ctx, p)}</span></li>`; }).join('')}</ul>`;
    const vClass = VERDICT_CLASS[t.verdict];
    return `<article class="trade">
      ${compact ? '' : `<div class="trade-top"><span class="trade-partner">${esc(other.name)}${other.owner !== other.name ? ` <span class="muted" style="font-weight:400">· ${esc(other.owner)}</span>` : ''}</span><span class="chip ${vClass}">${t.verdict}</span></div>`}
      <div class="trade-sides">
        <div class="trade-side"><h4>You send</h4>${sideList(t.give)}</div>
        ${ICON_ARROW}
        <div class="trade-side"><h4>You get</h4>${sideList(t.get)}</div>
      </div>
      <div class="trade-foot">
        <div class="trade-metrics">
          <span>You <b class="delta ${deltaCls(t.gMe)}">${signed(t.gMe)}</b>/wk</span>
          <span>Them <b class="delta ${deltaCls(t.gThem)}">${signed(t.gThem)}</b>/wk</span>
          <span>Trade value <b>${f1(t.tvGive)}</b> for <b>${f1(t.tvGet)}</b></span>
        </div>
        ${compact ? `<span class="chip ${vClass}">${t.verdict}</span>` : `<button type="button" class="btn-ghost" data-load-trade='${esc(JSON.stringify({ o: t.otherId, g: t.give, r: t.get }))}'>Open in builder</button>`}
      </div>
    </article>`;
  }

  function tradesView(ctx, me, ideas, st) {
    const partners = ctx.teams.filter((t) => t.rosterId !== me.rosterId);
    const shown = st.partner === 'ALL' ? ideas : ideas.filter((t) => String(t.otherId) === st.partner);
    const ideasHtml = `${head('Trade ideas', `Deals that raise your best lineup for the rest of the season (weeks ${ctx.rosWeeks[0]}–${ctx.rosWeeks[ctx.rosWeeks.length - 1]}) without asking the other team to overpay`, 'Trade desk')}
      <div class="toolbar">
        <label class="field"><span>Partner</span><select id="trade-partner">
          <option value="ALL">All teams</option>
          ${partners.map((t) => `<option value="${t.rosterId}" ${String(t.rosterId) === st.partner ? 'selected' : ''}>${esc(t.name)}</option>`).join('')}
        </select></label>
      </div>
      ${shown.length ? `<div class="trade-list">${shown.slice(0, 12).map((t) => tradeCard(ctx, t)).join('')}</div>`
        : empty('No ideas with this team', 'Their roster doesn’t line up with your needs right now.')}`;

    const other = ctx.byRoster.get(Number(st.otherId)) || partners[0];
    const pickList = (team, side, set) => `<ul class="pick-list">${E.activeIds(team).map((id) => E.P(ctx, id)).sort((a, b) => b.ros - a.ros).map((p) => `
      <li><label><input type="checkbox" data-side="${side}" value="${esc(p.id)}" ${set.has(p.id) ? 'checked' : ''}>${pos(p)}<span class="grow"><span class="pname" style="display:block">${esc(p.name)}</span><span class="pmeta">${esc(p.team || 'FA')}${p.posRank ? ` · ${p.pos}${p.posRank}` : ''} · value ${f1(E.tradeValue(ctx, p))}</span></span><span class="trade-val"><b>${p.unknown ? '—' : f1(p.ros)}</b>${avgLine(ctx, p)}</span></label></li>`).join('')}</ul>`;

    let verdict = '<p class="muted" style="margin:1rem 0 0;font-size:.875rem">Pick players on both sides to see how the deal changes each lineup.</p>';
    if (st.give.size && st.get.size) {
      const t = E.evaluateTrade(ctx, me, other, [...st.give], [...st.get]);
      const call = {
        'Win-win': 'Both lineups get better. Good one to send.',
        'Fair value': 'You get better and the value is fair. They may need a nudge.',
        'Long shot': 'Fair on value, but their lineup gets a little worse, so they have little reason to say yes.',
        'Tough sell': 'Helps you, but they give up more value than they get.',
        'Hurts you': 'Your best lineup gets worse. Pass.',
        Neutral: 'Barely moves your lineup either way.',
      }[t.verdict];
      verdict = `<div class="verdict">
        <div class="stat"><div class="label">You, per week rest of season</div><div class="value delta ${deltaCls(t.gMe)}">${signed(t.gMe)}</div><div class="sub">Wk ${ctx.targetWeek}: ${signed(t.gMeNow)}</div></div>
        <div class="stat"><div class="label">Them, per week rest of season</div><div class="value delta ${deltaCls(t.gThem)}">${signed(t.gThem)}</div><div class="sub">Wk ${ctx.targetWeek}: ${signed(t.gThemNow)}</div></div>
        <div class="stat"><div class="label">Value sent</div><div class="value num">${f1(t.tvGive)}</div><div class="sub">pts over replacement</div></div>
        <div class="stat"><div class="label">Value received</div><div class="value num">${f1(t.tvGet)}</div><div class="sub">pts over replacement</div></div>
        <div class="verdict-call"><span class="chip ${VERDICT_CLASS[t.verdict]}">${t.verdict}</span>${call}</div>
      </div>`;
    }

    const builder = `${head('Trade builder', 'Value is points per week above a replacement-level starter in this league', 'Build your own')}
      <div class="toolbar">
        <label class="field"><span>Trade with</span><select id="builder-team">${partners.map((t) => `<option value="${t.rosterId}" ${t.rosterId === other.rosterId ? 'selected' : ''}>${esc(t.name)}</option>`).join('')}</select></label>
        <button type="button" class="btn-ghost" id="builder-clear">Clear picks</button>
      </div>
      <div class="builder">
        <div><p class="kicker">You send</p>${pickList(me, 'give', st.give)}</div>
        <div><p class="kicker">You get from ${esc(other.name)}</p>${pickList(other, 'get', st.get)}</div>
      </div>
      ${verdict}`;

    return `<div class="bento">${panel(6, ideasHtml)}${panel(6, builder, '')}</div>`;
  }

  /* ---------------- League ---------------- */

  function leagueView(ctx, me, prof) {
    const n = ctx.teams.length;
    const lvl = (rk) => (rk <= Math.ceil(n * 0.2) ? 1 : rk <= Math.ceil(n * 0.4) ? 2 : rk <= n - Math.ceil(n * 0.4) ? 3 : rk <= n - Math.ceil(n * 0.2) ? 4 : 5);
    const byTotal = new Map(prof.totalRank.map((id, i) => [id, i + 1]));
    const st = E.standings(ctx);
    const rows = st.map((t, i) => {
      const r = prof.ranks.get(t.rosterId);
      return `<tr class="${t.rosterId === me.rosterId ? 'me' : ''}">
        <td class="num muted">${i + 1}</td>
        <td><div class="pname">${esc(t.name)}</div>${t.owner !== t.name ? `<div class="pmeta">${esc(t.owner)}</div>` : ''}</td>
        <td class="num">${t.wins}–${t.losses}${t.ties ? `–${t.ties}` : ''}</td>
        <td class="r num">${f1(t.pf)}</td>
        <td class="r num">${f1(t.pa)}</td>
        <td class="h"><span class="lvl lvl-${lvl(byTotal.get(t.rosterId))}">${byTotal.get(t.rosterId)}</span></td>
        ${prof.posList.map((ps) => `<td class="h"><span class="lvl lvl-${lvl(r[ps])}" title="${ps} rank ${r[ps]} of ${n}">${r[ps]}</span></td>`).join('')}
      </tr>`;
    }).join('');

    const table = `${head('Standings and roster ranks', `Ranks compare each team’s best starting lineup over the next ${ctx.weeks.length} weeks (1 = best)`, ctx.league.name)}
      <div class="table-wrap"><table class="heat">
        <thead><tr><th>#</th><th>Team</th><th>Record</th><th class="r">PF</th><th class="r">PA</th><th class="c">Overall</th>${prof.posList.map((p) => `<th class="c">${p}</th>`).join('')}</tr></thead>
        <tbody>${rows}</tbody>
      </table></div>
      <div class="legend"><span><span class="chip chip-good">1–${Math.ceil(n * 0.2)}</span> strong</span><span><span class="chip chip-bad">${n - Math.ceil(n * 0.2) + 1}–${n}</span> weak</span><span>Trade from a strong spot to a team that’s weak there.</span></div>`;

    const sc = ctx.scoring;
    const fmtSlots = ctx.league.roster_positions.reduce((m, s) => (m.set(s, (m.get(s) || 0) + 1), m), new Map());
    const settings = `${head('League rules in use', '', 'Scoring')}
      <ul class="list">
        <li><span class="grow">Starting lineup</span><span class="num">${[...fmtSlots].filter(([s]) => s !== 'BN').map(([s, c]) => `${c} ${M.slotLabel(s)}`).join(' · ')}</span></li>
        <li><span class="grow">Bench</span><span class="num">${fmtSlots.get('BN') || 0}</span></li>
        <li><span class="grow">Per reception</span><span class="num">${sc.rec ?? 0}</span></li>
        <li><span class="grow">Passing TD / INT</span><span class="num">${sc.pass_td ?? 0} / ${sc.pass_int ?? 0}</span></li>
        <li><span class="grow">Sacks taken (QB)</span><span class="num">${sc.pass_sack ?? 0}</span></li>
        ${sc.bonus_rec_te ? `<li><span class="grow">TE reception bonus</span><span class="num">${sc.bonus_rec_te}</span></li>` : ''}
        ${ctx.league.settings.max_keepers ? `<li><span class="grow">Keepers</span><span class="num">${ctx.league.settings.max_keepers} per team</span></li>` : ''}
      </ul>`;
    const repl = `${head('Replacement level', 'Points per week of the best player left over after every team fills its lineup', 'How value is measured')}
      <ul class="list">${prof.posList.map((ps) => `<li>${pos({ pos: ps })}<span class="grow muted">Freely available ${ps}</span><span class="num">${f1(ctx.repl[ps] || 0)}</span></li>`).join('')}</ul>`;

    return `<div class="bento">${panel(12, table)}${panel(6, settings)}${panel(6, repl)}</div>`;
  }

  function errorView(msg) {
    return `<div class="panel error-card"><div class="panel-core">
      <h2>Couldn’t load Sleeper</h2><p>${esc(msg)}</p>
      <button type="button" class="btn-solid" data-retry>Try again</button>
    </div></div>`;
  }

  function ordinal(n) {
    const s = ['th', 'st', 'nd', 'rd'], v = n % 100;
    return n + (s[(v - 20) % 10] || s[v] || s[0]);
  }

  return { overview, lineupView, waiversView, tradesView, leagueView, errorView, esc };
})();
