/* ═══════════════════════════════════════════════════════════════════
   F1. Analytics — app.js
   Jolpica F1  →  current season (live data)
   Supabase    →  past seasons (2000–2024, fast & reliable)

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

   DATA SOURCE (v5):
   [21] Past seasons (< THIS_YEAR) fetched from Supabase — fast, no rate limits
   [22] Current season fetched from Jolpica API — always live

   DRILLDOWN (v6):
   [23] Replaced OpenF1 lap time box plot with synchronous Grid→Finish slope chart
        — works for all seasons back to 2000, zero new API calls
        — lines/dots coloured by team, delta text green/red for gained/lost

   RIGHT COLUMN (v7):
   [24] Replaced OpenF1 pit stop block with Season Records
        — derived entirely from existing season data, no API calls
        — most positions gained, win streak, most DNFs, most poles, 1-2 finish
        — removed openf1Fetch and loadPitData (dead code)

   BUG FIXES (v8):
   [25] Removed empty initTheme() function — theme init handled by inline script in HTML
   [26] Added onerror handler to hero-car img to suppress broken image icon
   [27] Default season changed to THIS_YEAR (live season) instead of THIS_YEAR - 1
   [28] Typewriter guard — handles champion names with no space gracefully
═══════════════════════════════════════════════════════════════════ */
'use strict';

/* ─── Supabase client ────────────────────────────────────────────── */
import { createClient } from 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js/+esm';

const SUPABASE_URL = 'https://iavnlezplthsznnetjcv.supabase.co';
const SUPABASE_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Imlhdm5sZXpwbHRoc3pubmV0amN2Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzM1MjUxNTYsImV4cCI6MjA4OTEwMTE1Nn0.KRbQ8V77w5PBHAa3k1PYSBMHDAg1yjXza1np3BwIBLI';
const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

/* ─── Config ─────────────────────────────────────────────────────── */
const JOLPICA   = 'https://api.jolpi.ca/ergast/f1';
const CACHE_TTL = 5 * 60 * 1000;
const THIS_YEAR = new Date().getFullYear();
const SEASONS   = Array.from({ length: THIS_YEAR - 1999 }, (_, i) => THIS_YEAR - i);

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
  modern:  [25, 18, 15, 12, 10, 8, 6, 4, 2, 1],
  mid:     [10,  8,  6,  5,  4, 3, 2, 1],
  classic: [10,  6,  4,  3,  2, 1],
};

function getPoints(position, year) {
  const sys = year >= 2010 ? PTS_SYSTEMS.modern
            : year >= 2003 ? PTS_SYSTEMS.mid
            : PTS_SYSTEMS.classic;
  return sys[position - 1] || 0;
}

/* ─── State ──────────────────────────────────────────────────────── */
let currentSeason         = THIS_YEAR; // [27] Default to live season
let currentTab            = 'races';
let seasonCache           = {};
let seasonCacheTime       = {};
let chartInstances        = {};
let isLoading             = false;
let typewriterTimer       = null;
let renderGeneration      = 0;
let activeFetchController = null;
let expandedRound         = null;

