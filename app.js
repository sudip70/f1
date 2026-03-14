/* ═══════════════════════════════════════════════════════════════════
   F1. Analytics — app.js
   Jolpica F1  →  race results, standings, qualifying
   OpenF1      →  pit stop data

   Run via a local server — cannot fetch from file:// URLs.
   Quick start:  python3 -m http.server 8080
                 npx serve .

   FIXES APPLIED (v2):
   [1]  document.currentScript → null-safe DOM check
   [2]  Cache TTL for live/current season (5 min)
   [3]  renderGeneration guard — prevents stale chart renders on rapid season switching
   [4]  Tab buttons use data-tab attribute matching (not fragile textContent)
   [5]  Global onclick replaced with addEventListener after render
   [6]  Sprint points (2021+) — documented limitation, stub comment added
   [7]  loadPitData catch block now logs warning instead of silent swallow
   [8]  AbortController cancels in-flight fetches on rapid season switches
   [9]  animateCount guards against 0/falsy targets
   [10] season-bar buttons get aria-pressed for accessibility
   [11] SEASONS derived dynamically from current year (no hardcoded 2025)
   [12] teamColor() memoized
   [13] renderSeason split into focused sub-renderers
   [14] <meta> tags added in index.html (see note in README)

   FIXES APPLIED (v3):
   [15] isCorsError() wired into fetchAndRender catch block for friendly error message
   [16] Removed unused d1Qual / d2Qual variables in buildTeammateComparisonData

   PERFORMANCE IMPROVEMENTS (v4):
   [17] All three main fetches (results, standings, qualifying) now run in parallel
   [18] Batch delay reduced from 300ms → 150ms
   [19] Batch size increased from 3 → 5 pages per batch
   [20] Adjacent seasons pre-fetched silently after render
═══════════════════════════════════════════════════════════════════ */
'use strict';

/* ─── Config ─────────────────────────────────────────────────────── */
const JOLPICA     = 'https://api.jolpi.ca/ergast/f1';
const OPENF1      = 'https://api.openf1.org/v1';
const CACHE_TTL   = 5 * 60 * 1000;           // 5 minutes — for live/current season
// FIX [11]: derive dynamically so the app stays current every year
const THIS_YEAR   = new Date().getFullYear();
const SEASONS     = Array.from({ length: THIS_YEAR - 1999 }, (_, i) => THIS_YEAR - i);

/* ─── Team colours ───────────────────────────────────────────────── */
const TEAM_COLORS = {
  'Red Bull Racing': '#3671C6', 'Red Bull': '#3671C6',
  'Mercedes':        '#00A19C',
  'Ferrari':         '#E8002D',
  'McLaren':         '#FF8000',
  'Aston Martin':    '#358C75',
  'Alpine F1 Team':  '#e664a0', 'Alpine': '#e664a0',
  'Williams':        '#37bedd',
  'AlphaTauri':      '#5e8fca', 'RB F1 Team': '#5e8fca', 'RB': '#5e8fca',
  'Racing Point':    '#f070a0',
  'Renault':         '#e8c300',
  'Toro Rosso':      '#469BFF',
  'Haas F1 Team':    '#b0b0b0', 'Haas': '#b0b0b0',
  'Sauber':          '#42b544', 'Kick Sauber': '#42b544',
  'Force India':     '#f070a0',
  'Lotus F1':        '#c8a800', 'Lotus': '#c8a800',
  'BAR':             '#b8940f',
  'Jordan':          '#c89500',
  'Jaguar':          '#005826',
  'Arrows':          '#c85800',
  'Prost':           '#1c4ab5',
  'Minardi':         '#666666',
  'Toyota':          '#c84040',
  'BMW Sauber':      '#2255bb',
  'Super Aguri':     '#aa0000',
  'Spyker':          '#d05000',
  'HRT':             '#999999',
  'Caterham':        '#00692a',
  'Marussia':        '#580000', 'Manor Marussia': '#580000',
};

// FIX [12]: memoize teamColor to avoid re-scanning the map on every call
const _teamColorCache = {};
function teamColor(name) {
  if (!name) return '#aaa';
  if (_teamColorCache[name]) return _teamColorCache[name];
  const lower = name.toLowerCase();
  for (const [key, color] of Object.entries(TEAM_COLORS)) {
    if (lower.includes(key.toLowerCase())) {
      return (_teamColorCache[name] = color);
    }
  }
  return (_teamColorCache[name] = '#999');
}

/* ─── Historical points systems ──────────────────────────────────── */
const PTS_SYSTEMS = {
  modern:  [25, 18, 15, 12, 10, 8, 6, 4, 2, 1], // 2010+
  mid:     [10,  8,  6,  5,  4, 3, 2, 1],        // 2003–2009
  classic: [10,  6,  4,  3,  2, 1],              // 2000–2002
};

function getPoints(position, year) {
  const sys = year >= 2010 ? PTS_SYSTEMS.modern
            : year >= 2003 ? PTS_SYSTEMS.mid
            : PTS_SYSTEMS.classic;
  return sys[position - 1] || 0;
}
// NOTE [6]: Sprint race bonus points (2021+) are NOT included in the points
// progression chart — they require a separate /sprint/ endpoint call per round.
// Cumulative totals for 2021+ seasons will be slightly lower than official standings.
// To fix: fetch `jolpicaFetch(`${year}/sprint/`)` and merge into allResults.

/* ─── State ──────────────────────────────────────────────────────── */
let currentSeason         = THIS_YEAR - 1;      // default to last completed season
let currentTab            = 'races';
let seasonCache           = {};
let seasonCacheTime       = {};                  // FIX [2]: TTL timestamps per season
let chartInstances        = {};
let isLoading             = false;
let typewriterTimer       = null;
let renderGeneration      = 0;                   // FIX [3]: stale chart render guard
let activeFetchController = null;               // FIX [8]: abort controller
let expandedRound         = null;               // race drill-down: currently open round

