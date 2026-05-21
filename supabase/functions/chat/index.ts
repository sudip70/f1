import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.49.8';

type ChatMessage = {
  role: 'user' | 'assistant';
  content: string;
};

type ResolvedContext = {
  year: number;
  driverName: string;
  raceName: string;
  teamName: string;
  round: number;
  source: 'supabase' | 'jolpica' | 'unknown';
};

type SourceItem = {
  label: string;
  sourceType: 'supabase' | 'jolpica';
  season: number;
  detail: string;
};

type SeasonData = {
  year: number;
  source: 'supabase' | 'jolpica';
  races: Array<Record<string, unknown>>;
  raceResults: Array<Record<string, unknown>>;
  qualifyingResults: Array<Record<string, unknown>>;
  drivers: Array<Record<string, unknown>>;
  constructors: Array<Record<string, unknown>>;
};

const SUPABASE_URL = Deno.env.get('SUPABASE_URL') || '';
const SUPABASE_KEY =
  Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ||
  Deno.env.get('SUPABASE_ANON_KEY') ||
  '';
const GROQ_API_KEY = Deno.env.get('GROQ_API_KEY') || '';
const GROQ_MODEL = Deno.env.get('GROQ_MODEL') || 'openai/gpt-oss-20b';
const RATE_LIMIT_PER_MINUTE = clampInt(Deno.env.get('CHAT_RATE_LIMIT_PER_MINUTE'), 5, 1, 30);

const JOLPICA_BASE = 'https://api.jolpi.ca/ergast/f1';
const GROQ_CHAT_COMPLETIONS_URL = 'https://api.groq.com/openai/v1/chat/completions';
const RATE_LIMIT_RPC = 'increment_chat_rate_limit';
const MIN_YEAR = 2000;
const CURRENT_YEAR = new Date().getUTCFullYear();
const YEAR_PATTERN = /\b(20\d{2})\b/;
const NON_F1_REPLY =
  "I'm only knowledgeable about F1, so for anything else I can't help. My paddock pass only gets me into the Formula 1 garage.";
const SITE_AUTHOR_REPLY =
  'This site was built by Sudip Shrestha, a Data Analyst and AI Engineer based in Canada. If you want the developer background, the About Us page has the full details.';
const archiveCache = new Map<number, { expiresAt: number; data: SeasonData }>();
const liveCache = new Map<number, { expiresAt: number; data: SeasonData }>();
const rateBuckets = new Map<string, number[]>();

class GroqRateLimitError extends Error {
  constructor() {
    super('GroqRateLimitError');
    this.name = 'GroqRateLimitError';
  }
}

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Content-Type': 'application/json; charset=utf-8',
};

const TOOL_DEFINITIONS = [
  createFunctionTool(
    'lookup_race_result',
    'Looks up a race in a specific season and returns the winner plus podium details when available. Use for winner questions and race follow-ups.',
    {
      type: 'object',
      additionalProperties: false,
      required: ['year', 'race_query'],
      properties: {
        year: { type: 'integer', minimum: MIN_YEAR, maximum: CURRENT_YEAR },
        race_query: { type: 'string' },
      },
    },
  ),
  createFunctionTool(
    'lookup_driver_season',
    'Returns a driver summary for one season including final standing, wins, podiums, poles, and fastest laps.',
    {
      type: 'object',
      additionalProperties: false,
      required: ['year', 'driver_query'],
      properties: {
        year: { type: 'integer', minimum: MIN_YEAR, maximum: CURRENT_YEAR },
        driver_query: { type: 'string' },
      },
    },
  ),
  createFunctionTool(
    'lookup_constructor_season',
    'Returns a constructor summary for one season including final standing, points, and wins.',
    {
      type: 'object',
      additionalProperties: false,
      required: ['year', 'team_query'],
      properties: {
        year: { type: 'integer', minimum: MIN_YEAR, maximum: CURRENT_YEAR },
        team_query: { type: 'string' },
      },
    },
  ),
  createFunctionTool(
    'lookup_qualifying_result',
    'Looks up a qualifying session in one season and returns the pole sitter plus top qualifiers and lap times when available.',
    {
      type: 'object',
      additionalProperties: false,
      required: ['year', 'race_query'],
      properties: {
        year: { type: 'integer', minimum: MIN_YEAR, maximum: CURRENT_YEAR },
        race_query: { type: 'string' },
      },
    },
  ),
  createFunctionTool(
    'lookup_standings',
    'Returns driver or constructor standings for one season. Use when the user asks about championship position or asks for leaders.',
    {
      type: 'object',
      additionalProperties: false,
      required: ['year', 'championship'],
      properties: {
        year: { type: 'integer', minimum: MIN_YEAR, maximum: CURRENT_YEAR },
        championship: { type: 'string', enum: ['drivers', 'constructors'] },
        subject_query: { type: 'string' },
        limit: { type: 'integer', minimum: 1, maximum: 10 },
      },
    },
  ),
];

const db = createClient(SUPABASE_URL, SUPABASE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});

Deno.serve(async request => {
  if (request.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders });
  }

  if (request.method !== 'POST') {
    return jsonResponse({ error: 'Method not allowed' }, 405);
  }

  if (!SUPABASE_URL || !SUPABASE_KEY || !GROQ_API_KEY) {
    return jsonResponse({ error: 'Missing required edge function secrets.' }, 500);
  }

  if (!(await checkRateLimit(request))) {
    return jsonResponse(
      { error: 'Rate limit exceeded. Please wait a minute before sending another question.' },
      429,
    );
  }

  try {
    const body = await request.json();
    const input = validateRequest(body);

    const developerReply = maybeHandleDeveloperQuestion(input.messages, input.resolvedContext);
    if (developerReply) {
      return jsonResponse(developerReply);
    }

    if (!isF1DomainQuestion(input.messages, input.resolvedContext)) {
      return jsonResponse({
        answer: NON_F1_REPLY,
        sources: [],
        resolvedContext: normalizeResolvedContext(input.resolvedContext),
        suggestions: [
          'Who won in Canada in 2018?',
          `Who is leading the ${CURRENT_YEAR} drivers championship?`,
        ],
      });
    }

    const ongoingSeasonReply = await maybeHandleCurrentSeasonStandingsQuestion(
      input.messages,
      input.resolvedContext,
      input.selectedSeason,
    );
    if (ongoingSeasonReply) {
      return jsonResponse(ongoingSeasonReply);
    }

    const result = await runChat(input.messages, input.resolvedContext, input.selectedSeason);
    return jsonResponse(result);
  } catch (error) {
    if (error instanceof GroqRateLimitError) {
      return jsonResponse({
        answer: 'The chat assistant is a little busy right now. Please try again in a moment.',
        sources: [],
        suggestions: [
          'Who won in Canada in 2018?',
          `Who is leading the ${CURRENT_YEAR} drivers championship?`,
        ],
      });
    }
    console.error('chat error', error);
    return jsonResponse(
      {
        error:
          error instanceof Error
            ? error.message
            : 'Unexpected error while generating a response.',
      },
      500,
    );
  }
});

