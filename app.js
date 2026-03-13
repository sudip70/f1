/* ═══════════════════════════════════════════════════════════════════
   F1. Analytics — app.js
   Jolpica F1  →  race results, standings, qualifying
   OpenF1      →  pit stop data

   Run via a local server — cannot fetch from file:// URLs.
   Quick start:  python3 -m http.server 8080
═══════════════════════════════════════════════════════════════════ */
'use strict';

/* ─── Config ─────────────────────────────────────────────────────── */
const JOLPICA = 'https://api.jolpi.ca/ergast/f1';
const OPENF1  = 'https://api.openf1.org/v1';
const SEASONS = Array.from({ length: 26 }, (_, i) => 2025 - i); // 2025 → 2000

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

function teamColor(name) {
  if (!name) return '#aaa';
  const lower = name.toLowerCase();
  for (const [key, color] of Object.entries(TEAM_COLORS)) {
    if (lower.includes(key.toLowerCase())) return color;
  }
  return '#999';
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

/* ─── State ──────────────────────────────────────────────────────── */
let currentSeason = 2024;
let currentTab    = 'races';
let seasonCache   = {};
let chartInstances = {};
let isLoading     = false;
let typewriterTimer = null;

/* ─── Fetch helpers ──────────────────────────────────────────────── */
function isCorsError(err) {
  return err instanceof TypeError && (
    err.message === 'Failed to fetch' ||
    err.message.includes('NetworkError') ||
    err.message.includes('CORS')
  );
}

async function jolpicaFetch(path) {
  const res = await fetch(`${JOLPICA}/${path}`);
  if (!res.ok) throw new Error(`Jolpica ${res.status}: ${path}`);
  return res.json();
}

async function openf1Fetch(path) {
  const res = await fetch(`${OPENF1}/${path}`);
  if (!res.ok) throw new Error(`OpenF1 ${res.status}: ${path}`);
  return res.json();
}

/* ─── Paginated race results fetch ───────────────────────────────────
   KEY FIX: Jolpica caps each page at 30 rows regardless of `limit`.
   Each row is ONE driver result, not one race.
   A 24-race season has ~480 rows (24 × 20 drivers).
   The same race round can appear split across two pages, so we must
   MERGE results by round number instead of collecting race objects
   from each page directly.
─────────────────────────────────────────────────────────────────── */
async function fetchRaceResults(year) {
  const PAGE = 30;

  // First request reveals total row count
  const first = await jolpicaFetch(`${year}/results/?limit=${PAGE}&offset=0`);
  const total = parseInt(first.MRData.total) || 0;

  // Fetch all remaining pages in parallel
  const pages = [first];
  if (total > PAGE) {
    const offsets = Array.from(
      { length: Math.ceil((total - PAGE) / PAGE) },
      (_, i) => PAGE + i * PAGE
    );
    const rest = await Promise.all(
      offsets.map(offset => jolpicaFetch(`${year}/results/?limit=${PAGE}&offset=${offset}`))
    );
    pages.push(...rest);
  }

  // Merge driver results into a map keyed by round number
  const byRound = {};
  pages.forEach(page => {
    (page.MRData.RaceTable.Races || []).forEach(race => {
      if (!byRound[race.round]) {
        // Store race metadata once; Results array will be built up
        byRound[race.round] = { ...race, Results: [] };
      }
      byRound[race.round].Results.push(...(race.Results || []));
    });
  });

  return Object.values(byRound)
    .sort((a, b) => parseInt(a.round) - parseInt(b.round));
}

/* ─── Paginated qualifying fetch (same merge strategy) ───────────── */
async function fetchQualifying(year) {
  const PAGE = 30;

  const first = await jolpicaFetch(`${year}/qualifying/?limit=${PAGE}&offset=0`);
  const total = parseInt(first.MRData.total) || 0;

  const pages = [first];
  if (total > PAGE) {
    const offsets = Array.from(
      { length: Math.ceil((total - PAGE) / PAGE) },
      (_, i) => PAGE + i * PAGE
    );
    const rest = await Promise.all(
      offsets.map(offset => jolpicaFetch(`${year}/qualifying/?limit=${PAGE}&offset=${offset}`))
    );
    pages.push(...rest);
  }

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
async function loadSeason(year) {
  if (seasonCache[year]) return seasonCache[year];

  const [rawRaces, constructorRes, driverRes, rawQual] = await Promise.all([
    fetchRaceResults(year),
    jolpicaFetch(`${year}/constructorstandings/`),
    jolpicaFetch(`${year}/driverstandings/`),
    fetchQualifying(year),
  ]);

  // Parse races — keep full driver list for chart use
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
      // Full results needed for charts
      allResults: (r.Results || []).map(res => ({
        pos:  parseInt(res.position) || 99,
        name: `${res.Driver.givenName} ${res.Driver.familyName}`,
        code: res.Driver.code,
        team: res.Constructor?.name || '—',
        grid: parseInt(res.grid) || 0,
        fastestLap: res.FastestLap?.rank === '1',
      })),
    };
  });

  // Parse constructor standings
  const cStandings = constructorRes.MRData.StandingsTable.StandingsLists?.[0];
  const constructors = (cStandings?.ConstructorStandings || []).map(c => ({
    pos:    parseInt(c.position),
    team:   c.Constructor.name,
    points: parseFloat(c.points),
    wins:   parseInt(c.wins),
  }));

  // Parse driver standings
  const dStandings = driverRes.MRData.StandingsTable.StandingsLists?.[0];
  const champion   = dStandings?.DriverStandings?.[0];
  const drivers = (dStandings?.DriverStandings || []).map(d => ({
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

  const champCode = champDriver?.code || '';
  const poles   = qualifying.filter(r => r.results[0]?.code === champCode).length;
  const podiums = rawRaces.reduce((n, r) =>
    n + (r.Results || []).filter(res => parseInt(res.position) <= 3 && res.Driver?.code === champCode).length, 0);
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

  seasonCache[year] = seasonData;
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
  const topDrivers = data.drivers.slice(0, topN);
  const sortedRaces = [...data.races].sort((a, b) => a.round - b.round);

  const series = topDrivers.map(driver => {
    let cumulative = 0;
    const points = [0];
    sortedRaces.forEach(race => {
      const result = race.allResults.find(r => r.code === driver.code || r.name === driver.name);
      cumulative += result ? getPoints(result.pos, data.year) : 0;
      points.push(cumulative);
    });
    return {
      name: driver.name,
      surname: driver.name.split(' ').pop(),
      team: driver.team,
      code: driver.code,
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
    borderWidth: 1,
    titleColor:  isDark() ? '#666' : '#999',
    bodyColor:   isDark() ? '#aaa' : '#555',
    padding: 10,
  };
}

function setChartDefaults() {
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
        label:           s.surname,
        data:            s.points,
        borderColor:     teamColor(s.team),
        backgroundColor: 'transparent',
        borderWidth:     s.name === data.champion ? 2.5 : 1,
        pointRadius:     s.name === data.champion ? 3 : 0,
        pointHoverRadius: 5,
        tension: 0.35,
      })),
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      interaction: { mode: 'index', intersect: false },
      plugins: {
        legend: {
          display: true,
          position: 'bottom',
          labels: { boxWidth: 8, padding: 16, color: chartTickColor(), usePointStyle: true, pointStyleWidth: 8 },
        },
        tooltip: { ...tooltipOptions(), callbacks: { label: c => `  ${c.dataset.label}: ${c.raw} pts` } },
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
      indexAxis: 'y',
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: { display: false },
        tooltip: { ...tooltipOptions(), callbacks: { label: c => `  ${c.raw} wins` } },
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
        data:            top6.map(c => c.points),
        backgroundColor: top6.map(c => teamColor(c.team) + 'bb'),
        borderColor:     top6.map(c => teamColor(c.team)),
        borderWidth: 1.5,
        hoverBorderWidth: 2.5,
      }],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      cutout: '70%',
      plugins: {
        legend: {
          display: true,
          position: 'bottom',
          labels: { boxWidth: 8, padding: 14, color: chartTickColor(), usePointStyle: true, pointStyleWidth: 8 },
        },
        tooltip: { ...tooltipOptions(), callbacks: { label: c => `  ${c.label}: ${c.raw} pts` } },
      },
    },
  });
}