/* ─── Fetch helpers ──────────────────────────────────────────────── */
// FIX [15]: wired into fetchAndRender catch block for a friendly error message
function isCorsError(err) {
  return err instanceof TypeError && (
    err.message === 'Failed to fetch' ||
    err.message.includes('NetworkError') ||
    err.message.includes('CORS')
  );
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// FIX [8]: accept an AbortSignal so in-flight requests can be cancelled
// Retry up to 3 times on 429 with exponential backoff (1s, 2s, 4s)
async function jolpicaFetch(path, signal, _attempt = 0) {
  const res = await fetch(`${JOLPICA}/${path}`, { signal });
  if (res.status === 429) {
    if (_attempt >= 3) throw new Error('Jolpica rate limit exceeded — please wait a moment then try again');
    const delay = Math.pow(2, _attempt) * 1000;
    await sleep(delay);
    return jolpicaFetch(path, signal, _attempt + 1);
  }
  if (!res.ok) throw new Error(`Jolpica ${res.status}: ${path}`);
  return res.json();
}

// PERF [18][19]: batch size 5, delay 150ms — faster than original 3/300ms
// while still staying within Jolpica rate limits.
// onProgress(fetched, total) is called after each batch for live UI updates.
async function jolpicaFetchBatched(paths, signal, onProgress) {
  const BATCH = 5;   // PERF [19]: increased from 3
  const results = [];
  for (let i = 0; i < paths.length; i += BATCH) {
    if (i > 0) await sleep(150);  // PERF [18]: reduced from 300ms
    const batch = paths.slice(i, i + BATCH);
    const pages = await Promise.all(batch.map(p => jolpicaFetch(p, signal)));
    results.push(...pages);
    if (onProgress) onProgress(results.length, paths.length);
  }
  return results;
}

async function openf1Fetch(path) {
  const res = await fetch(`${OPENF1}/${path}`);
  if (!res.ok) throw new Error(`OpenF1 ${res.status}: ${path}`);
  return res.json();
}

/* ─── Lap time helpers ───────────────────────────────────────────── */
function computeQuartiles(arr) {
  if (!arr.length) return null;
  const s = [...arr].sort((a, b) => a - b);
  const n = s.length;
  return {
    min: s[0],
    q1:  s[Math.floor(n * 0.25)],
    med: s[Math.floor(n * 0.50)],
    q3:  s[Math.floor(n * 0.75)],
    max: s[n - 1],
  };
}

// Fetch lap times + driver map for one race from OpenF1 (on-demand)
async function fetchRaceLapTimes(year, round, raceDate) {
  try {
    const sessions = await openf1Fetch(`sessions?year=${year}&session_name=Race`);
    // Match by date first (most reliable), fall back to array index
    const session = sessions.find(s => s.date_start?.startsWith(raceDate))
                 || sessions[round - 1];
    if (!session) throw new Error('session not found');

    const [laps, of1Drivers] = await Promise.all([
      openf1Fetch(`laps?session_key=${session.session_key}`),
      openf1Fetch(`drivers?session_key=${session.session_key}`),
    ]);

    // Build driver_number → code map
    const numToCode = {};
    of1Drivers.forEach(d => { numToCode[d.driver_number] = d.name_acronym; });

    return { session, laps, numToCode };
  } catch (err) {
    console.warn('Lap time fetch failed:', err.message);
    return null;
  }
}

/* ─── Paginated race results fetch ───────────────────────────────────
   Jolpica caps each page at 30 rows regardless of `limit`.
   Each row is ONE driver result, not one race.
   A 24-race season ≈ 480 rows (24 × 20 drivers).
   The same round can be split across pages, so we merge by round number.
─────────────────────────────────────────────────────────────────── */
async function fetchRaceResults(year, signal) {
  const PAGE = 30;
  const first = await jolpicaFetch(`${year}/results/?limit=${PAGE}&offset=0`, signal);
  const total = parseInt(first.MRData.total) || 0;

  const remainingOffsets = [];
  for (let o = PAGE; o < total; o += PAGE) remainingOffsets.push(o);

  const restPaths = remainingOffsets.map(o => `${year}/results/?limit=${PAGE}&offset=${o}`);
  const rest = await jolpicaFetchBatched(restPaths, signal, (done, tot) => {
    const sub = document.querySelector('.loading-sub');
    if (sub) sub.textContent = `JOLPICA F1 — ${year} · results ${done + 1} / ${tot + 1} pages`;
  });
  const pages = [first, ...rest];

  const byRound = {};
  pages.forEach(page => {
    (page.MRData.RaceTable.Races || []).forEach(race => {
      if (!byRound[race.round]) {
        byRound[race.round] = { ...race, Results: [] };
      }
      byRound[race.round].Results.push(...(race.Results || []));
    });
  });

  return Object.values(byRound)
    .sort((a, b) => parseInt(a.round) - parseInt(b.round));
}

/* ─── Paginated qualifying fetch (same merge strategy) ───────────── */
async function fetchQualifying(year, signal) {
  const PAGE = 30;
  const first = await jolpicaFetch(`${year}/qualifying/?limit=${PAGE}&offset=0`, signal);
  const total = parseInt(first.MRData.total) || 0;

  const remainingOffsets = [];
  for (let o = PAGE; o < total; o += PAGE) remainingOffsets.push(o);

  const restPaths = remainingOffsets.map(o => `${year}/qualifying/?limit=${PAGE}&offset=${o}`);
  const rest = await jolpicaFetchBatched(restPaths, signal, (done, tot) => {
    const sub = document.querySelector('.loading-sub');
    if (sub) sub.textContent = `JOLPICA F1 — ${year} · qualifying ${done + 1} / ${tot + 1} pages`;
  });
  const pages = [first, ...rest];

  const byRound = {};
  pages.forEach(page => {
    (page.MRData.RaceTable.Races || []).forEach(race => {
      if (!byRound[race.round]) {
        byRound[race.round] = { ...race, QualifyingResults: [] };
      }
      byRound[race.round].QualifyingResults.push(...(race.QualifyingResults || []));
    });
  });

  return Object.values(byRound)
    .sort((a, b) => parseInt(a.round) - parseInt(b.round));
}

/* ─── Load a full season ─────────────────────────────────────────── */
async function loadSeason(year, signal) {
  // FIX [2]: for the current/live season, bust the cache after TTL
  const isLiveSeason = year === THIS_YEAR;
  const now          = Date.now();
  const expired      = !seasonCacheTime[year] || (now - seasonCacheTime[year] > CACHE_TTL);

  if (seasonCache[year] && !(isLiveSeason && expired)) {
    return seasonCache[year];
  }

  // PERF [17]: all four fetches run in parallel instead of sequentially.
  // Results, standings, and qualifying are all independent so there's no
  // reason to wait for one before starting the next.
  const [rawRaces, constructorRes, driverRes, rawQual] = await Promise.all([
    fetchRaceResults(year, signal),
    jolpicaFetch(`${year}/constructorstandings/`, signal),
    jolpicaFetch(`${year}/driverstandings/`, signal),
    fetchQualifying(year, signal),
  ]);

  // Parse races
  const races = rawRaces.map(r => {
    const top = r.Results?.[0] || {};
    return {
      round:   parseInt(r.round),
      name:    r.raceName.replace(' Grand Prix', ' GP'),
      circuit: r.Circuit?.circuitName || '',
      country: r.Circuit?.Location?.country || '',
      date:    r.date,
      winner:  top.Driver ? `${top.Driver.givenName} ${top.Driver.familyName}` : '—',
      team:    top.Constructor?.name || '—',
      grid:    parseInt(top.grid) || 0,
      laps:    parseInt(top.laps) || 0,
      time:    top.Time?.time || top.status || '—',
      allResults: (r.Results || []).map(res => ({
        pos:        parseInt(res.position) || 99,
        name:       `${res.Driver.givenName} ${res.Driver.familyName}`,
        code:       res.Driver.code,
        team:       res.Constructor?.name || '—',
        grid:       parseInt(res.grid) || 0,
        fastestLap: res.FastestLap?.rank === '1',
      })),
    };
  });

  // Parse constructor standings
  const cStandings   = constructorRes.MRData.StandingsTable.StandingsLists?.[0];
  const constructors = (cStandings?.ConstructorStandings || []).map(c => ({
    pos:    parseInt(c.position),
    team:   c.Constructor.name,
    points: parseFloat(c.points),
    wins:   parseInt(c.wins),
  }));

  // Parse driver standings
  const dStandings = driverRes.MRData.StandingsTable.StandingsLists?.[0];
  const champion   = dStandings?.DriverStandings?.[0];
  const drivers    = (dStandings?.DriverStandings || []).map(d => ({
    pos:    parseInt(d.position),
    name:   `${d.Driver.givenName} ${d.Driver.familyName}`,
    code:   d.Driver.code,
    nat:    d.Driver.nationality,
    team:   d.Constructors?.[0]?.name || '—',
    points: parseFloat(d.points),
    wins:   parseInt(d.wins),
  }));

  // Parse qualifying
  const qualifying = rawQual.map(r => ({
    round: parseInt(r.round),
    name:  r.raceName.replace(' Grand Prix', ' GP'),
    date:  r.date,
    results: (r.QualifyingResults || [])
      .sort((a, b) => parseInt(a.position) - parseInt(b.position))
      .map(q => ({
        pos:  parseInt(q.position),
        name: `${q.Driver.givenName} ${q.Driver.familyName}`,
        code: q.Driver.code,
        team: q.Constructor.name,
        q1:   q.Q1 || null,
        q2:   q.Q2 || null,
        q3:   q.Q3 || null,
      })),
  }));

  // Champion summary stats
  const champDriver = champion?.Driver;
  const champTeam   = champion?.Constructors?.[0];
  const champCode   = champDriver?.code || '';
  const poles       = qualifying.filter(r => r.results[0]?.code === champCode).length;
  const podiums     = rawRaces.reduce((n, r) =>
    n + (r.Results || []).filter(res =>
      parseInt(res.position) <= 3 && res.Driver?.code === champCode
    ).length, 0);
  const fastestLaps = rawRaces.reduce((n, r) => {
    const fl = (r.Results || []).find(res => res.FastestLap?.rank === '1');
    return n + (fl?.Driver?.code === champCode ? 1 : 0);
  }, 0);

  const seasonData = {
    year,
    champion:    champDriver ? `${champDriver.givenName} ${champDriver.familyName}` : '—',
    champCode,
    champTeam:   champTeam?.name || '—',
    champNat:    champDriver?.nationality || '—',
    champWins:   parseInt(champion?.wins || 0),
    champPoints: parseFloat(champion?.points || 0),
    poles,
    podiums,
    fastestLaps,
    totalRaces:  races.length,
    races,
    constructors,
    drivers,
    qualifying,
  };

  seasonCache[year]     = seasonData;
  seasonCacheTime[year] = Date.now();   // FIX [2]: stamp the cache time
  return seasonData;
}

/* ─── Derived data helpers ───────────────────────────────────────── */
function buildWinShare(races) {
  const map = {};
  races.forEach(r => {
    if (r.winner === '—') return;
    if (!map[r.winner]) map[r.winner] = { wins: 0, team: r.team };
    map[r.winner].wins++;
  });
  return Object.entries(map)
    .map(([name, d]) => ({ name, wins: d.wins, team: d.team }))
    .sort((a, b) => b.wins - a.wins);
}

function buildPointsProgression(data, topN = 5) {
  const topDrivers  = data.drivers.slice(0, topN);
  const sortedRaces = [...data.races].sort((a, b) => a.round - b.round);

  const series = topDrivers.map(driver => {
    let cumulative = 0;
    const points = [0];
    sortedRaces.forEach(race => {
      const result = race.allResults.find(r =>
        r.code === driver.code || r.name === driver.name
      );
      cumulative += result ? getPoints(result.pos, data.year) : 0;
      points.push(cumulative);
    });
    return {
      name:    driver.name,
      surname: driver.name.split(' ').pop(),
      team:    driver.team,
      code:    driver.code,
      points,
    };
  });

  const labels = ['', ...sortedRaces.map(r => `R${r.round}`)];
  return { series, labels };
}

/* ─── Chart helpers ──────────────────────────────────────────────── */
function isDark() {
  return document.documentElement.classList.contains('dark');
}
function chartGridColor()  { return isDark() ? 'rgba(255,255,255,0.05)' : 'rgba(0,0,0,0.05)'; }
function chartTickColor()  { return isDark() ? '#444' : '#ccc'; }
function tooltipOptions()  {
  return {
    backgroundColor: isDark() ? '#1c1c1c' : '#ffffff',
    borderColor:     isDark() ? 'rgba(255,255,255,0.1)' : 'rgba(0,0,0,0.08)',
    borderWidth:     1,
    titleColor:      isDark() ? '#666' : '#999',
    bodyColor:       isDark() ? '#aaa' : '#555',
    padding:         10,
  };
}

function setChartDefaults() {
  if (typeof Chart === 'undefined') return;
  Chart.defaults.color       = isDark() ? '#555' : '#aaa';
  Chart.defaults.borderColor = chartGridColor();
  Chart.defaults.font.family = "'JetBrains Mono', monospace";
  Chart.defaults.font.size   = 10;
}

function destroyCharts() {
  Object.values(chartInstances).forEach(c => { try { c.destroy(); } catch (_) {} });
  chartInstances = {};
}

/* ─── Chart builders ─────────────────────────────────────────────── */
function buildProgressionChart(canvasId, data) {
  const ctx = document.getElementById(canvasId);
  if (!ctx) return;

  const { series, labels } = buildPointsProgression(data, 5);
  const grid  = chartGridColor();
  const ticks = chartTickColor();

  chartInstances.progression = new Chart(ctx, {
    type: 'line',
    data: {
      labels,
      datasets: series.map(s => ({
        label:            s.surname,
        data:             s.points,
        borderColor:      teamColor(s.team),
        backgroundColor:  'transparent',
        borderWidth:      s.name === data.champion ? 2.5 : 1,
        pointRadius:      s.name === data.champion ? 3 : 0,
        pointHoverRadius: 5,
        tension:          0.35,
      })),
    },
    options: {
      responsive:          true,
      maintainAspectRatio: false,
      interaction: { mode: 'index', intersect: false },
      plugins: {
        legend: {
          display:  true,
          position: 'bottom',
          labels: { boxWidth: 8, padding: 16, color: chartTickColor(), usePointStyle: true, pointStyleWidth: 8 },
        },
        tooltip: {
          ...tooltipOptions(),
          callbacks: { label: c => `  ${c.dataset.label}: ${c.raw} pts` },
        },
      },
      scales: {
        x: { grid: { color: grid }, ticks: { color: ticks, maxTicksLimit: 12 } },
        y: { grid: { color: grid }, ticks: { color: ticks }, beginAtZero: true },
      },
    },
  });
}

function buildWinsBarChart(canvasId, data) {
  const ctx = document.getElementById(canvasId);
  if (!ctx) return;

  const ws    = buildWinShare(data.races).slice(0, 10);
  const grid  = chartGridColor();
  const ticks = chartTickColor();

  chartInstances.wins = new Chart(ctx, {
    type: 'bar',
    data: {
      labels: ws.map(w => w.name.split(' ').pop()),
      datasets: [{
        data:            ws.map(w => w.wins),
        backgroundColor: ws.map(w => teamColor(w.team) + (w.name === data.champion ? 'dd' : '44')),
        borderColor:     ws.map(w => teamColor(w.team)),
        borderWidth:     1,
        borderRadius:    3,
      }],
    },
    options: {
      indexAxis:           'y',
      responsive:          true,
      maintainAspectRatio: false,
      plugins: {
        legend: { display: false },
        tooltip: {
          ...tooltipOptions(),
          callbacks: { label: c => `  ${c.raw} wins` },
        },
      },
      scales: {
        x: { grid: { color: grid }, ticks: { color: ticks, precision: 0 } },
        y: { grid: { display: false }, ticks: { color: isDark() ? '#888' : '#888', font: { size: 11 } } },
      },
    },
  });
}

function buildConstructorDonut(canvasId, data) {
  const ctx = document.getElementById(canvasId);
  if (!ctx) return;

  const top6 = data.constructors.slice(0, 6);

  chartInstances.donut = new Chart(ctx, {
    type: 'doughnut',
    data: {
      labels: top6.map(c => c.team.split(' ').pop()),
      datasets: [{
        data:             top6.map(c => c.points),
        backgroundColor:  top6.map(c => teamColor(c.team) + 'bb'),
        borderColor:      top6.map(c => teamColor(c.team)),
        borderWidth:      1.5,
        hoverBorderWidth: 2.5,
      }],
    },
    options: {
      responsive:          true,
      maintainAspectRatio: false,
      cutout:              '70%',
      plugins: {
        legend: {
          display:  true,
          position: 'bottom',
          labels: { boxWidth: 8, padding: 14, color: chartTickColor(), usePointStyle: true, pointStyleWidth: 8 },
        },
        tooltip: {
          ...tooltipOptions(),
          callbacks: { label: c => `  ${c.label}: ${c.raw} pts` },
        },
      },
    },
  });
}

function buildGridScatterChart(canvasId, data) {
  const ctx = document.getElementById(canvasId);
  if (!ctx) return;

  const grid        = chartGridColor();
  const ticks       = chartTickColor();
  const fieldPoints = [], champPoints = [], dnfPoints = [];

  data.races.forEach(race => {
    race.allResults.forEach(res => {
      if (!res.grid || res.grid === 0) return;
      const pt = { x: res.grid, y: res.pos };
      if (res.pos >= 19)                    dnfPoints.push(pt);
      else if (res.code === data.champCode) champPoints.push(pt);
      else                                  fieldPoints.push(pt);
    });
  });

  chartInstances.scatter = new Chart(ctx, {
    type: 'scatter',
    data: {
      datasets: [
        {
          label:           'Field',
          data:            fieldPoints,
          backgroundColor: isDark() ? 'rgba(255,255,255,0.08)' : 'rgba(0,0,0,0.08)',
          pointRadius: 3, pointHoverRadius: 5,
        },
        {
          label:           'DNF',
          data:            dnfPoints,
          backgroundColor: 'rgba(200,0,0,0.2)',
          pointRadius: 3, pointHoverRadius: 5,
        },
        {
          label:           data.champCode || 'Champion',
          data:            champPoints,
          backgroundColor: teamColor(data.champTeam) + 'cc',
          borderColor:     teamColor(data.champTeam),
          borderWidth: 1, pointRadius: 5, pointHoverRadius: 7,
        },
      ],
    },
    options: {
      responsive:          true,
      maintainAspectRatio: false,
      plugins: {
        legend: {
          display:  true,
          position: 'bottom',
          labels: { boxWidth: 8, padding: 14, color: chartTickColor(), usePointStyle: true, pointStyleWidth: 8 },
        },
        tooltip: {
          ...tooltipOptions(),
          callbacks: { label: c => `  Grid ${c.raw.x} → Finish P${c.raw.y}` },
        },
      },
      scales: {
        x: {
          title: { display: true, text: 'Grid', color: ticks, font: { size: 9 } },
          grid: { color: grid }, ticks: { color: ticks, precision: 0 }, min: 1,
        },
        y: {
          title: { display: true, text: 'Finish', color: ticks, font: { size: 9 } },
          grid: { color: grid }, ticks: { color: ticks, precision: 0 }, reverse: true, min: 1,
        },
      },
    },
  });
}

function buildGainLossChart(canvasId, data) {
  const ctx = document.getElementById(canvasId);
  if (!ctx) return;

  const sorted   = [...data.races].sort((a, b) => a.round - b.round);
  const labels   = [];
  const values   = [];
  const champCol = teamColor(data.champTeam);
  const grid     = chartGridColor();
  const ticks    = chartTickColor();

  sorted.forEach(race => {
    const result = race.allResults.find(r => r.code === data.champCode);
    if (!result || !result.grid || result.grid === 0) return;
    labels.push(`R${race.round}`);
    values.push(result.grid - result.pos);
  });

  chartInstances.gainloss = new Chart(ctx, {
    type: 'bar',
    data: {
      labels,
      datasets: [{
        data:            values,
        backgroundColor: values.map(v => v >= 0 ? champCol + '99' : 'rgba(200,0,0,0.2)'),
        borderColor:     values.map(v => v >= 0 ? champCol + 'cc' : 'rgba(200,0,0,0.5)'),
        borderWidth:     0,
        borderRadius:    3,
      }],
    },
    options: {
      responsive:          true,
      maintainAspectRatio: false,
      plugins: {
        legend: { display: false },
        tooltip: {
          ...tooltipOptions(),
          callbacks: { label: c => c.raw >= 0 ? `  +${c.raw} gained` : `  ${c.raw} lost` },
        },
      },
      scales: {
        x: { grid: { display: false }, ticks: { color: ticks, maxTicksLimit: 14 } },
        y: { grid: { color: grid }, ticks: { color: ticks, precision: 0 } },
      },
    },
  });
}

/* ─── Lap time box plot (used inside race drill-down) ────────────── */
function buildLapBoxPlotChart(canvasId, laps, numToCode, raceResults) {
  const ctx = document.getElementById(canvasId);
  if (!ctx) return;

  const top8  = raceResults.slice(0, 8);
  const grid  = chartGridColor();
  const ticks = chartTickColor();

  // Group lap durations by driver code, skip lap 1 + outliers
  const byCode = {};
  laps.forEach(lap => {
    const code = numToCode[lap.driver_number];
    if (!code || !lap.lap_duration || lap.lap_duration <= 0 || lap.lap_number === 1) return;
    if (!byCode[code]) byCode[code] = [];
    byCode[code].push(lap.lap_duration);
  });

  // Strip pit-stop laps (> 1.3× per-driver median)
  Object.keys(byCode).forEach(code => {
    const arr = [...byCode[code]].sort((a, b) => a - b);
    const med = arr[Math.floor(arr.length * 0.5)] || 999;
    byCode[code] = arr.filter(t => t < med * 1.3);
  });

  const labels = [], iqrData = [], medData = [], colors = [];

  top8.forEach(res => {
    const times = byCode[res.code] || [];
    if (times.length < 3) return;
    const q = computeQuartiles(times);
    labels.push(res.code || `P${res.pos}`);
    iqrData.push([q.q1, q.q3]);
    medData.push(q.med);
    colors.push(teamColor(res.team));
  });

  if (chartInstances[`lapbox_${canvasId}`]) {
    try { chartInstances[`lapbox_${canvasId}`].destroy(); } catch (_) {}
  }

  chartInstances[`lapbox_${canvasId}`] = new Chart(ctx, {
    type: 'bar',
    data: {
      labels,
      datasets: [
        {
          // IQR box: Q1 → Q3 as floating bar
          label:           'IQR (Q1–Q3)',
          type:            'bar',
          data:            iqrData,
          backgroundColor: colors.map(c => c + '44'),
          borderColor:     colors,
          borderWidth:     1.5,
          borderRadius:    3,
          barPercentage:   0.5,
        },
        {
          // Median as a floating point (line type, showLine false)
          label:                'Median',
          type:                 'line',
          data:                 medData,
          showLine:             false,
          pointBackgroundColor: colors,
          pointBorderColor:     colors,
          pointRadius:          5,
          pointHoverRadius:     7,
        },
      ],
    },
    options: {
      responsive:          true,
      maintainAspectRatio: false,
      plugins: {
        legend: { display: false },
        tooltip: {
          ...tooltipOptions(),
          callbacks: {
            label: c => {
              if (c.datasetIndex === 0) {
                const [q1, q3] = c.raw;
                return `  Q1 ${q1.toFixed(2)}s  ·  Q3 ${q3.toFixed(2)}s`;
              }
              return `  Median ${c.raw.toFixed(2)}s`;
            },
          },
        },
      },
      scales: {
        x: { grid: { display: false }, ticks: { color: ticks } },
        y: {
          grid:  { color: grid },
          ticks: { color: ticks, callback: v => v.toFixed(0) + 's' },
          title: { display: true, text: 'Lap time (s)', color: ticks, font: { size: 9 } },
        },
      },
    },
  });
}

/* ─── Teammate head-to-head diverging bar chart ──────────────────── */
// FIX [16]: removed unused d1Qual / d2Qual qualifying H2H variables
function buildTeammateComparisonData(data) {
  const teamMap = {};
  data.drivers.forEach(d => {
    if (!teamMap[d.team]) teamMap[d.team] = [];
    teamMap[d.team].push(d);
  });

  return Object.entries(teamMap)
    .filter(([, drivers]) => drivers.length >= 2)
    .map(([team, drivers]) => {
      const [d1, d2] = drivers.slice(0, 2);

      // Race H2H — both must have classified finish (pos < 19)
      let d1Race = 0, d2Race = 0;
      data.races.forEach(race => {
        const r1 = race.allResults.find(r => r.code === d1.code || r.name === d1.name);
        const r2 = race.allResults.find(r => r.code === d2.code || r.name === d2.name);
        if (r1 && r2 && r1.pos < 19 && r2.pos < 19) {
          r1.pos < r2.pos ? d1Race++ : d2Race++;
        }
      });

      return { team, d1, d2, d1Race, d2Race };
    })
    .sort((a, b) =>
      (b.d1.points + b.d2.points) - (a.d1.points + a.d2.points)
    );
}

function buildTeammateComparisonChart(canvasId, data) {
  const ctx = document.getElementById(canvasId);
  if (!ctx) return;

  const pairs = buildTeammateComparisonData(data).slice(0, 6);
  const grid  = chartGridColor();
  const ticks = chartTickColor();

  chartInstances.teammate = new Chart(ctx, {
    type: 'bar',
    data: {
      labels: pairs.map(p => p.team.replace('F1 Team', '').replace(' Racing', '').trim()),
      datasets: [
        {
          // Driver 1 bars extend RIGHT (positive)
          label:           'Driver 1',
          data:            pairs.map(p => p.d1Race),
          backgroundColor: pairs.map(p => teamColor(p.team) + 'cc'),
          borderColor:     pairs.map(p => teamColor(p.team)),
          borderWidth:     1,
          borderRadius:    3,
          stack:           'h2h',
        },
        {
          // Driver 2 bars extend LEFT (negative)
          label:           'Driver 2',
          data:            pairs.map(p => -p.d2Race),
          backgroundColor: pairs.map(p => teamColor(p.team) + '44'),
          borderColor:     pairs.map(p => teamColor(p.team)),
          borderWidth:     1,
          borderRadius:    3,
          stack:           'h2h',
        },
      ],
    },
    options: {
      indexAxis:           'y',
      responsive:          true,
      maintainAspectRatio: false,
      plugins: {
        legend: { display: false },
        tooltip: {
          ...tooltipOptions(),
          callbacks: {
            label: c => {
              const pair   = pairs[c.dataIndex];
              const wins   = Math.abs(c.raw);
              const driver = c.datasetIndex === 0 ? pair.d1 : pair.d2;
              return `  ${driver.code || driver.name.split(' ').pop()}: ${wins} races ahead`;
            },
          },
        },
      },
      scales: {
        x: {
          stacked: true,
          grid:    { color: grid },
          ticks:   { color: ticks, callback: v => Math.abs(v) },
        },
        y: {
          stacked: true,
          grid:    { display: false },
          ticks:   { color: ticks, font: { size: 11 } },
        },
      },
    },
  });
}

/* ─── Render charts section ──────────────────────────────────────── */
function renderCharts(data) {
  const el = document.getElementById('charts-section');
  if (!el) return;

  const gen     = ++renderGeneration;
  const surname = data.champion.split(' ').pop();

  el.innerHTML = `
    <p class="eyebrow" style="margin-bottom:8px">Season Analytics</p>
    <h2 class="charts-heading">${data.year} <em>by the numbers</em></h2>
    <p class="charts-sub">TOP 5 DRIVERS · ALL ${data.totalRaces} ROUNDS · LIVE DATA</p>
    <div class="charts-grid">
      <div class="chart-card-full">
        <p class="chart-eyebrow">Championship Battle</p>
        <p class="chart-title">Cumulative points — <em>top 5 drivers</em></p>
        <div class="chart-wrap-tall"><canvas id="ch-prog"></canvas></div>
      </div>
      <div class="chart-card">
        <p class="chart-eyebrow">Race Wins</p>
        <p class="chart-title">Wins by driver — <em>champion highlighted</em></p>
        <div class="chart-wrap"><canvas id="ch-wins"></canvas></div>
      </div>
      <div class="chart-card">
        <p class="chart-eyebrow">Constructor Points</p>
        <p class="chart-title">Championship share — <em>top 6 teams</em></p>
        <div class="chart-wrap"><canvas id="ch-donut"></canvas></div>
      </div>
      <div class="chart-card">
        <p class="chart-eyebrow">Start vs Finish</p>
        <p class="chart-title">Grid position vs result — <em>all drivers</em></p>
        <div class="chart-wrap"><canvas id="ch-scatter"></canvas></div>
      </div>
      <div class="chart-card">
        <p class="chart-eyebrow">Race by Race</p>
        <p class="chart-title">Positions gained / lost — <em>${surname}</em></p>
        <div class="chart-wrap"><canvas id="ch-gl"></canvas></div>
      </div>
      <div class="chart-card-full">
        <p class="chart-eyebrow">Teammate Battle</p>
        <p class="chart-title">Head-to-head race results — <em>Driver 1 (solid) vs Driver 2 (faded)</em></p>
        <div class="chart-wrap-tall"><canvas id="ch-teammate"></canvas></div>
      </div>
    </div>
  `;

  destroyCharts();
  requestAnimationFrame(() => {
    if (gen !== renderGeneration) return;
    buildProgressionChart       ('ch-prog',     data);
    buildWinsBarChart           ('ch-wins',     data);
    buildConstructorDonut       ('ch-donut',    data);
    buildGridScatterChart       ('ch-scatter',  data);
    buildGainLossChart          ('ch-gl',       data);
    buildTeammateComparisonChart('ch-teammate', data);
  });
}

/* ─── OpenF1 pit data (non-blocking) ────────────────────────────── */
async function loadPitData(year, el) {
  try {
    const sessions = await openf1Fetch(`sessions?year=${year}&session_name=Race`);
    if (!sessions.length) throw new Error('no sessions');

    const lastSession = sessions[sessions.length - 1];
    const pits        = await openf1Fetch(`pit?session_key=${lastSession.session_key}`);
    if (!pits.length) throw new Error('no pit data');

    const times = pits.map(p => p.pit_duration).filter(t => t && t > 0 && t < 60);
    const avg   = times.length ? (times.reduce((s, t) => s + t, 0) / times.length).toFixed(2) : '—';
    const min   = times.length ? Math.min(...times).toFixed(2) : '—';

    const stopsByDriver = {};
    pits.forEach(p => {
      stopsByDriver[p.driver_number] = (stopsByDriver[p.driver_number] || 0) + 1;
    });
    const maxStops = Math.max(...Object.values(stopsByDriver));

    el.innerHTML = `
      <p class="eyebrow" style="margin-bottom:6px">Pit Stops</p>
      <p class="pit-source">OpenF1 · ${lastSession.circuit_short_name || ''} · last race</p>
      ${[
        ['Total stops',    pits.length],
        ['Avg duration',   avg + 's'],
        ['Fastest stop',   min + 's'],
        ['Max per driver', maxStops],
      ].map(([l, v]) => `
        <div class="stat-row">
          <span class="stat-label">${l}</span>
          <span class="stat-val">${v}</span>
        </div>
      `).join('')}
    `;
  } catch (err) {
    // FIX [7]: log instead of silently swallowing
    console.warn('OpenF1 pit data unavailable:', err.message);
    el.innerHTML = `
      <p class="eyebrow" style="margin-bottom:6px">Pit Stops</p>
      <p class="pit-source">OpenF1 · no data for ${year}</p>
    `;
  }
}

/* ─── Animations ─────────────────────────────────────────────────── */
// FIX [9]: guard against 0 / falsy target — prevents NaN output
function animateCount(el, target, duration) {
  if (!target) { el.textContent = 0; return; }
  const isFloat = !Number.isInteger(target);
  const start   = performance.now();
  const run = now => {
    const t    = Math.min((now - start) / duration, 1);
    const ease = 1 - Math.pow(1 - t, 3);
    el.textContent = isFloat ? (target * ease).toFixed(1) : Math.round(target * ease);
    if (t < 1) requestAnimationFrame(run);
  };
  requestAnimationFrame(run);
}

function typewriteChampion(nameEl, cursorEl, fullName, speed = 42) {
  if (typewriterTimer) clearInterval(typewriterTimer);
  nameEl.innerHTML       = '';
  cursorEl.style.opacity = '1';

  const spaceIdx  = fullName.lastIndexOf(' ');
  const firstName = fullName.slice(0, spaceIdx);
  const surname   = fullName.slice(spaceIdx + 1);
  let i = 0;

  setTimeout(() => {
    typewriterTimer = setInterval(() => {
      i++;
      if (i <= spaceIdx) {
        nameEl.innerHTML = fullName.slice(0, i);
      } else {
        nameEl.innerHTML = `${firstName} <em>${surname.slice(0, i - spaceIdx - 1)}</em>`;
      }
      if (i >= fullName.length) {
        clearInterval(typewriterTimer);
        setTimeout(() => { cursorEl.style.opacity = '0'; }, 600);
      }
    }, speed);
  }, 80);
}

/* ─── Loading / Error states ─────────────────────────────────────── */
function showLoading(msg = 'FETCHING RACE DATA', sub = '') {
  document.getElementById('content').innerHTML = `
    <div class="loading-wrap fade-up">
      <div class="loading-spinner"></div>
      <p class="loading-text">${msg}</p>
      ${sub ? `<p class="loading-sub">${sub}</p>` : ''}
    </div>
  `;
}

function showError(err) {
  const message = typeof err === 'string' ? err : err?.message || 'Unknown error';
  document.getElementById('content').innerHTML = `
    <div class="error-wrap fade-up">
      <p class="error-eyebrow">Error</p>
      <p class="error-msg">${message}<br><br>Try another season or check your connection.</p>
    </div>
  `;
}

/* ─── Tab content builders ───────────────────────────────────────── */
function renderRacesTab(data) {
  return `
    <div class="row-header">
      <p class="eyebrow" style="margin-bottom:0">Race Results</p>
      <span class="row-count">${data.totalRaces} rounds</span>
    </div>
    ${data.races.map((race, i) => `
      <div class="race-row${expandedRound === race.round ? ' expanded' : ''}"
           data-round="${race.round}"
           style="animation-delay:${i * 25}ms"
           role="button" tabindex="0"
           aria-expanded="${expandedRound === race.round}">
        <span class="race-num">${String(race.round).padStart(2, '0')}</span>
        <div>
          <p class="race-name">${race.name}</p>
          <div class="race-winner">
            <span class="team-dot" style="background:${teamColor(race.team)}"></span>
            ${race.winner}
          </div>
        </div>
        <span class="race-pole-note">${race.grid === 1 ? 'P1 START' : ''}</span>
        <span class="race-date">${race.date}</span>
        <span class="race-expand-icon" aria-hidden="true">
          ${expandedRound === race.round ? '▲' : '▼'}
        </span>
      </div>
    `).join('')}
  `;
}

function renderQualifyingTab(data) {
  if (!data.qualifying.length) {
    return `<p style="color:var(--text-4);font-size:13px;padding:24px 0">No qualifying data available for this season.</p>`;
  }
  return `
    <div class="row-header">
      <p class="eyebrow" style="margin-bottom:0">Pole Positions</p>
      <span class="row-count">${data.qualifying.length} rounds</span>
    </div>
    ${data.qualifying.map((race, i) => {
      const pole = race.results[0];
      if (!pole) return '';
      return `
        <div class="qual-row" style="animation-delay:${i * 25}ms">
          <span class="race-num">${String(race.round).padStart(2, '0')}</span>
          <div>
            <p class="race-name">${race.name}</p>
            <div class="race-winner">
              <span class="team-dot" style="background:${teamColor(pole.team)}"></span>
              ${pole.name}
            </div>
          </div>
          <span class="qual-time pole">${pole.q3 || pole.q2 || pole.q1 || '—'}</span>
        </div>
      `;
    }).join('')}
  `;
}

function renderDriversTab(data) {
  return `
    <div class="row-header">
      <p class="eyebrow" style="margin-bottom:0">Driver Championship</p>
      <span class="row-count">final standings</span>
    </div>
    <div style="display:grid;grid-template-columns:28px 1fr 48px 64px;gap:14px;padding:8px 0;border-bottom:1px solid var(--border);margin-bottom:2px">
      ${['#', 'Driver', 'W', 'Pts'].map((h, i) => `
        <span style="font-family:var(--font-mono);font-size:9px;color:var(--text-4);letter-spacing:1.5px;${i > 1 ? 'text-align:right' : ''}">${h}</span>
      `).join('')}
    </div>
    ${data.drivers.map((d, i) => `
      <div class="driver-row" style="animation-delay:${i * 22}ms">
        <span class="driver-pos">${String(d.pos).padStart(2, '0')}</span>
        <div>
          <p class="driver-name">${d.name}</p>
          <div class="driver-team">
            <span class="team-dot" style="background:${teamColor(d.team)}"></span>
            ${d.team}
          </div>
        </div>
        <span class="driver-wins">${d.wins}</span>
        <span class="driver-pts">${d.points}</span>
      </div>
    `).join('')}
  `;
}

function getTabContent(data) {
  if (currentTab === 'races')      return renderRacesTab(data);
  if (currentTab === 'qualifying') return renderQualifyingTab(data);
  if (currentTab === 'drivers')    return renderDriversTab(data);
  return '';
}

/* ─── Right column sub-renderers ─────────────────────────────────── */
// FIX [13]: split renderRightColumn into focused helpers

function renderConstructorList(data) {
  const maxPts = Math.max(...data.constructors.map(c => c.points), 1);
  return `
    <p class="eyebrow">Constructors</p>
    <div class="constructor-list">
      ${data.constructors.map((c, i) => `
        <div class="fade-up" style="animation-delay:${i * 55 + 100}ms">
          <div class="constructor-header">
            <div class="constructor-left">
              <span class="constructor-pos">${String(c.pos).padStart(2, '0')}</span>
              <span class="constructor-name">${c.team}</span>
            </div>
            <span class="constructor-pts">${c.points}</span>
          </div>
          <div class="constructor-track">
            <div class="constructor-fill bar-anim"
                 style="width:${Math.round((c.points / maxPts) * 100)}%;
                        background:${teamColor(c.team)};
                        animation-delay:${i * 55 + 380}ms">
            </div>
          </div>
        </div>
      `).join('')}
    </div>
  `;
}

function renderWinShare(data) {
  const ws      = buildWinShare(data.races);
  const maxWins = ws[0]?.wins || 1;
  return `
    <hr class="right-divider">
    <p class="eyebrow" style="margin-bottom:14px">Win Share</p>
    ${ws.slice(0, 8).map((w, i) => `
      <div class="win-row fade-up" style="animation-delay:${i * 48 + 160}ms">
        <span class="win-name">${w.name.split(' ').pop()}</span>
        <div class="win-track">
          <div class="win-fill bar-anim"
               style="width:${Math.round((w.wins / maxWins) * 100)}%;
                      background:${teamColor(w.team)};
                      animation-delay:${i * 48 + 440}ms">
          </div>
        </div>
        <span class="win-num">${w.wins}</span>
      </div>
    `).join('')}
  `;
}

function renderSeasonStats(data) {
  return `
    <hr class="right-divider">
    <p class="eyebrow" style="margin-bottom:14px">Season Stats</p>
    ${[
      ['Total rounds',  data.totalRaces],
      ['Fastest laps',  data.fastestLaps],
      ['Win rate',      Math.round((data.champWins  / data.totalRaces) * 100) + '%'],
      ['Podium rate',   Math.round((data.podiums    / data.totalRaces) * 100) + '%'],
    ].map(([label, val]) => `
      <div class="stat-row">
        <span class="stat-label">${label}</span>
        <span class="stat-val">${val}</span>
      </div>
    `).join('')}
  `;
}

function renderRightColumn(data) {
  return `
    ${renderConstructorList(data)}
    ${renderWinShare(data)}
    <hr class="right-divider">
    <div id="pit-block">
      <p class="eyebrow" style="margin-bottom:6px">Pit Stops</p>
      <p class="pit-loading">Fetching OpenF1 data…</p>
    </div>
    ${renderSeasonStats(data)}
  `;
}

/* ─── Race drill-down ────────────────────────────────────────────── */
function renderDrilldown(round, data) {
  const race     = data.races.find(r => r.round === round);
  const qualRace = data.qualifying.find(r => r.round === round);

  const qualRows = qualRace?.results.length
    ? qualRace.results.slice(0, 10).map(q => `
        <div class="drilldown-row">
          <span class="drilldown-pos">${String(q.pos).padStart(2, '0')}</span>
          <span class="drilldown-name">${q.name.split(' ').pop()}</span>
          <span class="drilldown-team-dot" style="background:${teamColor(q.team)}"></span>
          <span class="drilldown-time">${q.q3 || q.q2 || q.q1 || '—'}</span>
        </div>
      `).join('')
    : '<p class="drilldown-empty">No qualifying data</p>';

  const raceRows = race.allResults.slice(0, 10).map(res => `
    <div class="drilldown-row">
      <span class="drilldown-pos">${String(res.pos).padStart(2, '0')}</span>
      <span class="drilldown-name">${res.name.split(' ').pop()}</span>
      <span class="drilldown-team-dot" style="background:${teamColor(res.team)}"></span>
      ${res.fastestLap ? '<span class="drilldown-fl">FL</span>' : '<span class="drilldown-fl-empty"></span>'}
    </div>
  `).join('');

  return `
    <div class="drilldown-inner">
      <div class="drilldown-col">
        <p class="drilldown-col-title">Qualifying</p>
        ${qualRows}
      </div>
      <div class="drilldown-divider"></div>
      <div class="drilldown-col drilldown-col-race">
        <p class="drilldown-col-title">Race — Top 10</p>
        ${raceRows}
        <div class="drilldown-lap-section">
          <p class="drilldown-col-title" style="margin-top:20px">Lap Time Distribution</p>
          <p class="drilldown-lap-loading">Loading OpenF1 data…</p>
          <div class="drilldown-lap-chart" style="display:none;height:220px">
            <canvas id="ch-lapbox-${round}"></canvas>
          </div>
        </div>
      </div>
    </div>
  `;
}

async function loadDrilldownLapChart(race, data) {
  const section   = document.querySelector(`#drilldown-${race.round} .drilldown-lap-section`);
  const loadingEl = section?.querySelector('.drilldown-lap-loading');
  const chartWrap = section?.querySelector('.drilldown-lap-chart');
  if (!section) return;

  const result = await fetchRaceLapTimes(data.year, race.round, race.date);

  if (!result || !result.laps.length) {
    if (loadingEl) loadingEl.textContent = 'Lap data unavailable for this race';
    return;
  }

  if (loadingEl) loadingEl.style.display = 'none';
  if (chartWrap) chartWrap.style.display = 'block';

  setChartDefaults();
  buildLapBoxPlotChart(
    `ch-lapbox-${race.round}`,
    result.laps,
    result.numToCode,
    race.allResults.slice(0, 8)
  );
}

function toggleRaceExpand(round, data) {
  const existing = document.getElementById(`drilldown-${round}`);

  // Collapse if already open
  if (existing) {
    existing.classList.add('drilldown-closing');
    setTimeout(() => existing.remove(), 220);
    document.querySelector(`.race-row[data-round="${round}"]`)?.classList.remove('expanded');
    expandedRound = null;
    return;
  }

  // Close any previously open panel
  if (expandedRound !== null) {
    const prev = document.getElementById(`drilldown-${expandedRound}`);
    if (prev) { prev.classList.add('drilldown-closing'); setTimeout(() => prev.remove(), 220); }
    document.querySelector(`.race-row[data-round="${expandedRound}"]`)?.classList.remove('expanded');
  }

  expandedRound = round;
  const rowEl = document.querySelector(`.race-row[data-round="${round}"]`);
  if (!rowEl) return;
  rowEl.classList.add('expanded');

  const panel = document.createElement('div');
  panel.id        = `drilldown-${round}`;
  panel.className = 'race-drilldown';
  panel.innerHTML = renderDrilldown(round, data);
  rowEl.insertAdjacentElement('afterend', panel);

  // Trigger open animation on next frame
  requestAnimationFrame(() => panel.classList.add('drilldown-open'));

  // Non-blocking: load lap chart
  const race = data.races.find(r => r.round === round);
  if (race) loadDrilldownLapChart(race, data);
}

// Wire click handlers on all race rows — called after any tab content render
function wireRaceRowClicks(data) {
  if (currentTab !== 'races') return;
  document.querySelectorAll('.race-row[data-round]').forEach(row => {
    row.addEventListener('click', () =>
      toggleRaceExpand(parseInt(row.dataset.round), data)
    );
  });
}

/* ─── Champion vs Runner-up comparison strip ─────────────────────── */
function renderChampVsRunnerUp(data) {
  if (data.drivers.length < 2) return '';

  const champ  = data.drivers[0];
  const runner = data.drivers[1];
  const cc     = teamColor(champ.team);
  const rc     = teamColor(runner.team);

  // Race H2H — both must have a classified finish
  let champAhead = 0, runnerAhead = 0;
  data.races.forEach(race => {
    const r1 = race.allResults.find(r => r.code === champ.code  || r.name === champ.name);
    const r2 = race.allResults.find(r => r.code === runner.code || r.name === runner.name);
    if (r1 && r2 && r1.pos < 19 && r2.pos < 19) {
      r1.pos < r2.pos ? champAhead++ : runnerAhead++;
    }
  });

  // Runner-up poles + podiums (champion values already in data)
  const runnerPoles   = data.qualifying.filter(r => r.results[0]?.code === runner.code).length;
  const runnerPodiums = data.races.reduce((n, r) =>
    n + (r.allResults || []).filter(res =>
      res.pos <= 3 && (res.code === runner.code || res.name === runner.name)
    ).length, 0);

  const stats = [
    { label: 'Points',   c: champ.points,  r: runner.points  },
    { label: 'Wins',     c: champ.wins,    r: runner.wins    },
    { label: 'Poles',    c: data.poles,    r: runnerPoles    },
    { label: 'Podiums',  c: data.podiums,  r: runnerPodiums  },
    { label: 'Race H2H', c: champAhead,    r: runnerAhead    },
  ];

  return `
    <div class="cvs-section fade-up">
      <p class="eyebrow" style="margin-bottom:20px">Head to Head — Champion vs Runner-up</p>

      <div class="cvs-header">
        <div class="cvs-driver">
          <span class="cvs-pos-badge" style="border-color:${cc};color:${cc}">P1</span>
          <div>
            <p class="cvs-name">${champ.name}</p>
            <div class="cvs-team-row">
              <span class="team-dot" style="background:${cc}"></span>
              <span class="cvs-team-name">${champ.team}</span>
            </div>
          </div>
        </div>

        <div class="cvs-vs">VS</div>

        <div class="cvs-driver cvs-driver-right">
          <div style="text-align:right">
            <p class="cvs-name">${runner.name}</p>
            <div class="cvs-team-row" style="justify-content:flex-end">
              <span class="cvs-team-name">${runner.team}</span>
              <span class="team-dot" style="background:${rc}"></span>
            </div>
          </div>
          <span class="cvs-pos-badge" style="border-color:${rc};color:${rc}">P2</span>
        </div>
      </div>

      <div class="cvs-stats">
        ${stats.map(s => {
          const total    = (s.c + s.r) || 1;
          const champPct = Math.round((s.c / total) * 100);
          const runPct   = 100 - champPct;
          return `
            <div class="cvs-stat-row">
              <span class="cvs-val cvs-val-left">${s.c}</span>
              <div class="cvs-center">
                <span class="cvs-label">${s.label}</span>
                <div class="cvs-bar-track">
                  <div class="cvs-bar-left  bar-anim" style="width:${champPct}%;background:${cc}"></div>
                  <div class="cvs-bar-right bar-anim" style="width:${runPct}%;background:${rc}"></div>
                </div>
              </div>
              <span class="cvs-val cvs-val-right">${s.r}</span>
            </div>
          `;
        }).join('')}
      </div>
    </div>
  `;
}

/* ─── Hero section ────────────────────────────────────────────────── */
function renderHero(data) {
  const champColor = teamColor(data.champTeam);
  return `
    <div class="hero">
      <div class="hero-year-ghost">${data.year}</div>
      <img src="image/${data.year}.svg" class="hero-car" alt="${data.year} F1 Car" />
      <p class="eyebrow">${data.year === THIS_YEAR ? 'Championship Leader' : 'World Champion'} — ${data.year}</p>
      <div class="hero-name-row">
        <span id="hero-name" class="hero-name"></span>
        <span id="hero-cursor" class="cursor-blink"></span>
      </div>
      <div class="hero-meta">
        <span class="hero-team-pill">
          <span class="hero-team-dot" style="background:${champColor}"></span>
          ${data.champTeam}
        </span>
        <span class="hero-nat">${data.champNat}</span>
      </div>
    </div>
  `;
}

/* ─── Metrics grid ────────────────────────────────────────────────── */
function renderMetricsGrid(data) {
  const metrics = [
    { label: 'Race Wins', id: 'mv-wins',  val: data.champWins,   max: data.totalRaces,  delay: 0   },
    { label: 'Pole Pos.', id: 'mv-poles', val: data.poles,       max: data.totalRaces,  delay: 80  },
    { label: 'Podiums',   id: 'mv-pods',  val: data.podiums,     max: data.totalRaces,  delay: 160 },
    { label: 'Points',    id: 'mv-pts',   val: data.champPoints, max: data.champPoints, delay: 240 },
  ];
  return { html: `
    <div class="metrics-grid">
      ${metrics.map(m => `
        <div class="metric-cell fade-up" style="animation-delay:${m.delay}ms">
          <p class="metric-label">${m.label}</p>
          <div id="${m.id}" class="metric-value">0</div>
          <div class="metric-track">
            <div class="metric-fill bar-anim"
                 style="width:${Math.round((m.val / m.max) * 100)}%;
                        animation-delay:${m.delay + 460}ms">
            </div>
          </div>
        </div>
      `).join('')}
    </div>
  `, metrics };
}

/* ─── Main render ────────────────────────────────────────────────── */
// FIX [13]: renderSeason delegates to focused sub-renderers
// FIX [4] & [5]: tabs use data-tab attribute; events wired via addEventListener
function renderSeason(data) {
  expandedRound = null; // reset drill-down on season change
  const { html: metricsHtml, metrics } = renderMetricsGrid(data);

  document.getElementById('content').innerHTML = `
    <div style="animation:fadeUp .5s ease forwards;opacity:0">
      ${renderHero(data)}
      ${metricsHtml}
      ${renderChampVsRunnerUp(data)}
      <div class="main-grid">
        <div>
          <div class="tabs">
            <button class="tab-btn${currentTab === 'races'      ? ' active' : ''}" data-tab="races">Races</button>
            <button class="tab-btn${currentTab === 'qualifying' ? ' active' : ''}" data-tab="qualifying">Qualifying</button>
            <button class="tab-btn${currentTab === 'drivers'    ? ' active' : ''}" data-tab="drivers">Drivers</button>
          </div>
          <div id="tab-content">${getTabContent(data)}</div>
        </div>
        <div>${renderRightColumn(data)}</div>
      </div>
      <div class="charts-section fade-up" id="charts-section" style="animation-delay:280ms"></div>
    </div>
  `;

  // Wire tab buttons
  document.querySelectorAll('.tab-btn').forEach(btn => {
    btn.addEventListener('click', () => switchTab(btn.dataset.tab));
  });

  // Wire race row clicks (keyboard too)
  wireRaceRowClicks(data);
  document.querySelectorAll('.race-row[data-round]').forEach(row => {
    row.addEventListener('keydown', e => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        toggleRaceExpand(parseInt(row.dataset.round), data);
      }
    });
  });

  // Typewriter + car animation + metric counters
  requestAnimationFrame(() => {
    const nameEl   = document.getElementById('hero-name');
    const cursorEl = document.getElementById('hero-cursor');
    if (nameEl && cursorEl) typewriteChampion(nameEl, cursorEl, data.champion);

    // Car stays hidden (display:none) until typewriter finishes
    const carDelay = 80 + (data.champion.length * 42) + 300;
    setTimeout(() => {
      const carEl = document.querySelector('.hero-car');
      if (carEl) {
        carEl.style.display = 'block';
        carEl.style.opacity = '0';
        requestAnimationFrame(() => {
          carEl.style.animation = 'carDriveIn 1s cubic-bezier(0.25, 0.46, 0.45, 0.94) forwards';
        });
      }
    }, carDelay);

    setTimeout(() => {
      metrics.forEach(m => {
        const el = document.getElementById(m.id);
        if (el) animateCount(el, m.val, 900 + m.delay);
      });
    }, 150);
  });

  const pitEl = document.getElementById('pit-block');
  if (pitEl) loadPitData(data.year, pitEl);

  setTimeout(() => renderCharts(data), 420);
}