async function runChat(
  messages: ChatMessage[],
  resolvedContext: ResolvedContext,
  selectedSeason: number,
) {
  const conversation: Array<Record<string, unknown>> = [
    {
      role: 'system',
      content: buildInstructions(resolvedContext, selectedSeason),
    },
    ...messages.map(message => ({
      role: message.role,
      content: message.content,
    })),
  ];

  const collectedSources: SourceItem[] = [];
  let fallbackContext = normalizeResolvedContext(resolvedContext);

  for (let iteration = 0; iteration < 4; iteration += 1) {
    conversation[0] = {
      role: 'system',
      content: buildInstructions(fallbackContext, selectedSeason),
    };

    const response = await createGroqChatCompletion({
      model: GROQ_MODEL,
      messages: conversation,
      tools: TOOL_DEFINITIONS,
      tool_choice: 'auto',
      temperature: 0.2,
      max_completion_tokens: 700,
    });

    const message = response?.choices?.[0]?.message || {};
    const toolCalls = Array.isArray(message.tool_calls) ? message.tool_calls : [];

    if (!toolCalls.length) {
      return buildChatEnvelope(String(message.content || ''), collectedSources, fallbackContext);
    }

    conversation.push({
      role: 'assistant',
      content: message.content || '',
      tool_calls: toolCalls,
    });

    for (const toolCall of toolCalls) {
      const callId = String(toolCall.id || '');
      const name = String(toolCall.function?.name || '');
      const args = safeParseJson(String(toolCall.function?.arguments || '{}'));
      const result = await executeTool(name, args);

      if (Array.isArray(result.provenance)) {
        collectedSources.push(...result.provenance.slice(0, 3));
      }

      if (result.resolvedContext) {
        fallbackContext = mergeContext(fallbackContext, result.resolvedContext);
      }

      conversation.push({
        role: 'tool',
        tool_call_id: callId,
        content: JSON.stringify(result),
      });
    }
  }

  throw new Error('The chat tool loop did not converge.');
}

async function executeTool(name: string, args: Record<string, unknown>) {
  switch (name) {
    case 'lookup_race_result':
      return lookupRaceResult(args);
    case 'lookup_driver_season':
      return lookupDriverSeason(args);
    case 'lookup_constructor_season':
      return lookupConstructorSeason(args);
    case 'lookup_qualifying_result':
      return lookupQualifyingResult(args);
    case 'lookup_standings':
      return lookupStandings(args);
    default:
      return {
        ok: false,
        error: `Unsupported tool: ${name}`,
        provenance: [],
        resolvedContext: defaultResolvedContext(),
      };
  }
}

async function lookupRaceResult(args: Record<string, unknown>) {
  const year = validateYear(args.year);
  const raceQuery = toShortString(args.race_query, 80);
  const season = await getSeasonData(year);
  const match = findBestRace(season.races, raceQuery);

  if (!match.item) {
    return {
      ok: false,
      error: `No clear race match found for "${raceQuery}" in ${year}.`,
      candidates: match.candidates,
      provenance: [],
      resolvedContext: buildContext({ year, source: season.source }),
    };
  }

  const round = toInt(match.item.round);
  const podium = season.raceResults
    .filter(result => toInt(result.round) === round && toInt(result.pos) >= 1 && toInt(result.pos) <= 3)
    .sort((a, b) => toInt(a.pos) - toInt(b.pos))
    .map(result => ({
      pos: toInt(result.pos),
      driver: String(result.name || '—'),
      team: String(result.team || '—'),
    }));

  const winner = podium.find(entry => entry.pos === 1) || {
    pos: 1,
    driver: String(match.item.winner || '—'),
    team: String(match.item.team || '—'),
  };

  return {
    ok: true,
    season: year,
    source: season.source,
    race: {
      round,
      name: String(match.item.name || '—'),
      country: String(match.item.country || ''),
      circuit: String(match.item.circuit || ''),
      date: String(match.item.date || ''),
    },
    winner,
    podium,
    provenance: [
      {
        label: `${year} ${String(match.item.name || 'Race')}`,
        sourceType: season.source,
        season: year,
        detail: `${sourceLabel(season.source)} race result`,
      },
    ],
    resolvedContext: buildContext({
      year,
      driverName: winner.driver,
      raceName: String(match.item.name || ''),
      teamName: winner.team,
      round,
      source: season.source,
    }),
  };
}

async function lookupDriverSeason(args: Record<string, unknown>) {
  const year = validateYear(args.year);
  const driverQuery = toShortString(args.driver_query, 80);
  const season = await getSeasonData(year);
  const match = findBestDriver(season.drivers, driverQuery);

  if (!match.item) {
    return {
      ok: false,
      error: `No clear driver match found for "${driverQuery}" in ${year}.`,
      candidates: match.candidates,
      provenance: [],
      resolvedContext: buildContext({ year, source: season.source }),
    };
  }

  const code = String(match.item.code || '');
  const name = String(match.item.name || '—');
  const podiums = season.raceResults.filter(result => sameDriver(result, name, code) && toInt(result.pos) <= 3).length;
  const poles = season.qualifyingResults.filter(result => sameDriver(result, name, code) && toInt(result.pos) === 1).length;
  const fastestLaps = season.raceResults.filter(result => sameDriver(result, name, code) && Boolean(result.fastest_lap)).length;

  return {
    ok: true,
    season: year,
    source: season.source,
    driver: {
      name,
      code,
      team: String(match.item.team || '—'),
      nationality: String(match.item.nat || ''),
      standing: toInt(match.item.pos),
      points: toFloat(match.item.points),
      wins: toInt(match.item.wins),
      podiums,
      poles,
      fastestLaps,
    },
    provenance: [
      {
        label: `${year} ${name}`,
        sourceType: season.source,
        season: year,
        detail: `${sourceLabel(season.source)} driver season summary`,
      },
    ],
    resolvedContext: buildContext({
      year,
      driverName: name,
      teamName: String(match.item.team || ''),
      source: season.source,
    }),
  };
}