function buildGridScatterChart(canvasId, data) {
  const ctx = document.getElementById(canvasId);
  if (!ctx) return;

  const grid  = chartGridColor();
  const ticks = chartTickColor();
  const fieldPoints = [], champPoints = [], dnfPoints = [];

  data.races.forEach(race => {
    race.allResults.forEach(res => {
      if (!res.grid || res.grid === 0) return;
      const pt = { x: res.grid, y: res.pos };
      if (res.pos >= 19)              dnfPoints.push(pt);
      else if (res.code === data.champCode) champPoints.push(pt);
      else                            fieldPoints.push(pt);
    });
  });

  chartInstances.scatter = new Chart(ctx, {
    type: 'scatter',
    data: {
      datasets: [
        { label: 'Field',    data: fieldPoints, backgroundColor: isDark() ? 'rgba(255,255,255,0.08)' : 'rgba(0,0,0,0.08)', pointRadius: 3, pointHoverRadius: 5 },
        { label: 'DNF',      data: dnfPoints,   backgroundColor: 'rgba(200,0,0,0.2)',       pointRadius: 3, pointHoverRadius: 5 },
        { label: data.champCode || 'Champion', data: champPoints, backgroundColor: teamColor(data.champTeam) + 'cc', borderColor: teamColor(data.champTeam), borderWidth: 1, pointRadius: 5, pointHoverRadius: 7 },
      ],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: {
          display: true,
          position: 'bottom',
          labels: { boxWidth: 8, padding: 14, color: chartTickColor(), usePointStyle: true, pointStyleWidth: 8 },
        },
        tooltip: { ...tooltipOptions(), callbacks: { label: c => `  Grid ${c.raw.x} → Finish P${c.raw.y}` } },
      },
      scales: {
        x: { title: { display: true, text: 'Grid', color: ticks, font: { size: 9 } }, grid: { color: grid }, ticks: { color: ticks, precision: 0 }, min: 1 },
        y: { title: { display: true, text: 'Finish', color: ticks, font: { size: 9 } }, grid: { color: grid }, ticks: { color: ticks, precision: 0 }, reverse: true, min: 1 },
      },
    },
  });
}