/* ─── Tab switching ──────────────────────────────────────────────── */
function switchTab(tab) {
  currentTab    = tab;
  expandedRound = null; // close any open drill-down when switching tabs
  const data = seasonCache[currentSeason];
  if (!data) return;

  document.querySelectorAll('.tab-btn').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.tab === tab);
  });

  const tabEl = document.getElementById('tab-content');
  if (tabEl) {
    tabEl.style.cssText = 'opacity:0;transform:translateY(6px);transition:opacity .2s,transform .2s';
    setTimeout(() => {
      tabEl.innerHTML     = getTabContent(data);
      tabEl.style.cssText = 'opacity:1;transform:translateY(0);transition:opacity .2s,transform .2s';
      // Re-wire race row clicks every time the Races tab renders
      wireRaceRowClicks(data);
      document.querySelectorAll('.race-row[data-round]').forEach(row => {
        row.addEventListener('keydown', e => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            toggleRaceExpand(parseInt(row.dataset.round), data);
          }
        });
      });
    }, 180);
  }
}

/* ─── Season selection ───────────────────────────────────────────── */
async function selectSeason(year) {
  if (isLoading) return;
  currentSeason = year;
  currentTab    = 'races';
  buildSeasonBar();
  await fetchAndRender(year);
}

async function fetchAndRender(year) {
  // FIX [8]: cancel any in-flight fetch from a previous season selection
  if (activeFetchController) activeFetchController.abort();
  activeFetchController = new AbortController();
  const { signal } = activeFetchController;

  isLoading = true;
  setApiStatus('loading');
  showLoading('FETCHING RACE DATA', `JOLPICA F1 — ${year}`);

  try {
    const data = await loadSeason(year, signal);
    setApiStatus('live');
    renderSeason(data);

    // PERF [20]: pre-fetch adjacent seasons silently after render
    // so clicking prev/next year feels instant
    const adjacent = [year - 1, year + 1].filter(
      y => y >= 2000 && y <= THIS_YEAR && !seasonCache[y]
    );
    adjacent.forEach(y => {
      const ctrl = new AbortController();
      loadSeason(y, ctrl.signal).catch(() => {});
    });

  } catch (err) {
    if (err.name === 'AbortError') return; // FIX [8]: silently ignore cancelled requests
    console.error(err);
    setApiStatus('error');
    // FIX [15]: friendly message for CORS / network errors
    showError(isCorsError(err)
      ? 'Network error — make sure you\'re running via a local server, not file://'
      : err);
  } finally {
    isLoading = false;
    buildSeasonBar();
  }
}