async function lookupConstructorSeason(args: Record<string, unknown>) {
  const year = validateYear(args.year);
  const teamQuery = toShortString(args.team_query, 80);
  const season = await getSeasonData(year);
  const match = findBestConstructor(season.constructors, teamQuery);

  if (!match.item) {
    return {
      ok: false,
      error: `No clear constructor match found for "${teamQuery}" in ${year}.`,
      candidates: match.candidates,
      provenance: [],
      resolvedContext: buildContext({ year, source: season.source }),
    };
  }

  return {
    ok: true,
    season: year,
    source: season.source,
    constructor: {
      team: String(match.item.team || '—'),
      standing: toInt(match.item.pos),
      points: toFloat(match.item.points),
      wins: toInt(match.item.wins),
    },
    provenance: [
      {
        label: `${year} ${String(match.item.team || 'Constructor')}`,
        sourceType: season.source,
        season: year,
        detail: `${sourceLabel(season.source)} constructor season summary`,
      },
    ],
    resolvedContext: buildContext({
      year,
      teamName: String(match.item.team || ''),
      source: season.source,
    }),
  };
}

async function lookupQualifyingResult(args: Record<string, unknown>) {
  const year = validateYear(args.year);
  const raceQuery = toShortString(args.race_query, 80);
  const season = await getSeasonData(year);
  const match = findBestRace(season.races, raceQuery);

  if (!match.item) {
    return {
      ok: false,
      error: `No clear race match found for "${raceQuery}" in ${year}.`,
      candidates: match.candidates,
      provenance: [],
      resolvedContext: buildContext({ year, source: season.source }),
    };
  }

  const round = toInt(match.item.round);
  const topQualifiers = season.qualifyingResults
    .filter(result => toInt(result.round) === round && toInt(result.pos) >= 1 && toInt(result.pos) <= 3)
    .sort((a, b) => toInt(a.pos) - toInt(b.pos))
    .map(result => ({
      pos: toInt(result.pos),
      driver: String(result.name || '—'),
      team: String(result.team || '—'),
      q1: String(result.q1 || ''),
      q2: String(result.q2 || ''),
      q3: String(result.q3 || ''),
      bestLap: String(result.q3 || result.q2 || result.q1 || ''),
    }));

  const pole = topQualifiers[0];
  return {
    ok: true,
    season: year,
    source: season.source,
    race: {
      round,
      name: String(match.item.name || '—'),
      date: String(match.item.date || ''),
    },
    pole,
    topQualifiers,
    provenance: [
      {
        label: `${year} ${String(match.item.name || 'Qualifying')}`,
        sourceType: season.source,
        season: year,
        detail: `${sourceLabel(season.source)} qualifying result`,
      },
    ],
    resolvedContext: buildContext({
      year,
      driverName: pole?.driver || '',
      raceName: String(match.item.name || ''),
      teamName: pole?.team || '',
      round,
      source: season.source,
    }),
  };
}

async function lookupStandings(args: Record<string, unknown>) {
  const year = validateYear(args.year);
  const championship = String(args.championship || '');
  const subjectQuery = toShortString(args.subject_query, 80);
  const limit = clampInt(args.limit, 3, 1, 10);
  const season = await getSeasonData(year);

  if (championship !== 'drivers' && championship !== 'constructors') {
    return {
      ok: false,
      error: 'Standings lookups must target drivers or constructors.',
      provenance: [],
      resolvedContext: buildContext({ year, source: season.source }),
    };
  }

  if (championship === 'drivers') {
    if (subjectQuery) {
      const match = findBestDriver(season.drivers, subjectQuery);
      if (!match.item) {
        return {
          ok: false,
          error: `No clear driver match found for "${subjectQuery}" in ${year}.`,
          candidates: match.candidates,
          provenance: [],
          resolvedContext: buildContext({ year, source: season.source }),
        };
      }

      return {
        ok: true,
        season: year,
        source: season.source,
        championship,
        subject: {
          name: String(match.item.name || '—'),
          standing: toInt(match.item.pos),
          points: toFloat(match.item.points),
          wins: toInt(match.item.wins),
          team: String(match.item.team || '—'),
        },
        provenance: [
          {
            label: `${year} driver standings`,
            sourceType: season.source,
            season: year,
            detail: `${sourceLabel(season.source)} driver standings`,
          },
        ],
        resolvedContext: buildContext({
          year,
          driverName: String(match.item.name || ''),
          teamName: String(match.item.team || ''),
          source: season.source,
        }),
      };
    }

    return {
      ok: true,
      season: year,
      source: season.source,
      championship,
      leaders: season.drivers.slice(0, limit).map(driver => ({
        pos: toInt(driver.pos),
        name: String(driver.name || '—'),
        team: String(driver.team || '—'),
        points: toFloat(driver.points),
        wins: toInt(driver.wins),
      })),
      provenance: [
        {
          label: `${year} driver standings`,
          sourceType: season.source,
          season: year,
          detail: `${sourceLabel(season.source)} driver standings`,
        },
      ],
      resolvedContext: buildContext({ year, source: season.source }),
    };
  }

  if (subjectQuery) {
    const match = findBestConstructor(season.constructors, subjectQuery);
    if (!match.item) {
      return {
        ok: false,
        error: `No clear constructor match found for "${subjectQuery}" in ${year}.`,
        candidates: match.candidates,
        provenance: [],
        resolvedContext: buildContext({ year, source: season.source }),
      };
    }

    return {
      ok: true,
      season: year,
      source: season.source,
      championship: 'constructors',
      subject: {
        team: String(match.item.team || '—'),
        standing: toInt(match.item.pos),
        points: toFloat(match.item.points),
        wins: toInt(match.item.wins),
      },
      provenance: [
        {
          label: `${year} constructor standings`,
          sourceType: season.source,
          season: year,
          detail: `${sourceLabel(season.source)} constructor standings`,
        },
      ],
      resolvedContext: buildContext({
        year,
        teamName: String(match.item.team || ''),
        source: season.source,
      }),
    };
  }

  return {
    ok: true,
    season: year,
    source: season.source,
    championship: 'constructors',
    leaders: season.constructors.slice(0, limit).map(team => ({
      pos: toInt(team.pos),
      team: String(team.team || '—'),
      points: toFloat(team.points),
      wins: toInt(team.wins),
    })),
    provenance: [
      {
        label: `${year} constructor standings`,
        sourceType: season.source,
        season: year,
        detail: `${sourceLabel(season.source)} constructor standings`,
      },
    ],
    resolvedContext: buildContext({ year, source: season.source }),
  };
}