function buildGainLossChart(canvasId, data) {
  const ctx = document.getElementById(canvasId);
  if (!ctx) return;

  const sorted = [...data.races].sort((a, b) => a.round - b.round);
  const labels = [], values = [];

  sorted.forEach(race => {
    const result = race.allResults.find(r => r.code === data.champCode);
    if (!result || !result.grid || result.grid === 0) return;
    labels.push(`R${race.round}`);
    values.push(result.grid - result.pos);
  });

  const champCol = teamColor(data.champTeam);
  const grid     = chartGridColor();
  const ticks    = chartTickColor();

  chartInstances.gainloss = new Chart(ctx, {
    type: 'bar',
    data: {
      labels,
      datasets: [{
        data:            values,
        backgroundColor: values.map(v => v >= 0 ? champCol + '99' : 'rgba(200,0,0,0.2)'),
        borderColor:     values.map(v => v >= 0 ? champCol + 'cc' : 'rgba(200,0,0,0.5)'),
        borderWidth: 0,
        borderRadius: 3,
      }],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: { display: false },
        tooltip: { ...tooltipOptions(), callbacks: { label: c => c.raw >= 0 ? `  +${c.raw} gained` : `  ${c.raw} lost` } },
      },
      scales: {
        x: { grid: { display: false }, ticks: { color: ticks, maxTicksLimit: 14 } },
        y: { grid: { color: grid }, ticks: { color: ticks, precision: 0 } },
      },
    },
  });
}

