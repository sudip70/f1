# F1. Analytics

A browser-based Formula 1 analytics dashboard covering every season from 2000 to present. No account, no build step, no framework - just HTML, CSS, and JavaScript.

**Live:** [sudip70.github.io/f1](https://sudip70.github.io/f1)

**Demo:** 
<p align="center">
  <img src="f1_demo.gif" width="100%"/>
</p>
---

## Features

- **Season selector** - browse all seasons from 2000 to the current live year
- **Champion hero** - typewriter animation, team-coloured accents, hero car drive-in
- **Metric cards** - race wins, pole positions, podiums, and points with animated fill bars
- **Head-to-head strip** - champion vs runner-up comparison across points, wins, poles, podiums, and race H2H
- **6 analytics charts** - championship progression, race wins, constructor share, grid vs finish scatter, positions gained/lost, and teammate H2H
- **Race list** - all rounds with expandable drill-downs showing qualifying, race top 10, and a grid→finish slope chart
- **Qualifying tab** - pole positions with Q1/Q2/Q3 lap times per round
- **Driver standings** - final championship table per season
- **Constructor standings** - points bar chart with team colours
- **Win share & season records** - derived stats including win streaks, most DNFs, pole→win rate
- **Dark mode** - system preference detection + localStorage persistence
- **Animated tab indicator** - sliding underline between Races / Qualifying / Drivers
- **Team-coloured race rows** - left border accent on hover using the winner's team colour
- **F1 chat assistant** - floating modal with session-aware follow-ups grounded in Supabase archive data and the live Jolpica season

---

## Data Sources

| Source | Used for | Speed |
|--------|----------|-------|
| [Supabase](https://supabase.com) (PostgreSQL) | Past seasons 2000–2025 | ~1s (5 parallel queries) |
| [Jolpica F1 API](https://api.jolpi.ca) | Current live season | ~3–5s (paginated) |

Past seasons are pre-seeded into Supabase to avoid Jolpica's 200 req/hour rate limit and 30-row page cap. The current season is always fetched live. See [About the Database & APIs](about-api.html) for full architecture details.

---

## Running Locally

Browsers block `fetch()` and ES modules when opening files via `file://`. You need a local server.

**Option 1 - Python (no install needed):**
```bash
python3 -m http.server 8000
#then open http://localhost:8000
```

**Option 2 - Node.js:**
```bash
npx serve .
#then open the URL it prints
```

**Option 3 - VS Code:**
Install the **Live Server** extension → right-click `index.html` → Open with Live Server.

### Chatbot setup

The chat feature needs a deployed Supabase Edge Function and a Groq API key.

You do not need a global Supabase CLI install on this machine. Use `npx supabase ...`.

1. Apply the included database migration for the shared chat rate limiter with your normal Supabase migration flow.

2. Set Supabase secrets:

```bash
npx supabase secrets set GROQ_API_KEY=your_key_here
npx supabase secrets set GROQ_MODEL=openai/gpt-oss-20b
npx supabase secrets set CHAT_RATE_LIMIT_PER_MINUTE=5
```


3. Deploy the edge function:

```bash
npx supabase functions deploy chat
```

4. `supabase/config.toml` disables JWT verification for this public, read-only chat endpoint, so the browser can call it with the existing anon key.

---

## Project Structure

```
f1/
├── index.html          #Main analytics page
├── about.html          #About the project & author
├── about-api.html      #Data sources & architecture docs
├── app.js              #All JS - data fetching, rendering, charts
├── chat.js             #Floating chat modal + session state + edge function calls
├── style.css           #All styles - tokens, components, animations
├── package.json        #Module type declaration + supabase dep
├── supabase/
│   ├── config.toml     #Edge function config
│   ├── migrations/     #SQL migrations, including chat rate limiting
│   └── functions/
│       └── chat/
│           └── index.ts #Chat backend with Groq tool calling and plain-text output cleanup
└── image/
    ├── YYYY.svg        #Hero car SVG per season year
    └── tracks/
        └── *.svg       #Circuit layout SVGs (named by circuit slug)
```

---

## Architecture

```
Season select
    │
    ├── Cache hit? → render immediately
    │
    ├── Past season (< current year)
    │       └── Supabase: 5 parallel SELECT queries
    │           races / race_results / qualifying_results /
    │           driver_standings / constructor_standings
    │
    └── Current season
            └── Jolpica F1 API: 4 parallel requests
                results (paginated) / driverstandings /
                constructorstandings / qualifying (paginated)
```

Both paths normalise into the same `seasonData` shape so all rendering code is shared regardless of source.

### Chatbot architecture

```text
Floating chat modal
    │
    └── Supabase Edge Function: /functions/v1/chat
            │
            ├── Supabase archive tools (2000 → last completed season)
            ├── Jolpica live tools (current season only)
            └── Groq Chat Completions API
                    └── local tool calling + plain-text answer normalization
```

The browser stores chat history and resolved follow-up context in `sessionStorage`. The edge function keeps the model grounded by exposing validated F1 data tools instead of raw SQL generation, then normalises the final reply back to plain text for the widget.

The default model is Groq's free-tier `openai/gpt-oss-20b`, and the edge function rate limit is tuned conservatively to stay within Groq request limits for a public site.

---

## Known Limitations

- **Sprint points (2021+)** - sprint weekend points are not included in the championship progression chart. The Jolpica sprint endpoint requires separate per-round calls which would exceed rate limits.
- **Qualifying pre-2006** - knockout Q1/Q2/Q3 qualifying was introduced in 2006. Seasons before that show single qualifying times where available.
- **Current season cache** - live season data is cached for 5 minutes. During an active race weekend you may need to refresh to see updated standings.
- **Circuit SVGs** - track layout images are optional. If a slug-matched SVG isn't present in `image/tracks/`, the image silently hides itself.

---

## Tech Stack

- **Vanilla HTML / CSS / JavaScript** - no build step, no bundler, no framework
- **[Chart.js 4.4](https://www.chartjs.org)** - all 6 analytics charts
- **[Supabase JS](https://supabase.com/docs/reference/javascript)** — past season queries via CDN ESM import
- **[Jolpica F1 API](https://api.jolpi.ca)** - live season data, Ergast-compatible
- **[Lora](https://fonts.google.com/specimen/Lora)** - serif font for headings and hero name
- **[JetBrains Mono](https://www.jetbrains.com/legalforms/fonts/)** — monospace font for labels, stats, and metadata
- **[Umami](https://umami.is)** - privacy-friendly analytics (no cookies)

---

## Supabase Schema

| Table | Key columns | Notes |
|-------|-------------|-------|
| `races` | `year`, `round`, `name`, `circuit`, `country`, `date`, `winner`, `team`, `grid` | One row per race |
| `race_results` | `year`, `round`, `pos`, `name`, `code`, `team`, `grid`, `fastest_lap` | One row per driver per race |
| `qualifying_results` | `year`, `round`, `pos`, `name`, `code`, `team`, `q1`, `q2`, `q3` | One row per driver per qualifying |
| `driver_standings` | `year`, `pos`, `name`, `code`, `nat`, `team`, `points`, `wins` | Final standings per season |
| `constructor_standings` | `year`, `pos`, `team`, `points`, `wins` | Final standings per season |

All tables have Row Level Security (RLS) enabled. The anon public key is read-only - `INSERT`, `UPDATE`, and `DELETE` are blocked at the policy level.

---

## Planned Features

- Lap time distribution charts (requires `lap_times` table)
- Pit stop telemetry - total stops, fastest pit, avg stop time (Jolpica covers 2012+)
- Tyre strategy per driver per race (OpenF1 `/stints`, 2023+)
- Sprint race results and points (separate Jolpica endpoint per round)
- Live race timing and position tracking (OpenF1 WebSocket, significant complexity)

---

## Author

**Sudip Shrestha** - Data Analyst & AI Engineer based in Canada.

[Portfolio](https://sudip70.github.io) · [LinkedIn](https://www.linkedin.com/in/sudipshrestha-58/) · [GitHub](https://github.com/sudip70) · [sudipshrestha.ca@gmail.com](mailto:sudipshrestha.ca@gmail.com)

---

*Data sourced from Jolpica F1 API and stored in Supabase. Not affiliated with Formula 1, FIA, or any constructor.*