async function getSeasonData(year: number) {
  if (year < MIN_YEAR || year > CURRENT_YEAR) {
    throw new Error(`This chat only supports seasons from ${MIN_YEAR} to ${CURRENT_YEAR}.`);
  }

  if (year === CURRENT_YEAR) {
    const cached = liveCache.get(year);
    if (cached && cached.expiresAt > Date.now()) return cached.data;
    const data = await loadLiveSeason(year);
    liveCache.set(year, { expiresAt: Date.now() + 60_000, data });
    return data;
  }

  const cached = archiveCache.get(year);
  if (cached && cached.expiresAt > Date.now()) return cached.data;
  const data = await loadArchiveSeason(year);
  archiveCache.set(year, { expiresAt: Date.now() + 5 * 60_000, data });
  return data;
}

async function loadArchiveSeason(year: number): Promise<SeasonData> {
  const [racesRes, resultsRes, qualifyingRes, driversRes, constructorsRes] = await Promise.all([
    db.from('races').select('*').eq('year', year).order('round'),
    db.from('race_results').select('*').eq('year', year).order('round').order('pos'),
    db.from('qualifying_results').select('*').eq('year', year).order('round').order('pos'),
    db.from('driver_standings').select('*').eq('year', year).order('pos'),
    db.from('constructor_standings').select('*').eq('year', year).order('pos'),
  ]);

  const errors = [racesRes.error, resultsRes.error, qualifyingRes.error, driversRes.error, constructorsRes.error]
    .filter(Boolean)
    .map(error => error?.message || 'Unknown Supabase error');

  if (errors.length) {
    throw new Error(`Supabase season query failed: ${errors.join('; ')}`);
  }

  return {
    year,
    source: 'supabase',
    races: racesRes.data || [],
    raceResults: resultsRes.data || [],
    qualifyingResults: qualifyingRes.data || [],
    drivers: driversRes.data || [],
    constructors: constructorsRes.data || [],
  };
}

async function loadLiveSeason(year: number): Promise<SeasonData> {
  const [rawRaces, rawQualifying, driverStandings, constructorStandings] = await Promise.all([
    fetchLiveRaceResults(year),
    fetchLiveQualifying(year),
    fetchLiveDriverStandings(year),
    fetchLiveConstructorStandings(year),
  ]);

  const races = rawRaces.map(race => {
    const winner = race.Results?.[0];
    return {
      year,
      round: toInt(race.round),
      name: String(race.raceName || '').replace(' Grand Prix', ' GP'),
      circuit: String(race.Circuit?.circuitName || ''),
      country: String(race.Circuit?.Location?.country || ''),
      date: String(race.date || ''),
      winner: winner
        ? `${String(winner.Driver?.givenName || '')} ${String(winner.Driver?.familyName || '')}`.trim()
        : '—',
      team: String(winner?.Constructor?.name || '—'),
      grid: toInt(winner?.grid),
      laps: toInt(winner?.laps),
      time: String(winner?.Time?.time || winner?.status || '—'),
    };
  });

  const raceResults = rawRaces.flatMap(race =>
    (race.Results || []).map((result: Record<string, unknown>) => ({
      year,
      round: toInt(race.round),
      pos: toInt(result.position, 99),
      name: `${String(result.Driver?.givenName || '')} ${String(result.Driver?.familyName || '')}`.trim(),
      code: String(result.Driver?.code || ''),
      team: String(result.Constructor?.name || '—'),
      grid: toInt(result.grid),
      points: toFloat(result.points),
      fastest_lap: String(result.FastestLap?.rank || '') === '1',
    })),
  );

  const qualifyingResults = rawQualifying.flatMap(race =>
    (race.QualifyingResults || []).map((result: Record<string, unknown>) => ({
      year,
      round: toInt(race.round),
      pos: toInt(result.position),
      name: `${String(result.Driver?.givenName || '')} ${String(result.Driver?.familyName || '')}`.trim(),
      code: String(result.Driver?.code || ''),
      team: String(result.Constructor?.name || '—'),
      q1: String(result.Q1 || ''),
      q2: String(result.Q2 || ''),
      q3: String(result.Q3 || ''),
    })),
  );

  const drivers = (driverStandings.MRData?.StandingsTable?.StandingsLists?.[0]?.DriverStandings || []).map(
    (standing: Record<string, unknown>) => ({
      year,
      pos: toInt(standing.position),
      name: `${String(standing.Driver?.givenName || '')} ${String(standing.Driver?.familyName || '')}`.trim(),
      code: String(standing.Driver?.code || ''),
      nat: String(standing.Driver?.nationality || ''),
      team: String(standing.Constructors?.[0]?.name || '—'),
      points: toFloat(standing.points),
      wins: toInt(standing.wins),
    }),
  );

  const constructors =
    (constructorStandings.MRData?.StandingsTable?.StandingsLists?.[0]?.ConstructorStandings || []).map(
      (standing: Record<string, unknown>) => ({
        year,
        pos: toInt(standing.position),
        team: String(standing.Constructor?.name || '—'),
        points: toFloat(standing.points),
        wins: toInt(standing.wins),
      }),
    );

  return {
    year,
    source: 'jolpica',
    races,
    raceResults,
    qualifyingResults,
    drivers,
    constructors,
  };
}