/* ─── Fetch helpers ──────────────────────────────────────────────── */
function isCorsError(err) {
  return err instanceof TypeError && (
    err.message === 'Failed to fetch' ||
    err.message.includes('NetworkError') ||
    err.message.includes('CORS')
  );
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

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

async function jolpicaFetchBatched(paths, signal, onProgress) {
  const BATCH = 5;
  const results = [];
  for (let i = 0; i < paths.length; i += BATCH) {
    if (i > 0) await sleep(150);
    const batch = paths.slice(i, i + BATCH);
    const pages = await Promise.all(batch.map(p => jolpicaFetch(p, signal)));
    results.push(...pages);
    if (onProgress) onProgress(results.length, paths.length);
  }
  return results;
}

/* ─── Paginated race results fetch ───────────────────────────────── */
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

/* ─── Paginated qualifying fetch ────────────────────────────────── */
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

/* ─── Supabase season loader ─────────────────────────────────────── */
async function loadSeasonFromDB(year) {
  const [
    { data: racesData },
    { data: resultsData },
    { data: qualData },
    { data: driversData },
    { data: constructorsData },
  ] = await Promise.all([
    supabase.from('races').select('*').eq('year', year).order('round'),
    supabase.from('race_results').select('*').eq('year', year).order('round').order('pos'),
    supabase.from('qualifying_results').select('*').eq('year', year).order('round').order('pos'),
    supabase.from('driver_standings').select('*').eq('year', year).order('pos'),
    supabase.from('constructor_standings').select('*').eq('year', year).order('pos'),
  ]);

  const resultsByRound = {};
  (resultsData || []).forEach(r => {
    if (!resultsByRound[r.round]) resultsByRound[r.round] = [];
    resultsByRound[r.round].push(r);
  });

  const qualByRound = {};
  (qualData || []).forEach(r => {
    if (!qualByRound[r.round]) qualByRound[r.round] = [];
    qualByRound[r.round].push(r);
  });

  const races = (racesData || []).map(race => ({
    round:   race.round,
    name:    race.name,
    circuit: race.circuit,
    country: race.country,
    date:    race.date,
    winner:  race.winner,
    team:    race.team,
    grid:    race.grid,
    laps:    race.laps,
    time:    race.time,
    allResults: (resultsByRound[race.round] || []).map(res => ({
      pos:        res.pos,
      name:       res.name,
      code:       res.code,
      team:       res.team,
      grid:       res.grid,
      fastestLap: res.fastest_lap,
    })),
  }));

  const qualifying = (racesData || []).map(race => ({
    round:   race.round,
    name:    race.name,
    date:    race.date,
    results: (qualByRound[race.round] || []).map(q => ({
      pos:  q.pos,
      name: q.name,
      code: q.code,
      team: q.team,
      q1:   q.q1,
      q2:   q.q2,
      q3:   q.q3,
    })),
  }));

  const drivers = (driversData || []).map(d => ({
    pos:    d.pos,
    name:   d.name,
    code:   d.code,
    nat:    d.nat,
    team:   d.team,
    points: d.points,
    wins:   d.wins,
  }));

  const constructors = (constructorsData || []).map(c => ({
    pos:    c.pos,
    team:   c.team,
    points: c.points,
    wins:   c.wins,
  }));

  const champDriver = drivers[0];
  const champCode   = champDriver?.code || '';
  const poles       = qualifying.filter(r => r.results[0]?.code === champCode).length;
  const podiums     = races.reduce((n, r) =>
    n + r.allResults.filter(res => res.pos <= 3 && res.code === champCode).length, 0);
  const fastestLaps = races.reduce((n, r) =>
    n + (r.allResults.find(res => res.fastestLap && res.code === champCode) ? 1 : 0), 0);

  return {
    year,
    champion:    champDriver?.name   || '—',
    champCode,
    champTeam:   champDriver?.team   || '—',
    champNat:    champDriver?.nat    || '—',
    champWins:   champDriver?.wins   || 0,
    champPoints: champDriver?.points || 0,
    poles,
    podiums,
    fastestLaps,
    totalRaces:  races.length,
    races,
    constructors,
    drivers,
    qualifying,
  };
}

/* ─── Jolpica season loader (current year only) ──────────────────── */
async function loadSeasonFromAPI(year, signal) {
  const [rawRaces, constructorRes, driverRes, rawQual] = await Promise.all([
    fetchRaceResults(year, signal),
    jolpicaFetch(`${year}/constructorstandings/`, signal),
    jolpicaFetch(`${year}/driverstandings/`, signal),
    fetchQualifying(year, signal),
  ]);

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

  const cStandings   = constructorRes.MRData.StandingsTable.StandingsLists?.[0];
  const constructors = (cStandings?.ConstructorStandings || []).map(c => ({
    pos:    parseInt(c.position),
    team:   c.Constructor.name,
    points: parseFloat(c.points),
    wins:   parseInt(c.wins),
  }));

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

  return {
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
}

/* ─── Load a full season ─────────────────────────────────────────── */
async function loadSeason(year, signal) {
  const isLiveSeason = year === THIS_YEAR;
  const now          = Date.now();
  const expired      = !seasonCacheTime[year] || (now - seasonCacheTime[year] > CACHE_TTL);

  if (seasonCache[year] && !(isLiveSeason && expired)) {
    return seasonCache[year];
  }

  let seasonData = isLiveSeason
    ? await loadSeasonFromAPI(year, signal)
    : await loadSeasonFromDB(year);

  if (!isLiveSeason && (!seasonData.races || seasonData.races.length === 0)) {
    console.warn(`No Supabase data for ${year}, falling back to Jolpica`);
    seasonData = await loadSeasonFromAPI(year, signal);
  }

  seasonCache[year]     = seasonData;
  seasonCacheTime[year] = Date.now();
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

/* ─── Teammate head-to-head diverging bar chart ──────────────────── */
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
          label:           'Driver 1',
          data:            pairs.map(p => p.d1Race),
          backgroundColor: pairs.map(p => teamColor(p.team) + 'cc'),
          borderColor:     pairs.map(p => teamColor(p.team)),
          borderWidth:     1,
          borderRadius:    3,
          stack:           'h2h',
        },
        {
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

/* ─── Animations ─────────────────────────────────────────────────── */
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

// [28] Guard: handle names with no space (single-word names)
function typewriteChampion(nameEl, cursorEl, fullName, speed = 42) {
  if (typewriterTimer) clearInterval(typewriterTimer);
  nameEl.innerHTML       = '';
  cursorEl.style.opacity = '1';

  const spaceIdx = fullName.lastIndexOf(' ');

  // If no space found, treat the whole name as surname (italic)
  const firstName = spaceIdx > -1 ? fullName.slice(0, spaceIdx) : '';
  const surname   = spaceIdx > -1 ? fullName.slice(spaceIdx + 1) : fullName;
  let i = 0;

  setTimeout(() => {
    typewriterTimer = setInterval(() => {
      i++;
      if (spaceIdx > -1 && i <= spaceIdx) {
        nameEl.innerHTML = fullName.slice(0, i);
      } else {
        const surnameProgress = i - (spaceIdx > -1 ? spaceIdx + 1 : 0);
        nameEl.innerHTML = firstName
          ? `${firstName} <em>${surname.slice(0, surnameProgress)}</em>`
          : `<em>${surname.slice(0, surnameProgress)}</em>`;
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

/* ─── Season Records [24] ────────────────────────────────────────── */
function renderSeasonRecords(data) {
  const races = data.races;

  let mostGained = { val: 0, driver: '—', race: '—' };
  races.forEach(race => {
    race.allResults.forEach(res => {
      if (res.grid > 0 && res.pos < 19) {
        const gained = res.grid - res.pos;
        if (gained > mostGained.val) {
          mostGained = {
            val:    gained,
            driver: res.code || res.name.split(' ').pop(),
            race:   race.name,
          };
        }
      }
    });
  });

  let longestStreak = 0, currentStreak = 0, streakDriver = '—';
  let lastWinner = null;
  [...races].sort((a, b) => a.round - b.round).forEach(race => {
    if (race.winner === '—') return;
    if (race.winner === lastWinner) {
      currentStreak++;
    } else {
      currentStreak = 1;
      lastWinner    = race.winner;
    }
    if (currentStreak > longestStreak) {
      longestStreak = currentStreak;
      streakDriver  = race.allResults[0]?.code || race.winner.split(' ').pop();
    }
  });

  const dnfMap = {};
  races.forEach(race => {
    race.allResults.forEach(res => {
      if (res.pos >= 19) {
        const key = res.code || res.name.split(' ').pop();
        dnfMap[key] = (dnfMap[key] || 0) + 1;
      }
    });
  });
  const topDnf = Object.entries(dnfMap).sort((a, b) => b[1] - a[1])[0];

  const poleMap = {};
  races.forEach(race => {
    race.allResults.forEach(res => {
      if (res.grid === 1) {
        const key = res.code || res.name.split(' ').pop();
        poleMap[key] = (poleMap[key] || 0) + 1;
      }
    });
  });
  const topPole = Object.entries(poleMap).sort((a, b) => b[1] - a[1])[0];

  let poleWins = 0, totalPoles = 0;
  races.forEach(race => {
    const winner  = race.allResults.find(r => r.pos === 1);
    const poleman = race.allResults.find(r => r.grid === 1);
    if (poleman) {
      totalPoles++;
      if (winner && winner.code === poleman.code) poleWins++;
    }
  });
  const poleWinRate = totalPoles ? Math.round((poleWins / totalPoles) * 100) : 0;

  return `
    <hr class="right-divider">
    <p class="eyebrow" style="margin-bottom:14px">Season Records</p>
    ${[
      ['Most gained',  `+${mostGained.val} · ${mostGained.driver} · ${(mostGained.race || '').replace(' GP', '')}`],
      ['Win streak',   `${longestStreak} · ${streakDriver}`],
      ['Most DNFs',    topDnf  ? `${topDnf[1]} · ${topDnf[0]}`  : '—'],
      ['Most poles',   topPole ? `${topPole[1]} · ${topPole[0]}` : '—'],
      ['Pole → win',   `${poleWinRate}% · ${poleWins}/${totalPoles}`],
    ].map(([label, val]) => `
      <div class="stat-row">
        <span class="stat-label">${label}</span>
        <span class="stat-val">${val}</span>
      </div>
    `).join('')}
  `;
}

function renderSeasonStats(data) {
  return `
    <hr class="right-divider">
    <p class="eyebrow" style="margin-bottom:14px">Season Stats</p>
    ${[
      ['Total rounds', data.totalRaces],
      ['Fastest laps', data.fastestLaps],
      ['Win rate',     Math.round((data.champWins / data.totalRaces) * 100) + '%'],
      ['Podium rate',  Math.round((data.podiums   / data.totalRaces) * 100) + '%'],
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
    ${renderSeasonRecords(data)}
    ${renderSeasonStats(data)}
  `;
}

/* ─── Grid → Finish slope chart [23] ────────────────────────────── */
function renderSlopeChart(race) {
  const allRes = (race.allResults || [])
    .filter(r => r.grid > 0)
    .sort((a, b) => a.pos - b.pos);

  if (!allRes.length) return '<p class="drilldown-empty">No grid data available</p>';

  const LEFT_X  = 75;
  const RIGHT_X = 600;
  const Y_TOP   = 52;
  const Y_STEP  = 28;

  const byGrid   = [...allRes].sort((a, b) => a.grid - b.grid);
  const byFinish = [...allRes].sort((a, b) => a.pos  - b.pos);

  const gridYMap = {}, finishYMap = {};
  byGrid.forEach((r, i)   => { gridYMap[r.code   || r.name] = Y_TOP + i * Y_STEP; });
  byFinish.forEach((r, i) => { finishYMap[r.code || r.name] = Y_TOP + i * Y_STEP; });

  function dotLineColor(res) {
    if (res.pos >= 19) return '#E24B4A';
    return teamColor(res.team);
  }
  function deltaColor(res) {
    if (res.pos >= 19) return '#E24B4A';
    const d = res.grid - res.pos;
    return d > 0 ? '#1D9E75' : d === 0 ? '#888780' : '#D85A30';
  }

  const totalHeight = Y_TOP + byGrid.length * Y_STEP + 24;

  const svgLines = byGrid.map(res => {
    const key    = res.code || res.name;
    const yL     = gridYMap[key];
    const yR     = finishYMap[key];
    const col    = dotLineColor(res);
    const isDnf  = res.pos >= 19;
    const gained = res.grid - res.pos;
    return `<line x1="${LEFT_X}" y1="${yL}" x2="${RIGHT_X}" y2="${yR}"
      stroke="${col}" stroke-width="${gained > 3 ? 2.5 : 1.8}"
      opacity="${isDnf ? 0.45 : 0.75}"
      ${isDnf ? 'stroke-dasharray="4 3"' : ''}/>`;
  }).join('');

  const leftLabels = byGrid.map(res => {
    const yL      = gridYMap[res.code || res.name];
    const col     = dotLineColor(res);
    const surname = (res.code || (res.name || '').split(' ').pop() || '').slice(0, 3).toUpperCase();
    return `
      <circle cx="${LEFT_X}" cy="${yL}" r="4.5" fill="${col}"/>
      <text x="${LEFT_X - 16}" y="${yL + 5}" text-anchor="end"
        style="font-family:var(--font-mono);font-size:18px;fill:var(--text-4)">${res.grid}</text>
      <text x="${LEFT_X - 50}" y="${yL + 5}" text-anchor="end"
        style="font-family:var(--font-mono);font-size:22px;font-weight:500;fill:var(--text-2)">${surname}</text>`;
  }).join('');

  const rightLabels = byFinish.map(res => {
    const yR       = finishYMap[res.code || res.name];
    const col      = dotLineColor(res);
    const dcol     = deltaColor(res);
    const isDnf    = res.pos >= 19;
    const delta    = res.grid - res.pos;
    const deltaStr = isDnf ? 'DNF' : delta > 0 ? `+${delta}` : delta === 0 ? '—' : `${delta}`;
    return `
      <circle cx="${RIGHT_X}" cy="${yR}" r="4.5" fill="${col}"/>
      <text x="${RIGHT_X + 16}" y="${yR + 5}" text-anchor="start"
        style="font-family:var(--font-mono);font-size:18px;fill:var(--text-4)">${isDnf ? '--' : res.pos}</text>
      <text x="${RIGHT_X + 42}" y="${yR + 5}" text-anchor="start"
        style="font-family:var(--font-mono);font-size:22px;font-weight:500;fill:${dcol}">${deltaStr}</text>`;
  }).join('');

  return `
    <div style="padding:8px 8px 8px 8px">
      <svg width="100%" viewBox="0 0 700 ${totalHeight}" style="display:block;overflow:visible">
        <line x1="${LEFT_X}"  y1="${Y_TOP - 16}" x2="${LEFT_X}"  y2="${totalHeight - 36}"
          stroke="var(--border)" stroke-width="0.5"/>
        <line x1="${RIGHT_X}" y1="${Y_TOP - 16}" x2="${RIGHT_X}" y2="${totalHeight - 36}"
          stroke="var(--border)" stroke-width="0.5"/>
        <text x="${LEFT_X}"  y="${Y_TOP - 24}" text-anchor="middle"
          style="font-family:var(--font-mono);font-size:18px;letter-spacing:2.5px;fill:var(--text-4)">GRID</text>
        <text x="${RIGHT_X}" y="${Y_TOP - 24}" text-anchor="middle"
          style="font-family:var(--font-mono);font-size:18px;letter-spacing:2.5px;fill:var(--text-4)">FINISH</text>
        ${svgLines}
        ${leftLabels}
        ${rightLabels}
      </svg>
    </div>`;
}

/* ─── Race drill-down ────────────────────────────────────────────── */
function renderDrilldown(round, data) {
  const race     = data.races.find(r => r.round === round);
  const qualRace = data.qualifying.find(r => r.round === round);

  const trackSlug = (race.circuit || '').toLowerCase()
    .replace(/\s+/g, '-')
    .replace(/[^a-z0-9-]/g, '');

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
        <p class="drilldown-col-title" style="color:var(--text-2)">Qualifying</p>
        ${qualRows}
        <div class="drilldown-track-wrap" style="flex-direction:column;align-items:flex-start;border-top:none;margin-top:12px">
          <p class="drilldown-col-title" style="margin-bottom:12px;color:var(--text-2);border:none">${race.circuit} — ${race.country}</p>
          <img
            src="image/tracks/${trackSlug}.svg"
            alt="${race.circuit}"
            class="drilldown-track-img"
            onerror="this.style.display='none'"
          />
        </div>
      </div>
      <div class="drilldown-divider"></div>
      <div class="drilldown-col drilldown-col-race">
        <p class="drilldown-col-title" style="color:var(--text-2)">Race — Top 10</p>
        ${raceRows}
        <div class="drilldown-lap-section">
          <p class="drilldown-col-title" style="margin-top:24px;color:var(--text-2)">Grid → Finish</p>
          ${renderSlopeChart(race)}
        </div>
      </div>
    </div>
  `;
}

function toggleRaceExpand(round, data) {
  const existing = document.getElementById(`drilldown-${round}`);

  if (existing) {
    existing.classList.add('drilldown-closing');
    setTimeout(() => existing.remove(), 220);
    document.querySelector(`.race-row[data-round="${round}"]`)?.classList.remove('expanded');
    expandedRound = null;
    return;
  }

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

  requestAnimationFrame(() => panel.classList.add('drilldown-open'));
}

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

  let champAhead = 0, runnerAhead = 0;
  data.races.forEach(race => {
    const r1 = race.allResults.find(r => r.code === champ.code  || r.name === champ.name);
    const r2 = race.allResults.find(r => r.code === runner.code || r.name === runner.name);
    if (r1 && r2 && r1.pos < 19 && r2.pos < 19) {
      r1.pos < r2.pos ? champAhead++ : runnerAhead++;
    }
  });

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

/* ─── Hero section ───────────────────────────────────────────────── */
function renderHero(data) {
  const champColor = teamColor(data.champTeam);
  return `
    <div class="hero">
      <div class="hero-year-ghost">${data.year}</div>
      <img
        src="image/${data.year}.svg"
        class="hero-car"
        alt="${data.year} F1 Car"
        onerror="this.style.display='none'"
      />
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
      <div style="margin-top:16px">
        <button
          onclick="
            const el = document.getElementById('race-data');
            const y = el.getBoundingClientRect().top + window.scrollY - 104;
            window.scrollTo({ top: y, behavior: 'smooth' });
          "
          style="
            font-family: var(--font-mono);
            font-size: 11px;
            letter-spacing: 1.5px;
            text-transform: uppercase;
            color: ${champColor};
            background: ${champColor}18;
            border: 1px solid ${champColor}55;
            border-radius: var(--radius-sm);
            padding: 6px 14px;
            cursor: pointer;
            transition: color 0.15s, border-color 0.15s, background 0.15s;
          "
          onmouseover="this.style.background='${champColor}30';this.style.borderColor='${champColor}'"
          onmouseout="this.style.background='${champColor}18';this.style.borderColor='${champColor}55'"
        >↓ View Race Results</button>
      </div>
    </div>
  `;
}
/* ─── Metrics grid ───────────────────────────────────────────────── */
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
function renderSeason(data) {
  expandedRound = null;
  const { html: metricsHtml, metrics } = renderMetricsGrid(data);

  document.getElementById('content').innerHTML = `
    <div style="animation:fadeUp .5s ease forwards;opacity:0">
      ${renderHero(data)}
      ${metricsHtml}
      ${renderChampVsRunnerUp(data)}
      <div class="charts-section fade-up" id="charts-section" style="animation-delay:280ms"></div>
      <div class="main-grid">
        <div>
          <div class="tabs" id="race-data">
            <button class="tab-btn${currentTab === 'races'      ? ' active' : ''}" data-tab="races">Races</button>
            <button class="tab-btn${currentTab === 'qualifying' ? ' active' : ''}" data-tab="qualifying">Qualifying</button>
            <button class="tab-btn${currentTab === 'drivers'    ? ' active' : ''}" data-tab="drivers">Drivers</button>
          </div>
          <div id="tab-content">${getTabContent(data)}</div>
        </div>
        <div>${renderRightColumn(data)}</div>
      </div>
    </div>
  `;

  document.querySelectorAll('.tab-btn').forEach(btn => {
    btn.addEventListener('click', () => switchTab(btn.dataset.tab));
  });

  wireRaceRowClicks(data);
  document.querySelectorAll('.race-row[data-round]').forEach(row => {
    row.addEventListener('keydown', e => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        toggleRaceExpand(parseInt(row.dataset.round), data);
      }
    });
  });

  requestAnimationFrame(() => {
    const nameEl   = document.getElementById('hero-name');
    const cursorEl = document.getElementById('hero-cursor');
    if (nameEl && cursorEl) typewriteChampion(nameEl, cursorEl, data.champion);

    const carDelay = 80 + (data.champion.length * 42) + 300;
    setTimeout(() => {
      const carEl = document.querySelector('.hero-car');
      if (carEl) {
        carEl.style.display = 'block';
        carEl.style.opacity = '0';
        carEl.style.animation = 'carDriveIn 1s cubic-bezier(0.25, 0.46, 0.45, 0.94) forwards';
      }
    }, carDelay);

    setTimeout(() => {
      metrics.forEach(m => {
        const el = document.getElementById(m.id);
        if (el) animateCount(el, m.val, 900 + m.delay);
      });
    }, 150);
  });

  setTimeout(() => renderCharts(data), 420);
}

/* ─── Tab switching ──────────────────────────────────────────────── */
function switchTab(tab) {
  currentTab    = tab;
  expandedRound = null;
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
  if (activeFetchController) activeFetchController.abort();
  activeFetchController = new AbortController();
  const { signal } = activeFetchController;

  isLoading = true;
  showLoading(
    year === THIS_YEAR ? 'FETCHING LIVE DATA' : 'LOADING SEASON DATA',
    year === THIS_YEAR ? `JOLPICA F1 — ${year}` : `SUPABASE — ${year}`
  );

  try {
    const data = await loadSeason(year, signal);
    renderSeason(data);

    const adjacent = [year - 1, year + 1].filter(
      y => y >= 2000 && y <= THIS_YEAR && !seasonCache[y]
    );
    adjacent.forEach(y => {
      const ctrl = new AbortController();
      loadSeason(y, ctrl.signal).catch(() => {});
    });

  } catch (err) {
    if (err.name === 'AbortError') return;
    console.error(err);
    showError(isCorsError(err)
      ? (window.location.protocol === 'file://'
          ? 'Network error — make sure you\'re running via a local server, not file://'
          : 'Network error — the API may be temporarily unavailable. Please try again in a moment.')
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

  document.querySelectorAll('.season-btn').forEach(btn => {
    btn.addEventListener('click', () => selectSeason(parseInt(btn.dataset.year)));
  });
}

/* ─── Theme ──────────────────────────────────────────────────────── */
// [25] initTheme() removed — theme is initialised by the inline script in index.html
//      which runs before body render to prevent flash. No need for a JS function here.

function toggleTheme() {
  const dark = document.documentElement.classList.toggle('dark');
  localStorage.setItem('f1-theme', dark ? 'dark' : 'light');
  setChartDefaults();
  const data = seasonCache[currentSeason];
  if (data) setTimeout(() => renderCharts(data), 50);
}

/* ─── Init ───────────────────────────────────────────────────────── */
setChartDefaults();

const _footerYear = document.getElementById('footer-year');
if (_footerYear) _footerYear.textContent = `© ${new Date().getFullYear()} Sudip Shrestha`;

const _themeToggle = document.getElementById('theme-toggle');
if (_themeToggle) _themeToggle.addEventListener('click', toggleTheme);

const isStaticPage = !document.getElementById('season-bar');

if (!isStaticPage) {
  buildSeasonBar();
  fetchAndRender(currentSeason);
}