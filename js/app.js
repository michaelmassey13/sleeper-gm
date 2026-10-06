// App state, data loading and event wiring.
(() => {
  const { api, engine: E, ui } = GM;
  const DEFAULT_USER = '998029876424880128'; // cmichaelmassey
  const DEFAULT_LEAGUE = '1353129374185955328'; // ATL Keeper Kings

  const $ = (id) => document.getElementById(id);
  const store = {
    get(k, fallback) { try { const v = localStorage.getItem(`gm.${k}`); return v == null ? fallback : JSON.parse(v); } catch { return fallback; } },
    set(k, v) { try { localStorage.setItem(`gm.${k}`, JSON.stringify(v)); } catch { /* storage unavailable */ } },
  };

  const state = {
    userId: store.get('userId', DEFAULT_USER),
    nfl: null,
    leagues: [],
    leagueId: null,
    rosterId: null,
    week: null,
    tab: store.get('tab', 'overview'),
    ctx: null,
    memo: {},
    waiverFilter: { pos: 'ALL', q: '', trending: false, sort: 'fit' },
    trade: { partner: 'ALL', otherId: null, give: new Set(), get: new Set() },
  };

  const me = () => state.ctx.byRoster.get(state.rosterId);
  // Analyses are cached per team so switching tabs is instant.
  function memo(key, fn) {
    const k = `${state.rosterId}:${key}`;
    if (!(k in state.memo)) state.memo[k] = fn();
    return state.memo[k];
  }
  const lineup = () => memo('lineup', () => E.lineup(state.ctx, me()));
  const waivers = () => memo('waivers', () => E.waivers(state.ctx, me()));
  const ideas = () => memo('trades', () => E.tradeIdeas(state.ctx, me()));
  const profiles = () => memo('profiles', () => E.profiles(state.ctx));

  /* ---------- Loading ---------- */

  function skeleton() {
    $('panel').innerHTML = '<div class="skeleton-grid" aria-busy="true" aria-label="Loading league data"><div class="sk sk-wide"></div><div class="sk"></div><div class="sk"></div><div class="sk"></div></div>';
  }

  async function boot() {
    skeleton();
    try {
      state.nfl = await api.state();
      const leagues = await api.leagues(state.userId, state.nfl.league_season || state.nfl.season);
      if (!leagues.length) throw new Error('This Sleeper account isn’t in any leagues this season. Change the account below.');
      state.leagues = leagues;
      const saved = store.get('leagueId', DEFAULT_LEAGUE);
      state.leagueId = leagues.some((l) => l.league_id === saved) ? saved : leagues[0].league_id;
      fillLeagueSelect();
      await loadLeague({ pickWeek: true });
    } catch (err) {
      showError(err);
    }
  }

  // Once most of a week's games are scored, default to the next week.
  async function defaultWeek(leagueId) {
    const w = state.nfl.week || 1;
    try {
      const ms = await api.matchups(leagueId, w);
      const avg = ms.reduce((a, m) => a + (m.points || 0), 0) / (ms.length || 1);
      return avg > 60 && w < 18 ? w + 1 : w;
    } catch { return w; }
  }

  async function loadLeague({ pickWeek = false } = {}) {
    skeleton();
    setBusy(true);
    try {
      if (pickWeek || !state.week) state.week = await defaultWeek(state.leagueId);
      state.ctx = await E.loadLeague(state.leagueId, state.week, state.nfl);
      state.memo = {};
      const savedRoster = store.get(`roster.${state.leagueId}`, null);
      const mine = state.ctx.teams.find((t) => t.ownerId === state.userId);
      state.rosterId = state.ctx.byRoster.has(savedRoster) ? savedRoster : (mine || state.ctx.teams[0]).rosterId;
      resetTrade();
      fillTeamSelect();
      fillWeekSelect();
      $('league-title').textContent = state.ctx.league.name;
      document.title = `${state.ctx.league.name} · Sleeper GM`;
      $('foot-updated').textContent = `Updated ${new Date().toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}.`;
      render();
    } catch (err) {
      showError(err);
    } finally {
      setBusy(false);
    }
  }

  function showError(err) {
    console.error(err);
    const offline = err instanceof TypeError;
    $('panel').innerHTML = ui.errorView(offline ? 'The Sleeper API didn’t respond. Check your connection and try again.' : err.message);
  }

  function setBusy(on) {
    $('btn-refresh').setAttribute('aria-busy', on ? 'true' : 'false');
    for (const id of ['sel-league', 'sel-team', 'sel-week']) $(id).disabled = on;
  }

  /* ---------- Selects ---------- */

  function fillLeagueSelect() {
    $('sel-league').innerHTML = state.leagues.map((l) =>
      `<option value="${l.league_id}" ${l.league_id === state.leagueId ? 'selected' : ''}>${ui.esc(l.name)}</option>`).join('');
  }
  function fillTeamSelect() {
    const teams = state.ctx.teams.slice().sort((a, b) => (b.ownerId === state.userId) - (a.ownerId === state.userId) || a.name.localeCompare(b.name));
    $('sel-team').innerHTML = teams.map((t) =>
      `<option value="${t.rosterId}" ${t.rosterId === state.rosterId ? 'selected' : ''}>${ui.esc(t.name)}${t.ownerId === state.userId ? ' (you)' : ''}</option>`).join('');
  }
  function fillWeekSelect() {
    const opts = [];
    for (let w = 1; w <= 18; w++) opts.push(`<option value="${w}" ${w === state.week ? 'selected' : ''}>Week ${w}</option>`);
    $('sel-week').innerHTML = opts.join('');
  }
  function resetTrade() {
    const other = state.ctx.teams.find((t) => t.rosterId !== state.rosterId);
    state.trade = { partner: 'ALL', otherId: other ? other.rosterId : null, give: new Set(), get: new Set() };
  }

  /* ---------- Render ---------- */

  function render() {
    if (!state.ctx) return;
    for (const b of document.querySelectorAll('[data-tab]')) b.setAttribute('aria-selected', String(b.dataset.tab === state.tab));
    const ctx = state.ctx, team = me();
    let html;
    switch (state.tab) {
      case 'lineup': html = ui.lineupView(ctx, team, lineup()); break;
      case 'waivers': html = ui.waiversView(ctx, team, waivers(), state.waiverFilter); break;
      case 'trades': html = ui.tradesView(ctx, team, ideas(), state.trade); break;
      case 'league': html = ui.leagueView(ctx, team, profiles()); break;
      default:
        html = ui.overview(ctx, team, { lu: lineup(), mu: E.matchup(ctx, team), wv: waivers(), ideas: ideas(), prof: profiles() });
    }
    $('panel').innerHTML = html;
    updateBadges();
  }

  function updateBadges() {
    const lu = lineup();
    const n = lu.swaps.filter((s) => s.gain > 0.05).length;
    const btn = $('tab-lineup');
    btn.innerHTML = `Lineup${n ? `<span class="count" aria-label="${n} lineup changes">${n}</span>` : ''}`;
  }

  /* ---------- Events ---------- */

  $('tablist').addEventListener('click', (e) => {
    const b = e.target.closest('[data-tab]');
    if (!b) return;
    state.tab = b.dataset.tab;
    store.set('tab', state.tab);
    render();
  });
  $('tablist').addEventListener('keydown', (e) => {
    if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return;
    const tabs = [...document.querySelectorAll('[data-tab]')];
    const i = tabs.findIndex((t) => t.dataset.tab === state.tab);
    const next = tabs[(i + (e.key === 'ArrowRight' ? 1 : tabs.length - 1)) % tabs.length];
    next.focus();
    next.click();
  });

  $('sel-league').addEventListener('change', (e) => {
    state.leagueId = e.target.value;
    store.set('leagueId', state.leagueId);
    loadLeague({ pickWeek: true });
  });
  $('sel-team').addEventListener('change', (e) => {
    state.rosterId = Number(e.target.value);
    store.set(`roster.${state.leagueId}`, state.rosterId);
    resetTrade();
    render();
  });
  $('sel-week').addEventListener('change', (e) => {
    state.week = Number(e.target.value);
    loadLeague();
  });
  $('btn-refresh').addEventListener('click', () => { api.clear(); boot(); });

  const panel = $('panel');
  panel.addEventListener('click', (e) => {
    const go = e.target.closest('[data-go]');
    if (go) { state.tab = go.dataset.go; store.set('tab', state.tab); render(); window.scrollTo({ top: 0, behavior: 'smooth' }); return; }
    if (e.target.closest('[data-retry]')) { api.clear(); boot(); return; }

    const f = e.target.closest('[data-filter]');
    if (f) { state.waiverFilter[f.dataset.filter] = f.dataset.value; render(); return; }

    const load = e.target.closest('[data-load-trade]');
    if (load) {
      const t = JSON.parse(load.dataset.loadTrade);
      state.trade.otherId = t.o;
      state.trade.give = new Set(t.g);
      state.trade.get = new Set(t.r);
      render();
      document.querySelector('.builder')?.scrollIntoView({ behavior: 'smooth', block: 'center' });
      return;
    }
    if (e.target.id === 'builder-clear') { state.trade.give.clear(); state.trade.get.clear(); render(); }
  });

  panel.addEventListener('change', (e) => {
    const t = e.target;
    if (t.id === 'wv-trending') { state.waiverFilter.trending = t.checked; render(); }
    else if (t.id === 'trade-partner') { state.trade.partner = t.value; render(); }
    else if (t.id === 'builder-team') { state.trade.otherId = Number(t.value); state.trade.get.clear(); render(); }
    else if (t.dataset.side) {
      const set = state.trade[t.dataset.side];
      if (t.checked) set.add(t.value); else set.delete(t.value);
      const y = window.scrollY;
      render();
      window.scrollTo(0, y);
    }
  });

  let searchTimer;
  panel.addEventListener('input', (e) => {
    if (e.target.id !== 'wv-search') return;
    clearTimeout(searchTimer);
    const value = e.target.value;
    searchTimer = setTimeout(() => {
      state.waiverFilter.q = value;
      render();
      const input = $('wv-search');
      input.focus();
      input.setSelectionRange(value.length, value.length);
    }, 180);
  });

  /* ---------- Account ---------- */

  const dialog = $('account-dialog');
  $('btn-account').addEventListener('click', () => { $('account-error').hidden = true; dialog.showModal(); $('account-input').focus(); });
  $('account-cancel').addEventListener('click', () => dialog.close());
  $('account-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const name = $('account-input').value.trim();
    if (!name) return;
    try {
      const user = await api.user(name);
      if (!user || !user.user_id) throw new Error(`No Sleeper user named “${name}”.`);
      state.userId = user.user_id;
      store.set('userId', state.userId);
      dialog.close();
      boot();
    } catch (err) {
      $('account-error').textContent = err.message.startsWith('No Sleeper') ? err.message : 'Couldn’t reach Sleeper. Try again.';
      $('account-error').hidden = false;
    }
  });

  boot();
})();