async function fetchLiveRaceResults(year: number) {
  const first = await jolpicaFetch(`${year}/results/?limit=30&offset=0`);
  const total = toInt(first.MRData?.total);
  const pages = [first];

  for (let offset = 30; offset < total; offset += 30) {
    pages.push(await jolpicaFetch(`${year}/results/?limit=30&offset=${offset}`));
  }

  return mergeJolpicaRacePages(pages, 'Results');
}

async function fetchLiveQualifying(year: number) {
  const first = await jolpicaFetch(`${year}/qualifying/?limit=30&offset=0`);
  const total = toInt(first.MRData?.total);
  const pages = [first];

  for (let offset = 30; offset < total; offset += 30) {
    pages.push(await jolpicaFetch(`${year}/qualifying/?limit=30&offset=${offset}`));
  }

  return mergeJolpicaRacePages(pages, 'QualifyingResults');
}

async function fetchLiveDriverStandings(year: number) {
  return jolpicaFetch(`${year}/driverstandings/`);
}

async function fetchLiveConstructorStandings(year: number) {
  return jolpicaFetch(`${year}/constructorstandings/`);
}

async function jolpicaFetch(path: string, attempt = 0): Promise<Record<string, unknown>> {
  const response = await fetch(`${JOLPICA_BASE}/${path}`);
  if (response.status === 429) {
    if (attempt >= 3) throw new Error(`Jolpica rate limit exceeded for ${path}`);
    await new Promise(resolve => setTimeout(resolve, Math.pow(2, attempt) * 1000));
    return jolpicaFetch(path, attempt + 1);
  }
  if (!response.ok) {
    throw new Error(`Jolpica request failed for ${path}: ${response.status}`);
  }
  return response.json();
}

async function createGroqChatCompletion(payload: Record<string, unknown>) {
  const response = await fetch(GROQ_CHAT_COMPLETIONS_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${GROQ_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(payload),
  });

  const data = await response.json().catch(() => ({}));
  if (response.status === 429) throw new GroqRateLimitError();
  if (!response.ok) {
    const message = data?.error?.message || 'Groq request failed.';
    throw new Error(message);
  }
  return data;
}

function createFunctionTool(
  name: string,
  description: string,
  parameters: Record<string, unknown>,
) {
  return {
    type: 'function',
    name,
    description,
    parameters,
    function: {
      name,
      description,
      parameters,
    },
  };
}

function mergeJolpicaRacePages(
  pages: Array<Record<string, unknown>>,
  resultKey: 'Results' | 'QualifyingResults',
) {
  const byRound = new Map<number, Record<string, unknown>>();

  for (const page of pages) {
    const races = Array.isArray(page.MRData?.RaceTable?.Races)
      ? page.MRData.RaceTable.Races
      : [];

    for (const race of races) {
      const round = toInt(race.round);
      if (!round) continue;

      const resultRows = Array.isArray(race[resultKey]) ? race[resultKey] : [];
      const existing = byRound.get(round);

      if (!existing) {
        byRound.set(round, {
          ...race,
          [resultKey]: [...resultRows],
        });
        continue;
      }

      existing[resultKey] = [
        ...(Array.isArray(existing[resultKey]) ? existing[resultKey] : []),
        ...resultRows,
      ];

      if (!existing.raceName && race.raceName) existing.raceName = race.raceName;
      if (!existing.date && race.date) existing.date = race.date;
      if (!existing.Circuit && race.Circuit) existing.Circuit = race.Circuit;
    }
  }

  return Array.from(byRound.values()).sort((left, right) => toInt(left.round) - toInt(right.round));
}

function buildInstructions(resolvedContext: ResolvedContext, selectedSeason: number) {
  return [
    'You are the F1 Analytics chat assistant for a public Formula 1 dashboard.',
    `Coverage is limited to seasons ${MIN_YEAR} through ${CURRENT_YEAR}.`,
    'Archive seasons use Supabase data. The current season uses Jolpica live data.',
    'Use the available tools for factual lookups about race winners, standings, qualifying, drivers, teams, and season totals.',
    'Answer only with facts supported by tool results from this request.',
    'If a question is ambiguous, ask a concise clarification instead of guessing.',
    'Do not treat selectedSeason as an explicit year unless the user refers to the current dashboard view, "this season", or similar wording.',
    'If the user asks for data outside coverage or for unsupported domains, say so directly.',
    'Pit stop data, lap-by-lap timing, and other missing metrics are unavailable unless a tool returns them.',
    'Keep answers concise and factual, but use complete sentences.',
    'Answer in 1 to 3 plain-text sentences.',
    'Directly answer the question in the first sentence.',
    'Do not answer with only a name, number, fragment, or standalone list item unless the user explicitly asks for that format.',
    'Use plain text only. Do not use markdown, bold, italics, headings, code fences, or bullet syntax that relies on markdown markers.',
    'Never mention internal tools, JSON, schemas, or hidden reasoning.',
    `Selected dashboard season: ${selectedSeason || 0}.`,
    `Current resolved context: ${JSON.stringify(normalizeResolvedContext(resolvedContext))}.`,
  ].join('\n');
}

function buildChatEnvelope(rawOutput: string, collectedSources: SourceItem[], fallbackContext: ResolvedContext) {
  return {
    answer: typeof rawOutput === 'string' && rawOutput.trim()
      ? normalizePlainTextAnswer(rawOutput)
      : 'I could not produce a grounded answer for that question.',
    sources: dedupeSources(collectedSources).slice(0, 3),
    resolvedContext: fallbackContext,
    suggestions: buildSuggestions(fallbackContext),
  };
}

function normalizePlainTextAnswer(rawOutput: string) {
  return String(rawOutput || '')
    .replace(/\r\n/g, '\n')
    .replace(/\*\*(.*?)\*\*/g, '$1')
    .replace(/__(.*?)__/g, '$1')
    .replace(/\*(.*?)\*/g, '$1')
    .replace(/_(.*?)_/g, '$1')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '$1 ($2)')
    .replace(/^\s{0,3}#{1,6}\s+/gm, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function buildSuggestions(context: ResolvedContext) {
  const suggestions: string[] = [];

  if (context.raceName && context.year) {
    suggestions.push(`Who got pole for ${context.raceName} in ${context.year}?`);
    suggestions.push(`Who finished on the podium in ${context.raceName} in ${context.year}?`);
  }

  if (context.driverName && context.year) {
    suggestions.push(`How many wins did ${context.driverName} have in ${context.year}?`);
    suggestions.push(`What was ${context.driverName}'s final standing in ${context.year}?`);
  }

  if (context.teamName && context.year) {
    suggestions.push(`How many wins did ${context.teamName} have in ${context.year}?`);
  }

  if (context.year) {
    suggestions.push(`Who won the drivers championship in ${context.year}?`);
  }

  suggestions.push('Who won in Canada in 2018?');
  suggestions.push(`Who is leading the ${CURRENT_YEAR} drivers championship?`);

  const unique = Array.from(
    new Set(
      suggestions
        .map(suggestion => toShortString(suggestion, 120))
        .filter(Boolean),
    ),
  );

  return unique.slice(0, 3);
}