/* ─── Render charts section ──────────────────────────────────────── */
function renderCharts(data) {
  const el = document.getElementById('charts-section');
  if (!el) return;

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
    </div>
  `;

  destroyCharts();
  requestAnimationFrame(() => {
    buildProgressionChart('ch-prog', data);
    buildWinsBarChart('ch-wins', data);
    buildConstructorDonut('ch-donut', data);
    buildGridScatterChart('ch-scatter', data);
    buildGainLossChart('ch-gl', data);
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
    pits.forEach(p => { stopsByDriver[p.driver_number] = (stopsByDriver[p.driver_number] || 0) + 1; });
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
        <div class="stat-row"><span class="stat-label">${l}</span><span class="stat-val">${v}</span></div>
      `).join('')}
    `;
  } catch (_) {
    el.innerHTML = `
      <p class="eyebrow" style="margin-bottom:6px">Pit Stops</p>
      <p class="pit-source">OpenF1 · no data for ${year}</p>
    `;
  }
}

/* ─── Animations ─────────────────────────────────────────────────── */
function animateCount(el, target, duration) {
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
  nameEl.innerHTML = '';
  cursorEl.style.opacity = '1';

  const spaceIdx = fullName.lastIndexOf(' ');
  const firstName = fullName.slice(0, spaceIdx);
  const surname   = fullName.slice(spaceIdx + 1);
  let i = 0;

  setTimeout(() => {
    typewriterTimer = setInterval(() => {
      i++;
      const slice = fullName.slice(0, i);
      if (i <= spaceIdx) {
        nameEl.innerHTML = slice;
      } else {
        // First name done — render surname in italic
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
  const isFileProt = location.protocol === 'file:';
  const isCors     = isCorsError(err);
  const showSetup  = isFileProt || isCors;
  const message    = typeof err === 'string' ? err : err?.message || 'Unknown error';

  // For CORS / file:// errors, inject a sticky banner once and keep it.
  // Don't wipe the content area on every season click.
  if (showSetup) {
    if (!document.getElementById('cors-banner')) {
      const banner = document.createElement('div');
      banner.id = 'cors-banner';
      banner.className = 'cors-banner fade-up';
      banner.innerHTML = `
        <div class="cors-banner-inner">
          <div class="cors-banner-text">
            <strong>Local server required</strong>
            <span>Browsers block API calls from <code>file://</code> URLs — run a local server first.</span>
          </div>
          <div class="cors-banner-commands">
            <code class="cors-cmd">python3 -m http.server 8080</code>
            <span class="cors-sep">or</span>
            <code class="cors-cmd">npx serve .</code>
            <span class="cors-sep">then open</span>
            <code class="cors-cmd">http://localhost:8080</code>
          </div>
          <button class="cors-dismiss" onclick="document.getElementById('cors-banner').remove()" aria-label="Dismiss">✕</button>
        </div>
      `;
      // Insert after the season bar wrap (below both sticky rows)
      const seasonWrap = document.querySelector('.season-bar-wrap');
      if (seasonWrap) seasonWrap.insertAdjacentElement('afterend', banner);
      else document.querySelector('.nav').insertAdjacentElement('afterend', banner);
    }
    // Don't replace content if it already has something rendered
    if (document.getElementById('content').innerHTML.trim() === '') {
      document.getElementById('content').innerHTML = `
        <div class="error-wrap fade-up" style="padding-top:40px">
          <p class="error-eyebrow">Waiting for local server</p>
          <p class="error-msg">Run one of the commands above, then refresh this page.</p>
        </div>
      `;
    }
    return;
  }

  // Generic (non-CORS) error — replace content as before
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
      <div class="race-row" style="animation-delay:${i * 25}ms">
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

/* ─── Right column ───────────────────────────────────────────────── */
function renderRightColumn(data) {
  const maxPts  = Math.max(...data.constructors.map(c => c.points), 1);
  const ws      = buildWinShare(data.races);
  const maxWins = ws[0]?.wins || 1;

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

    <hr class="right-divider">

    <div id="pit-block">
      <p class="eyebrow" style="margin-bottom:6px">Pit Stops</p>
      <p class="pit-loading">Fetching OpenF1 data…</p>
    </div>

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

/* ─── Main render ────────────────────────────────────────────────── */
function renderSeason(data) {
  const champColor = teamColor(data.champTeam);
  const metrics = [
    { label: 'Race Wins',  id: 'mv-wins',  val: data.champWins,   max: data.totalRaces,  delay: 0   },
    { label: 'Pole Pos.',  id: 'mv-poles', val: data.poles,       max: data.totalRaces,  delay: 80  },
    { label: 'Podiums',    id: 'mv-pods',  val: data.podiums,     max: data.totalRaces,  delay: 160 },
    { label: 'Points',     id: 'mv-pts',   val: data.champPoints, max: data.champPoints, delay: 240 },
  ];

  document.getElementById('content').innerHTML = `
    <div style="animation:fadeUp .5s ease forwards;opacity:0">

      <div class="hero">
        <div class="hero-year-ghost">${data.year}</div>
        <p class="eyebrow">World Champion — ${data.year}</p>
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

      <div class="main-grid">
        <div>
          <div class="tabs">
            <button class="tab-btn${currentTab === 'races'      ? ' active' : ''}" onclick="switchTab('races')">Races</button>
            <button class="tab-btn${currentTab === 'qualifying' ? ' active' : ''}" onclick="switchTab('qualifying')">Qualifying</button>
            <button class="tab-btn${currentTab === 'drivers'    ? ' active' : ''}" onclick="switchTab('drivers')">Drivers</button>
          </div>
          <div id="tab-content">${getTabContent(data)}</div>
        </div>
        <div>${renderRightColumn(data)}</div>
      </div>

      <div class="charts-section fade-up" id="charts-section" style="animation-delay:280ms"></div>
    </div>
  `;

  // Kick off typewriter + metric counters
  requestAnimationFrame(() => {
    const nameEl   = document.getElementById('hero-name');
    const cursorEl = document.getElementById('hero-cursor');
    if (nameEl && cursorEl) typewriteChampion(nameEl, cursorEl, data.champion);

    setTimeout(() => {
      metrics.forEach(m => {
        const el = document.getElementById(m.id);
        if (el) animateCount(el, m.val, 900 + m.delay);
      });
    }, 150);
  });

  // Non-blocking: pit data
  const pitEl = document.getElementById('pit-block');
  if (pitEl) loadPitData(data.year, pitEl);

  // Charts render after short settle delay
  setTimeout(() => renderCharts(data), 420);
}

/* ─── Tab switching ──────────────────────────────────────────────── */
function switchTab(tab) {
  currentTab = tab;
  const data = seasonCache[currentSeason];
  if (!data) return;

  document.querySelectorAll('.tab-btn').forEach(btn => {
    btn.classList.toggle('active', btn.textContent.trim().toLowerCase() === tab);
  });

  const tabEl = document.getElementById('tab-content');
  if (tabEl) {
    tabEl.style.cssText = 'opacity:0;transform:translateY(6px);transition:opacity .2s,transform .2s';
    setTimeout(() => {
      tabEl.innerHTML = getTabContent(data);
      tabEl.style.cssText = 'opacity:1;transform:translateY(0);transition:opacity .2s,transform .2s';
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
  isLoading = true;
  setApiStatus('loading');
  showLoading('FETCHING RACE DATA', `JOLPICA F1 — ${year}`);

  try {
    const data = await loadSeason(year);
    setApiStatus('live');
    renderSeason(data);
  } catch (err) {
    console.error(err);
    setApiStatus('error');
    showError(err);
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
      onclick="selectSeason(${yr})"
      ${isLoading ? 'disabled' : ''}
    >${yr}</button>
  `).join('');
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
  // Rebuild charts so axis/tooltip colours update
  const data = seasonCache[currentSeason];
  if (data) setTimeout(() => renderCharts(data), 50);
}

/* ─── Init ───────────────────────────────────────────────────────── */
initTheme();
setChartDefaults();

document.getElementById('footer-year').textContent = `© ${new Date().getFullYear()} Sudip Shrestha`;
document.getElementById('theme-toggle').addEventListener('click', toggleTheme);

// Only run dashboard logic on the main analytics page
const isStaticPage = document.currentScript?.dataset.page === 'static'
                  || !document.getElementById('season-bar');

if (!isStaticPage) {
  buildSeasonBar();
  fetchAndRender(currentSeason);
}