/* ─── Season bar ─────────────────────────────────────────────────── */
function buildSeasonBar() {
  document.getElementById('season-bar').innerHTML = SEASONS.map(yr => `
    <button
      class="season-btn${yr === currentSeason ? ' active' : ''}"
      data-year="${yr}"
      aria-pressed="${yr === currentSeason}"
      ${isLoading ? 'disabled' : ''}
    >${yr}</button>
  `).join('');

  // FIX [5]: wire season buttons with addEventListener
  document.querySelectorAll('.season-btn').forEach(btn => {
    btn.addEventListener('click', () => selectSeason(parseInt(btn.dataset.year)));
  });
}

/* ─── API status indicator ───────────────────────────────────────── */
function setApiStatus(state) {
  const el = document.getElementById('api-status');
  if (!el) return;
  const states = {
    loading: ['○ loading', ''],
    live:    ['● live',    'live'],
    error:   ['● error',   'error'],
  };
  const [text, cls] = states[state] || states.loading;
  el.textContent = text;
  el.className   = `api-badge${cls ? ' ' + cls : ''}`;
}

/* ─── Theme ──────────────────────────────────────────────────────── */
function initTheme() {
  const saved       = localStorage.getItem('f1-theme');
  const prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
  if (saved === 'dark' || (!saved && prefersDark)) {
    document.documentElement.classList.add('dark');
  }
}

function toggleTheme() {
  const dark = document.documentElement.classList.toggle('dark');
  localStorage.setItem('f1-theme', dark ? 'dark' : 'light');
  setChartDefaults();
  const data = seasonCache[currentSeason];
  if (data) setTimeout(() => renderCharts(data), 50);
}

/* ─── Init ───────────────────────────────────────────────────────── */
initTheme();
setChartDefaults();

const _footerYear = document.getElementById('footer-year');
if (_footerYear) _footerYear.textContent = `© ${new Date().getFullYear()} Sudip Shrestha`;

const _themeToggle = document.getElementById('theme-toggle');
if (_themeToggle) _themeToggle.addEventListener('click', toggleTheme);

// FIX [1]: document.currentScript is null after script finishes parsing —
// check the DOM directly instead
const isStaticPage = !document.getElementById('season-bar');

if (!isStaticPage) {
  buildSeasonBar();
  fetchAndRender(currentSeason);
}