function normalizeResolvedContext(context: unknown): ResolvedContext {
  const source = typeof (context as Record<string, unknown>)?.source === 'string'
    && ['supabase', 'jolpica'].includes(String((context as Record<string, unknown>).source))
    ? (context as Record<string, unknown>).source as 'supabase' | 'jolpica'
    : 'unknown';

  return {
    year: clampInt((context as Record<string, unknown>)?.year, 0, 0, CURRENT_YEAR),
    driverName: toShortString((context as Record<string, unknown>)?.driverName, 120),
    raceName: toShortString((context as Record<string, unknown>)?.raceName, 120),
    teamName: toShortString((context as Record<string, unknown>)?.teamName, 120),
    round: clampInt((context as Record<string, unknown>)?.round, 0, 0, 99),
    source,
  };
}

function mergeContext(base: ResolvedContext, next: ResolvedContext) {
  return {
    year: next.year || base.year,
    driverName: next.driverName || base.driverName,
    raceName: next.raceName || base.raceName,
    teamName: next.teamName || base.teamName,
    round: next.round || base.round,
    source: next.source !== 'unknown' ? next.source : base.source,
  };
}

function buildContext(partial: Partial<ResolvedContext>): ResolvedContext {
  return mergeContext(defaultResolvedContext(), normalizeResolvedContext(partial));
}

function defaultResolvedContext(): ResolvedContext {
  return {
    year: 0,
    driverName: '',
    raceName: '',
    teamName: '',
    round: 0,
    source: 'unknown',
  };
}

async function maybeHandleCurrentSeasonStandingsQuestion(
  messages: ChatMessage[],
  context: ResolvedContext,
  selectedSeason: number,
) {
  const lastMessage = messages[messages.length - 1];
  if (!lastMessage) {
    return null;
  }

  const normalizedQuestion = normalizeText(lastMessage.content);
  const championship = normalizedQuestion.includes('constructor') || normalizedQuestion.includes('team')
    ? 'constructors'
    : 'drivers';

  if (!isCurrentSeasonStandingsQuestion(normalizedQuestion, context, selectedSeason, championship)) {
    return null;
  }

  const standings = await lookupStandings({
    year: CURRENT_YEAR,
    championship,
    limit: 1,
  });

  if (!standings?.ok || !Array.isArray(standings.leaders) || !standings.leaders.length) {
    const fallbackContext = buildContext({ year: CURRENT_YEAR, source: 'jolpica' });
    const championshipLabel = championship === 'constructors' ? 'constructor' : 'driver';
    return {
      answer: `The ${CURRENT_YEAR} season is still ongoing, and the live ${championshipLabel} championship leader is unavailable right now.`,
      sources: [],
      resolvedContext: fallbackContext,
      suggestions: buildSuggestions(fallbackContext),
    };
  }

  const leader = standings.leaders[0] as Record<string, unknown>;
  const leaderName = championship === 'constructors'
    ? String(leader.team || 'the current constructor standings leader')
    : String(leader.name || 'the current driver standings leader');
  const teamName = String(leader.team || 'their team');
  const points = formatStatNumber(toFloat(leader.points));
  const wins = toInt(leader.wins);
  const nextContext = buildContext({
    year: CURRENT_YEAR,
    driverName: championship === 'drivers' ? leaderName : '',
    teamName: championship === 'constructors' ? leaderName : teamName,
    source: 'jolpica',
  });
  const asksWinner = isCurrentSeasonWinnerQuestion(normalizedQuestion);
  const championshipLabel = championship === 'constructors' ? 'constructors' : 'drivers';

  return {
    answer: asksWinner
      ? championship === 'constructors'
        ? `The ${CURRENT_YEAR} constructors championship is still ongoing and is currently led by ${leaderName} with ${points} points and ${wins} win${wins === 1 ? '' : 's'}.`
        : `The ${CURRENT_YEAR} drivers championship is still ongoing and is currently led by ${leaderName} for ${teamName} with ${points} points and ${wins} win${wins === 1 ? '' : 's'}.`
      : championship === 'constructors'
        ? `The ${CURRENT_YEAR} constructors championship is currently led by ${leaderName} with ${points} points and ${wins} win${wins === 1 ? '' : 's'}.`
        : `The ${CURRENT_YEAR} ${championshipLabel} championship is currently led by ${leaderName} for ${teamName} with ${points} points and ${wins} win${wins === 1 ? '' : 's'}.`,
    sources: dedupeSources(Array.isArray(standings.provenance) ? standings.provenance : []).slice(0, 3),
    resolvedContext: nextContext,
    suggestions: buildSuggestions(nextContext),
  };
}

function maybeHandleDeveloperQuestion(messages: ChatMessage[], resolvedContext: ResolvedContext) {
  const lastMessage = messages[messages.length - 1];
  if (!lastMessage) return null;

  if (!isDeveloperQuestion(lastMessage.content)) {
    return null;
  }

  return {
    answer: SITE_AUTHOR_REPLY,
    sources: [],
    resolvedContext: normalizeResolvedContext(resolvedContext),
    suggestions: [
      'Who won in Canada in 2018?',
      `Who is leading the ${CURRENT_YEAR} drivers championship?`,
    ],
  };
}

function validateRequest(body: unknown) {
  if (!body || typeof body !== 'object') {
    throw new Error('Chat request body must be an object.');
  }

  const typedBody = body as Record<string, unknown>;
  const messages = Array.isArray(typedBody.messages)
    ? typedBody.messages
        .map(value => {
          if (!value || typeof value !== 'object') return null;
          const typedValue = value as Record<string, unknown>;
          const role = typedValue.role === 'assistant' ? 'assistant' : typedValue.role === 'user' ? 'user' : '';
          const content = toShortString(typedValue.content, 500);
          if (!role || !content) return null;
          return { role, content } as ChatMessage;
        })
        .filter(Boolean)
        .slice(-8)
    : [];

  if (!messages.length) {
    throw new Error('At least one user message is required.');
  }

  const lastMessage = messages[messages.length - 1];
  if (lastMessage.role !== 'user') {
    throw new Error('The last message in the request must come from the user.');
  }

  return {
    messages,
    resolvedContext: normalizeResolvedContext(typedBody.resolvedContext),
    selectedSeason: clampInt(typedBody.selectedSeason, 0, 0, CURRENT_YEAR),
  };
}

function isF1DomainQuestion(messages: ChatMessage[], context: ResolvedContext) {
  const lastMessage = messages[messages.length - 1];
  const latestQuestion = normalizeText(lastMessage?.content || '');
  if (YEAR_PATTERN.test(latestQuestion)) return true;

  if (containsF1DomainTerms(latestQuestion)) return true;

  return hasResolvedContext(context) && isContextualF1FollowUp(latestQuestion, context);
}

function containsF1DomainTerms(text: string) {
  return [
    'f1',
    'formula 1',
    'grand prix',
    'gp',
    'race',
    'winner',
    'wins',
    'podium',
    'pole',
    'qualifying',
    'constructor',
    'constructors',
    'standings',
    'championship',
    'driver',
    'drivers',
    'team',
    'teammate',
    'grid',
    'lap',
    'points',
    'position',
    'finish',
    'finished',
    'circuit',
    'country',
    'date',
    'season',
  ].some(term => text.includes(normalizeText(term)));
}

function isCurrentSeasonStandingsQuestion(
  normalizedQuestion: string,
  context: ResolvedContext,
  selectedSeason: number,
  championship: 'drivers' | 'constructors',
) {
  const asksSeasonWinner = isCurrentSeasonWinnerQuestion(normalizedQuestion);
  const asksSeasonLeader =
    normalizedQuestion.includes('who is leading')
    || normalizedQuestion.includes('who leads')
    || normalizedQuestion.includes('leader')
    || normalizedQuestion.includes('lead the standings')
    || normalizedQuestion.includes('top of the standings')
    || normalizedQuestion.includes('leading the standings');
  const asksStandings =
    normalizedQuestion.includes('standings')
    || normalizedQuestion.includes('championship');

  if (!asksSeasonWinner && !(asksSeasonLeader && asksStandings)) return false;

  const referencesRace = [
    'gp',
    'grand prix',
    'race',
    'round',
    'podium',
    'pole',
    'qualifying',
    'circuit',
  ].some(term => normalizedQuestion.includes(normalizeText(term)));

  if (referencesRace) return false;

  const referencesPastYear = Array.from(normalizedQuestion.matchAll(/\b20\d{2}\b/g))
    .map(match => toInt(match[0]))
    .some(year => year >= MIN_YEAR && year < CURRENT_YEAR);

  if (referencesPastYear) return false;

  const referencesExplicitCurrentSeason =
    normalizedQuestion.includes(String(CURRENT_YEAR))
    || normalizedQuestion.includes('this season')
    || normalizedQuestion.includes('current season')
    || normalizedQuestion.includes('this year')
    || normalizedQuestion.includes('ongoing season');

  const mentionsExpectedTable = championship === 'constructors'
    ? !normalizedQuestion.includes('driver')
    : !normalizedQuestion.includes('constructor') && !normalizedQuestion.includes('team standings');

  if (!mentionsExpectedTable) return false;

  if (referencesExplicitCurrentSeason) {
    return normalizedQuestion.includes('this season')
      ? selectedSeason === CURRENT_YEAR || context.year === CURRENT_YEAR
      : true;
  }

  if (selectedSeason === CURRENT_YEAR) return true;

  return context.year === CURRENT_YEAR
    && (normalizedQuestion.includes('that season') || normalizedQuestion.includes('that year'));
}

function isCurrentSeasonWinnerQuestion(normalizedQuestion: string) {
  return normalizedQuestion.includes('who won')
    || normalizedQuestion.includes('winner')
    || normalizedQuestion.includes('who is champion')
    || normalizedQuestion.includes('who won the championship');
}

function hasResolvedContext(context: ResolvedContext) {
  return Boolean(context.year || context.driverName || context.teamName || context.raceName || context.round);
}

function isContextualF1FollowUp(question: string, context: ResolvedContext) {
  if (!question) return false;

  const tokens = tokenize(question);
  const hasReferenceCue =
    /^(and|what about|how about)\b/.test(question)
    || tokens.some(token => ['he', 'his', 'him', 'she', 'her', 'they', 'their', 'them', 'it', 'its', 'that', 'this', 'same'].includes(token))
    || ['that season', 'that year', 'that race', 'that team', 'that driver', 'that constructor'].some(
      phrase => question.includes(phrase),
    );

  if (!hasReferenceCue) return false;

  if (containsF1DomainTerms(question)) return true;

  if (context.raceName && ['where', 'when', 'date', 'country', 'circuit'].some(term => tokens.includes(term))) {
    return true;
  }

  if (context.driverName && ['team', 'from', 'nationality'].some(term => tokens.includes(term))) {
    return true;
  }

  return false;
}

function isDeveloperQuestion(question: string) {
  const normalized = normalizeText(question);

  // Attribution nouns are specific enough on their own
  const attributionNouns = ['author', 'developer', 'creator', 'programmer', 'coder'];
  if (attributionNouns.some(w => normalized.includes(w))) return true;

  // Action verbs require a project target to avoid F1 false positives ("who made the fastest lap")
  const actionVerbs = ['built', 'made', 'created', 'developed', 'coded', 'wrote'];
  const projectTargets = ['this site', 'this dashboard', 'this app', 'this page', 'this tool', 'this project', 'this website', 'f1 analytics'];
  return (
    actionVerbs.some(v => normalized.includes(v)) &&
    projectTargets.some(t => normalized.includes(t))
  );
}

function findBestRace(races: Array<Record<string, unknown>>, query: string) {
  return rankRecords(
    races,
    query,
    race => [
      String(race.name || ''),
      String(race.country || ''),
      String(race.circuit || ''),
      String(race.name || '').replace(' GP', ' Grand Prix'),
    ],
    race => String(race.name || 'Unknown race'),
  );
}

function findBestDriver(drivers: Array<Record<string, unknown>>, query: string) {
  return rankRecords(
    drivers,
    query,
    driver => [String(driver.name || ''), String(driver.code || ''), String(driver.team || '')],
    driver => String(driver.name || 'Unknown driver'),
  );
}

function findBestConstructor(constructors: Array<Record<string, unknown>>, query: string) {
  return rankRecords(
    constructors,
    query,
    team => [String(team.team || '')],
    team => String(team.team || 'Unknown team'),
  );
}

function rankRecords<T extends Record<string, unknown>>(
  records: T[],
  query: string,
  getCandidates: (record: T) => string[],
  getLabel: (record: T) => string,
) {
  const normalizedQuery = normalizeText(query);
  const scored = records
    .map(record => ({
      item: record,
      label: getLabel(record),
      score: scoreRecord(normalizedQuery, getCandidates(record)),
    }))
    .sort((left, right) => right.score - left.score);

  const best = scored[0];
  const second = scored[1];
  if (!best || best.score < 20 || (second && best.score < 85 && best.score - second.score < 4)) {
    return {
      item: null,
      candidates: scored.slice(0, 3).map(candidate => candidate.label),
    };
  }

  return {
    item: best.item,
    candidates: scored.slice(0, 3).map(candidate => candidate.label),
  };
}

function scoreRecord(query: string, candidates: string[]) {
  const queryTokens = tokenize(query);
  let bestScore = 0;

  for (const rawCandidate of candidates) {
    const candidate = normalizeText(rawCandidate);
    if (!candidate) continue;

    if (candidate === query) return 120;
    if (candidate.includes(query) || query.includes(candidate)) {
      bestScore = Math.max(bestScore, 100);
    }

    const candidateTokens = tokenize(candidate);
    const overlap = candidateTokens.filter(token => queryTokens.includes(token)).length;
    if (overlap) {
      bestScore = Math.max(
        bestScore,
        overlap * 18 + Math.min(candidateTokens.length, queryTokens.length),
      );
    }
  }

  return bestScore;
}

function tokenize(value: string) {
  return normalizeText(value)
    .split(' ')
    .filter(Boolean);
}

function sameDriver(record: Record<string, unknown>, fullName: string, code: string) {
  const recordName = normalizeText(String(record.name || ''));
  const recordCode = normalizeText(String(record.code || ''));
  return recordCode && code
    ? recordCode === normalizeText(code)
    : recordName === normalizeText(fullName);
}

function normalizeText(value: string) {
  return String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/grand prix/g, 'gp')
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function dedupeSources(sources: SourceItem[]) {
  const seen = new Set<string>();
  return sources.filter(source => {
    const key = `${source.label}|${source.sourceType}|${source.season}|${source.detail}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function getClientIp(request: Request) {
  const forwarded =
    request.headers.get('x-forwarded-for') ||
    request.headers.get('cf-connecting-ip') ||
    request.headers.get('x-real-ip');
  return forwarded?.split(',')[0]?.trim() || '';
}

async function checkRateLimit(request: Request) {
  const identityKey = await buildRateLimitKey(request);
  const bucketIso = new Date(Math.floor(Date.now() / 60_000) * 60_000).toISOString();
  const { data, error } = await db.rpc(RATE_LIMIT_RPC, {
    p_identity_key: identityKey,
    p_bucket_iso: bucketIso,
  });

  if (!error && typeof data === 'number') {
    return data <= RATE_LIMIT_PER_MINUTE;
  }

  console.warn('Shared chat rate limit fallback engaged', error?.message || error);
  return checkInMemoryRateLimit(identityKey);
}

async function buildRateLimitKey(request: Request) {
  const ip = getClientIp(request);
  if (ip) {
    return hashText(`ip:${ip}`);
  }

  const userAgent = request.headers.get('user-agent') || 'unknown-agent';
  const acceptLanguage = request.headers.get('accept-language') || 'unknown-language';
  const origin = request.headers.get('origin') || request.headers.get('referer') || 'unknown-origin';
  return hashText(`fingerprint:${userAgent}|${acceptLanguage}|${origin}`);
}

function checkInMemoryRateLimit(identityKey: string) {
  const now = Date.now();
  const recent = (rateBuckets.get(identityKey) || []).filter(timestamp => now - timestamp < 60_000);
  recent.push(now);
  rateBuckets.set(identityKey, recent);
  return recent.length <= RATE_LIMIT_PER_MINUTE;
}

async function hashText(value: string) {
  const encoded = new TextEncoder().encode(value);
  const digest = await crypto.subtle.digest('SHA-256', encoded);
  return Array.from(new Uint8Array(digest))
    .map(byte => byte.toString(16).padStart(2, '0'))
    .join('');
}

function jsonResponse(payload: Record<string, unknown>, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: corsHeaders,
  });
}

function validateYear(value: unknown) {
  const year = toInt(value);
  if (year < MIN_YEAR || year > CURRENT_YEAR) {
    throw new Error(`This chat only supports seasons from ${MIN_YEAR} to ${CURRENT_YEAR}.`);
  }
  return year;
}

function sourceLabel(source: 'supabase' | 'jolpica') {
  return source === 'supabase' ? 'Supabase archive' : 'Jolpica live season';
}

function safeParseJson(value: string) {
  try {
    return JSON.parse(value);
  } catch (_error) {
    return {};
  }
}

function clampInt(value: unknown, fallback: number, min: number, max: number) {
  const parsed = Number.parseInt(String(value), 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(Math.max(parsed, min), max);
}

function toInt(value: unknown, fallback = 0) {
  const parsed = Number.parseInt(String(value), 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function toFloat(value: unknown, fallback = 0) {
  const parsed = Number.parseFloat(String(value));
  return Number.isFinite(parsed) ? parsed : fallback;
}

function formatStatNumber(value: number) {
  return Number.isInteger(value) ? String(value) : value.toFixed(1).replace(/\.0$/, '');
}

function toShortString(value: unknown, max = 120) {
  return typeof value === 'string' ? value.trim().slice(0, max) : '';
}
