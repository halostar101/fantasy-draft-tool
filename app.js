(() => {
  'use strict';

  const STORAGE = {
    current: 'fantasy-draft-tool:v1:currentDraft',
    mocks: 'fantasy-draft-tool:v1:savedMocks',
    prefs: 'fantasy-draft-tool:v1:prefs'
  };

  const LEAGUES = {
    '12': {
      id: '12',
      name: '12-team • 1 FLEX',
      teams: 12,
      flex: 1,
      bench: 7,
      rosterSlots: ['QB','RB','RB','WR','WR','TE','FLEX','D/ST','K']
    },
    '10': {
      id: '10',
      name: '10-team • 2 FLEX',
      teams: 10,
      flex: 2,
      bench: 7,
      rosterSlots: ['QB','RB','RB','WR','WR','TE','FLEX','FLEX','D/ST','K']
    }
  };

  const SKILL_POSITIONS = new Set(['RB','WR','TE']);
  const BENCH_POSITIONS = new Set(['QB','RB','WR','TE']);
  const ALL_POSITIONS = ['QB','RB','WR','TE','D/ST','K'];
  const MODEL = {
    marketPriorWeight: 0.35,
    benchVorpWeight: 0.22,
    lookaheadCandidateLimit: 48,
    simulationCandidateLimit: 10,
    simulationExtraPerPosition: 1,
    simulationScreeningCount: 64,
    simulationFinalistCount: 5,
    simulationFinalistNearPct: 0.01,
    simulationsPerCandidate: 256,
    simulationTiePct: 0.005,
    simulatedUserCandidateLimit: 36,
    singletonDeferredCredit: 0.88,
    deferredFuturePickDiscount: 0.97,
    horizonBenchVorpWeight: 0.10,
    scarcityForecastTurns: 4,
    specialUrgencyThreshold: 0.30,
    specialReliability: { 'D/ST': 0.30, K: 0.40 }
  };

  let dataset = null;
  let players = [];
  let playerMap = new Map();
  let leagueModels = {};
  let tiers = {};
  let recommendationCache = { key: null, recs: [] };
  let simulationCache = { key: null, results: new Map() };

  const state = {
    currentDraft: null,
    savedMocks: [],
    activePosition: 'ALL',
    search: '',
    sort: 'value'
  };

  const $ = (id) => document.getElementById(id);

  const els = {
    leagueSelect: $('leagueSelect'), draftSlot: $('draftSlot'), draftName: $('draftName'),
    undoBtn: $('undoBtn'), newDraftBtn: $('newDraftBtn'), saveSnapshotBtn: $('saveSnapshotBtn'),
    currentPickMetric: $('currentPickMetric'), turnMetric: $('turnMetric'), nextPickMetric: $('nextPickMetric'),
    picksAwayMetric: $('picksAwayMetric'), rosterCountMetric: $('rosterCountMetric'), rosterNeedMetric: $('rosterNeedMetric'),
    progressMetric: $('progressMetric'), draftedMetric: $('draftedMetric'), recommendationEyebrow: $('recommendationEyebrow'),
    recommendationTitle: $('recommendationTitle'), recommendationHint: $('recommendationHint'), recommendationCards: $('recommendationCards'),
    playerSearch: $('playerSearch'), positionFilters: $('positionFilters'), sortSelect: $('sortSelect'),
    playerTableBody: $('playerTableBody'), boardFootnote: $('boardFootnote'), rosterSlots: $('rosterSlots'),
    draftHistory: $('draftHistory'), dataStamp: $('dataStamp'), savedMocksList: $('savedMocksList'),
    mockComparison: $('mockComparison'), datasetInfo: $('datasetInfo'), replacementLevels: $('replacementLevels'),
    exportBackupBtn: $('exportBackupBtn'), importBackupInput: $('importBackupInput'), reloadRepoBackupBtn: $('reloadRepoBackupBtn'),
    backupStatus: $('backupStatus'), saveIndicator: $('saveIndicator')
  };

  function uid(prefix = 'draft') {
    return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  }

  function deepClone(obj) {
    return JSON.parse(JSON.stringify(obj));
  }

  function configFor(draft = state.currentDraft) {
    return LEAGUES[draft?.leagueId || '12'];
  }

  function rosterSize(config) {
    return config.rosterSlots.length + config.bench;
  }

  function totalPicks(config) {
    return config.teams * rosterSize(config);
  }

  function makeNewDraft(leagueId = '12', draftSlot = 1) {
    const config = LEAGUES[leagueId];
    return {
      id: uid('active'),
      name: '',
      leagueId,
      draftSlot: clampInt(draftSlot, 1, config.teams, 1),
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      picks: []
    };
  }

  function clampInt(value, min, max, fallback) {
    const n = Number.parseInt(value, 10);
    if (!Number.isFinite(n)) return fallback;
    return Math.min(max, Math.max(min, n));
  }

  function safeNumber(value, fallback = 0) {
    return Number.isFinite(value) ? value : fallback;
  }

  function fmt(value, digits = 1) {
    return Number.isFinite(value) ? value.toFixed(digits) : '—';
  }

  function pct(value) {
    return Number.isFinite(value) ? `${Math.round(value * 100)}%` : '—';
  }

  function formatPick(overall, config) {
    if (!overall || overall < 1) return '—';
    const round = Math.floor((overall - 1) / config.teams) + 1;
    const inRound = ((overall - 1) % config.teams) + 1;
    return `${round}.${String(inRound).padStart(2, '0')}`;
  }

  function teamAtPick(overall, config) {
    const round = Math.floor((overall - 1) / config.teams) + 1;
    const inRound = ((overall - 1) % config.teams) + 1;
    return round % 2 === 1 ? inRound : config.teams - inRound + 1;
  }

  function nextUserPick(startInclusive, draft = state.currentDraft) {
    const config = configFor(draft);
    const max = totalPicks(config);
    for (let p = Math.max(1, startInclusive); p <= max; p += 1) {
      if (teamAtPick(p, config) === draft.draftSlot) return p;
    }
    return null;
  }

  function currentOverallPick(draft = state.currentDraft) {
    return (draft?.picks?.length || 0) + 1;
  }

  function userRosterIds(draft = state.currentDraft) {
    return (draft?.picks || []).filter(p => p.isMine).map(p => p.playerId);
  }

  function draftedSet(draft = state.currentDraft) {
    return new Set((draft?.picks || []).map(p => p.playerId));
  }

  function computeLeagueModel(config) {
    const fixedPerTeam = { QB:1, RB:2, WR:2, TE:1, 'D/ST':1, K:1 };

    // Starter baselines (VOLS): build the best projected league-wide starting pool,
    // including FLEX demand. This is intentionally shallower than waiver replacement.
    const starterIds = new Set();
    const startersByPosition = Object.fromEntries(ALL_POSITIONS.map(pos => [pos, []]));
    for (const pos of ALL_POSITIONS) {
      const need = config.teams * fixedPerTeam[pos];
      const chosen = players.filter(p => p.position === pos && Number.isFinite(p.projectedPoints))
        .sort((a,b) => b.projectedPoints - a.projectedPoints || a.rank - b.rank)
        .slice(0, need);
      chosen.forEach(p => starterIds.add(p.id));
      startersByPosition[pos].push(...chosen);
    }
    const flexStarters = players.filter(p => SKILL_POSITIONS.has(p.position) && !starterIds.has(p.id) && Number.isFinite(p.projectedPoints))
      .sort((a,b) => b.projectedPoints - a.projectedPoints || a.rank - b.rank)
      .slice(0, config.teams * config.flex);
    flexStarters.forEach(p => {
      starterIds.add(p.id);
      startersByPosition[p.position].push(p);
    });

    const starterBaseline = {};
    for (const pos of ALL_POSITIONS) {
      const list = startersByPosition[pos];
      starterBaseline[pos] = list.length ? Math.min(...list.map(p => p.projectedPoints)) : 0;
    }
    starterBaseline.FLEX = flexStarters.length
      ? Math.min(...flexStarters.map(p => p.projectedPoints))
      : Math.min(starterBaseline.RB || Infinity, starterBaseline.WR || Infinity, starterBaseline.TE || Infinity);

    // Deep replacement (VORP): approximate the waiver line after starters + seven bench
    // spots per team have been consumed in ESPN rank order.
    const expectedDrafted = new Set();
    for (const pos of ALL_POSITIONS) {
      const need = config.teams * fixedPerTeam[pos];
      players.filter(p => p.position === pos).sort((a,b) => a.rank - b.rank)
        .slice(0, need).forEach(p => expectedDrafted.add(p.id));
    }
    players.filter(p => SKILL_POSITIONS.has(p.position) && !expectedDrafted.has(p.id))
      .sort((a,b) => a.rank - b.rank)
      .slice(0, config.teams * config.flex)
      .forEach(p => expectedDrafted.add(p.id));
    players.filter(p => BENCH_POSITIONS.has(p.position) && !expectedDrafted.has(p.id))
      .sort((a,b) => a.rank - b.rank)
      .slice(0, config.teams * config.bench)
      .forEach(p => expectedDrafted.add(p.id));

    const replacement = {};
    for (const pos of ALL_POSITIONS) {
      const pool = players.filter(p => p.position === pos && !expectedDrafted.has(p.id) && Number.isFinite(p.projectedPoints))
        .sort((a,b) => b.projectedPoints - a.projectedPoints || a.rank - b.rank);
      replacement[pos] = pool[0] || null;
    }
    const flexPool = players.filter(p => SKILL_POSITIONS.has(p.position) && !expectedDrafted.has(p.id) && Number.isFinite(p.projectedPoints))
      .sort((a,b) => b.projectedPoints - a.projectedPoints || a.rank - b.rank);
    replacement.FLEX = flexPool[0] || null;

    const baseline = Object.fromEntries(Object.entries(replacement).map(([k,p]) => [k, p?.projectedPoints ?? 0]));
    const vorp = new Map();
    const vols = new Map();
    players.forEach(p => {
      const pts = Number.isFinite(p.projectedPoints) ? p.projectedPoints : null;
      vorp.set(p.id, pts === null ? null : pts - (baseline[p.position] ?? 0));
      vols.set(p.id, pts === null ? null : pts - (starterBaseline[p.position] ?? 0));
    });

    // ESPN rank contains information the point projection does not (risk, expected role,
    // expert ordering). Convert rank into the same value scale as VOLS, then use it only
    // as a modest prior rather than forcing our order to match ESPN.
    const structuralValues = players.map(p => {
      const v = vorp.get(p.id);
      const s = vols.get(p.id);
      if (!Number.isFinite(v) || !Number.isFinite(s)) return null;
      return Math.max(s, MODEL.benchVorpWeight * Math.max(0, v));
    }).filter(Number.isFinite).sort((a,b) => b-a);
    const marketPrior = new Map();
    players.forEach(p => {
      if (!structuralValues.length || !Number.isFinite(p.projectedPoints)) {
        marketPrior.set(p.id, 0);
      } else {
        marketPrior.set(p.id, structuralValues[Math.min(p.rank - 1, structuralValues.length - 1)] || 0);
      }
    });

    return { config, expectedDrafted, replacement, baseline, starterBaseline, startersByPosition, flexStarters, vorp, vols, marketPrior };
  }

  function computeTiers() {
    const result = {};
    const floors = { QB:18, RB:14, WR:13, TE:12, 'D/ST':10, K:8 };
    for (const pos of ALL_POSITIONS) {
      const list = players.filter(p => p.position === pos && Number.isFinite(p.projectedPoints))
        .sort((a,b) => b.projectedPoints - a.projectedPoints || a.rank - b.rank);
      const sampleGaps = [];
      for (let i = 1; i < Math.min(list.length, 35); i += 1) sampleGaps.push(Math.max(0, list[i-1].projectedPoints - list[i].projectedPoints));
      const sorted = sampleGaps.slice().sort((a,b) => a-b);
      const median = sorted.length ? sorted[Math.floor(sorted.length / 2)] : 0;
      const threshold = Math.max(floors[pos] || 10, median * 3.5);
      let tier = 1;
      result[pos] = new Map();
      list.forEach((p, i) => {
        if (i > 0) {
          const gap = list[i-1].projectedPoints - p.projectedPoints;
          if (gap >= threshold) tier += 1;
        }
        result[pos].set(p.id, tier);
      });
    }
    return result;
  }

  function allocateRoster(rosterPlayers, config) {
    const remaining = rosterPlayers.slice();
    const slots = [];
    const takeBest = (pos) => {
      const idx = remaining.reduce((bestIdx, p, i) => {
        if (p.position !== pos) return bestIdx;
        if (bestIdx === -1) return i;
        return safeNumber(p.projectedPoints, -Infinity) > safeNumber(remaining[bestIdx].projectedPoints, -Infinity) ? i : bestIdx;
      }, -1);
      if (idx === -1) return null;
      return remaining.splice(idx, 1)[0];
    };
    const takeBestFlex = () => {
      const idx = remaining.reduce((bestIdx, p, i) => {
        if (!SKILL_POSITIONS.has(p.position)) return bestIdx;
        if (bestIdx === -1) return i;
        return safeNumber(p.projectedPoints, -Infinity) > safeNumber(remaining[bestIdx].projectedPoints, -Infinity) ? i : bestIdx;
      }, -1);
      if (idx === -1) return null;
      return remaining.splice(idx, 1)[0];
    };

    for (const slot of config.rosterSlots) {
      slots.push({ slot, player: slot === 'FLEX' ? takeBestFlex() : takeBest(slot) });
    }
    remaining.sort((a,b) => safeNumber(b.projectedPoints,-Infinity) - safeNumber(a.projectedPoints,-Infinity));
    for (let i = 0; i < config.bench; i += 1) slots.push({ slot: `BN${i+1}`, player: remaining.shift() || null });
    return slots;
  }

  function lineupValue(rosterPlayers, config, model, mode = 'starter') {
    const remaining = rosterPlayers.slice();
    let total = 0;
    const baselines = mode === 'starter' ? model.starterBaseline : mode === 'replacement' ? model.baseline : null;
    const takeBestIndex = (predicate) => remaining.reduce((bestIdx,p,i) => {
      if (!predicate(p)) return bestIdx;
      if (bestIdx === -1) return i;
      return safeNumber(p.projectedPoints,-Infinity) > safeNumber(remaining[bestIdx].projectedPoints,-Infinity) ? i : bestIdx;
    }, -1);

    for (const slot of config.rosterSlots) {
      const predicate = slot === 'FLEX' ? p => SKILL_POSITIONS.has(p.position) : p => p.position === slot;
      const idx = takeBestIndex(predicate);
      const baseline = baselines ? (baselines[slot] || 0) : 0;
      if (idx === -1) {
        total += baseline;
      } else {
        const p = remaining.splice(idx,1)[0];
        total += baselines ? Math.max(baseline, safeNumber(p.projectedPoints,0)) : safeNumber(p.projectedPoints,0);
      }
    }
    return total;
  }

  function baselineLineupValue(config, model, mode = 'starter') {
    const baselines = mode === 'replacement' ? model.baseline : model.starterBaseline;
    return config.rosterSlots.reduce((sum, slot) => sum + (baselines[slot] || 0), 0);
  }

  function conditionalGoneProbability(player, fromPick, toPick) {
    if (!player || !toPick || toPick <= fromPick) return 0;

    // The source has ESPN rank, not an ADP distribution. Treat rank as the center of a
    // heuristic draft-position distribution: elite players have a tighter range and
    // later players are allowed more draft-room variance. Truncating the distribution
    // before pick 1 avoids the old model's unrealistic probability mass before a draft
    // had even started.
    const rank = Math.max(1, safeNumber(player.rank, 1));
    const sigma = Math.max(2, Math.min(12, 2 + rank * 0.08));
    const rawCdf = (x) => 1 / (1 + Math.exp(-(x - rank) / sigma));
    const lowerMass = rawCdf(0.5);
    const truncatedCdf = (x) => Math.max(0, Math.min(1, (rawCdf(x) - lowerMass) / Math.max(1e-6, 1 - lowerMass)));

    // Available at fromPick means the player survived all selections before that pick.
    // toPick is exclusive: from 1 to 11 means "drafted somewhere in picks 1-10".
    const fromBoundary = Math.max(0.5, fromPick - 0.5);
    const toBoundary = Math.max(fromBoundary, toPick - 0.5);
    const goneBeforeFrom = truncatedCdf(fromBoundary);
    const goneBeforeTo = truncatedCdf(toBoundary);
    const survivalAtFrom = Math.max(1e-6, 1 - goneBeforeFrom);
    const conditional = (goneBeforeTo - goneBeforeFrom) / survivalAtFrom;
    return Math.max(0, Math.min(0.995, conditional));
  }

  function decisionTargetPick(draft = state.currentDraft) {
    const config = configFor(draft);
    const current = currentOverallPick(draft);
    if (current > totalPicks(config)) return null;
    const onClock = teamAtPick(current, config) === draft.draftSlot;
    return onClock ? nextUserPick(current + 1, draft) : nextUserPick(current, draft);
  }

  function decisionContext(draft = state.currentDraft) {
    const config = configFor(draft);
    const current = currentOverallPick(draft);
    if (current > totalPicks(config)) return { current, onClock:false, decisionPick:null, followingPick:null };
    const onClock = teamAtPick(current, config) === draft.draftSlot;
    const decisionPick = onClock ? current : nextUserPick(current, draft);
    const followingPick = decisionPick ? nextUserPick(decisionPick + 1, draft) : null;
    return { current, onClock, decisionPick, followingPick };
  }

  function expectedAlternative(player, availablePlayers, targetPick) {
    const same = availablePlayers.filter(p => p.id !== player.id && p.position === player.position && Number.isFinite(p.projectedPoints));
    if (!same.length || !targetPick) return null;
    const atOrAfter = same.filter(p => p.rank >= targetPick).sort((a,b) => a.rank - b.rank);
    if (atOrAfter.length) return atOrAfter[0];
    return same.sort((a,b) => b.rank - a.rank)[0];
  }

  function expectedBestPositionProjectionAtPick(position, availablePlayers, fromPick, targetPick) {
    if (!targetPick || targetPick <= fromPick) return { expectedProjection:0, likelyPlayer:null, likelyProbability:0 };
    const options = availablePlayers.filter(p => p.position === position && Number.isFinite(p.projectedPoints))
      .map(p => ({
        player: p,
        projection: p.projectedPoints,
        survival: 1 - conditionalGoneProbability(p, fromPick, targetPick)
      }))
      .filter(x => x.survival > 0.01)
      .sort((a,b) => b.projection - a.projection || a.player.rank - b.player.rank);

    let remainingProbability = 1;
    let expectedProjection = 0;
    let likelyPlayer = null;
    let likelyProbability = 0;
    for (const option of options) {
      const takeProbability = remainingProbability * option.survival;
      expectedProjection += takeProbability * option.projection;
      if (takeProbability > likelyProbability) {
        likelyProbability = takeProbability;
        likelyPlayer = option.player;
      }
      remainingProbability *= (1 - option.survival);
      if (remainingProbability < 0.003) break;
    }
    return { expectedProjection, likelyPlayer, likelyProbability };
  }

  function positionDepthForecast(position, availablePlayers, draft = state.currentDraft, context = decisionContext(draft)) {
    const fromPick = context?.decisionPick || context?.current || currentOverallPick(draft);
    if (!fromPick) return { position, fromPick:null, forecasts:[] };
    const futurePicks = [];
    let cursor = fromPick + 1;
    while (futurePicks.length < MODEL.scarcityForecastTurns) {
      const next = nextUserPick(cursor, draft);
      if (!next) break;
      futurePicks.push(next);
      cursor = next + 1;
    }
    const forecasts = futurePicks.map((pick, i) => ({
      turn:i + 1,
      pick,
      ...expectedBestPositionProjectionAtPick(position, availablePlayers, fromPick, pick)
    }));
    return { position, fromPick, forecasts };
  }

  function multiTurnScarcityForecast(player, availablePlayers, draft = state.currentDraft, context = decisionContext(draft), depthBase = null) {
    if (!player || !Number.isFinite(player.projectedPoints)) return { safeTurns:0, timingFactor:1, forecasts:[], threshold:0 };
    const base = depthBase || positionDepthForecast(player.position, availablePlayers, draft, context);
    const forecasts = base.forecasts.map(f => ({ ...f, drop:Math.max(0, player.projectedPoints - f.expectedProjection) }));
    const threshold = Math.max(6, player.projectedPoints * 0.04);
    let safeTurns = 0;
    for (const f of forecasts) {
      if (f.drop <= threshold) safeTurns += 1;
      else break;
    }
    const factors = [1, 0.84, 0.70, 0.58, 0.50];
    const timingFactor = factors[Math.min(safeTurns, factors.length - 1)];
    return { safeTurns, timingFactor, forecasts, threshold };
  }

  function projectionReliabilityFactor(position) {
    return MODEL.specialReliability[position] ?? 1;
  }

  function marginalRosterValue(player, rosterPlayers, draft = state.currentDraft) {
    const config = configFor(draft);
    const model = leagueModels[draft.leagueId];
    const rawVorp = model.vorp.get(player.id);
    const rawVols = model.vols.get(player.id);
    if (!Number.isFinite(player.projectedPoints) || !Number.isFinite(rawVorp) || !Number.isFinite(rawVols)) {
      return { rawVorp, rawVols, starterGain:null, structuralValue:null, marketPrior:0, decisionValue:null };
    }
    const before = lineupValue(rosterPlayers, config, model, 'starter');
    const after = lineupValue(rosterPlayers.concat(player), config, model, 'starter');
    const starterGain = after - before;
    // Do not add VOLS and VORP together. A starter gets credit for the larger starter
    // advantage; VORP acts mainly as a floor for bench/depth value.
    const structuralValue = Math.max(0, starterGain, MODEL.benchVorpWeight * Math.max(0, rawVorp));
    const fitFactor = starterGain > 0.5 ? 1 : 0.35;
    const marketPrior = (model.marketPrior.get(player.id) || 0) * fitFactor;
    const reliability = projectionReliabilityFactor(player.position);
    const undiscountedDecisionValue = (1 - MODEL.marketPriorWeight) * structuralValue + MODEL.marketPriorWeight * marketPrior;
    const decisionValue = undiscountedDecisionValue * reliability;
    return { rawVorp, rawVols, starterGain, structuralValue, marketPrior, reliability, undiscountedDecisionValue, decisionValue };
  }

  function buildNextPickPool(availablePlayers, draft, context) {
    if (!context.followingPick || !context.decisionPick) return [];
    const model = leagueModels[draft.leagueId];

    // If we are already on the clock, every currently available player has genuinely
    // survived to the decision pick, so only model survival from this pick to the next.
    // If we are still waiting for our turn, a player used in the second-pick lookahead
    // must survive the *entire* path from the current board to our following pick. This
    // prevents impossible planning paths such as "take Henry at 1.11, then Gibbs at 2.02"
    // while ignoring the fact that Gibbs first had to survive picks 1-10.
    const survivalFromPick = context.onClock ? context.decisionPick : context.current;

    return availablePlayers.filter(p => Number.isFinite(p.projectedPoints)).map(p => {
      const survival = 1 - conditionalGoneProbability(p, survivalFromPick, context.followingPick);
      const structural = Math.max(model.vols.get(p.id) || 0, MODEL.benchVorpWeight * Math.max(0, model.vorp.get(p.id) || 0));
      const prior = model.marketPrior.get(p.id) || 0;
      const preValue = ((1 - MODEL.marketPriorWeight) * structural + MODEL.marketPriorWeight * prior) * survival;
      return { player:p, survival, preValue };
    }).filter(x => x.survival > 0.03 && x.preValue > 0)
      .sort((a,b) => b.preValue - a.preValue || a.player.rank - b.player.rank)
      .slice(0, MODEL.lookaheadCandidateLimit);
  }

  function expectedBestNextPick(firstPlayer, rosterPlayers, draft, context, nextPickPool) {
    if (!context.followingPick || !context.decisionPick) return { expectedValue:0, likelyPlayer:null, likelyProbability:0 };
    const nextRoster = rosterPlayers.concat(firstPlayer);
    const afterNextPick = nextUserPick(context.followingPick + 1, draft);
    const nextContext = { current:context.followingPick, decisionPick:context.followingPick, followingPick:afterNextPick, onClock:true };
    const poolPlayers = nextPickPool.map(x => x.player);
    const depthByPosition = new Map(ALL_POSITIONS.map(pos => [pos, positionDepthForecast(pos, poolPlayers, draft, nextContext)]));
    const options = nextPickPool.filter(x => x.player.id !== firstPlayer.id).map(x => {
      const value = marginalRosterValue(x.player, nextRoster, draft);
      const alt = afterNextPick ? expectedAlternative(x.player, poolPlayers, afterNextPick) : null;
      const altValue = alt ? marginalRosterValue(alt, nextRoster, draft).decisionValue : null;
      const waitCost = Number.isFinite(altValue) ? (value.decisionValue || 0) - altValue : 0;
      const gone = afterNextPick ? conditionalGoneProbability(x.player, context.followingPick, afterNextPick) : 1;
      const scarcity = multiTurnScarcityForecast(x.player, poolPlayers, draft, nextContext, depthByPosition.get(x.player.position));
      const urgency = urgencyScore(value.decisionValue || 0, gone, waitCost) * scarcity.timingFactor;
      if (!rosterRelevant(x.player, nextRoster, draft, nextContext, urgency)) return null;
      const core = coreSkillStatus(nextRoster, draft);
      if (core.filled < core.slots && !rosterImpact(x.player, nextRoster, draft).improvesStarter) return null;
      const selectionScore = (value.decisionValue || 0) * (0.72 + 0.28 * urgency) + Math.max(0, waitCost) * 0.30;
      return { player:x.player, value:value.decisionValue || 0, survival:x.survival, urgency, selectionScore };
    }).filter(Boolean).filter(x => x.value > 0).sort((a,b) => b.selectionScore - a.selectionScore || b.value - a.value || a.player.rank - b.player.rank);

    let remainingProbability = 1;
    let expectedValue = 0;
    let likelyPlayer = null;
    let likelyProbability = 0;
    for (const option of options) {
      const takeProbability = remainingProbability * option.survival;
      expectedValue += takeProbability * option.value;
      if (takeProbability > likelyProbability) {
        likelyProbability = takeProbability;
        likelyPlayer = option.player;
      }
      remainingProbability *= (1 - option.survival);
      if (remainingProbability < 0.003) break;
    }
    return { expectedValue, likelyPlayer, likelyProbability };
  }


  function draftStateFingerprint(draft = state.currentDraft) {
    if (!draft) return 'no-draft';
    const picks = (draft.picks || []).map(p => `${p.pick}:${p.playerId}:${p.teamNumber || ''}`).join(',');
    return `${draft.leagueId}|slot-${draft.draftSlot}|${picks}`;
  }

  function hashString(text) {
    let h = 2166136261 >>> 0;
    for (let i = 0; i < text.length; i += 1) {
      h ^= text.charCodeAt(i);
      h = Math.imul(h, 16777619);
    }
    return h >>> 0;
  }

  function mulberry32(seed) {
    let a = seed >>> 0;
    return () => {
      a |= 0;
      a = (a + 0x6D2B79F5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  function futureUserPicks(currentPick, draft = state.currentDraft, count = 3) {
    const picks = [];
    let cursor = currentPick + 1;
    while (picks.length < count) {
      const next = nextUserPick(cursor, draft);
      if (!next) break;
      picks.push(next);
      cursor = next + 1;
    }
    return picks;
  }

  function sampleOpponentPick(pool, overallPick, rng) {
    if (!pool.length) return null;
    const candidateCount = Math.min(28, pool.length);
    const candidates = pool.slice(0, candidateCount);
    const bestRank = candidates[0].rank;
    const temperature = Math.max(3.5, Math.min(14, 3.5 + overallPick * 0.08));
    let total = 0;
    const weights = candidates.map(p => {
      const delta = Math.max(0, p.rank - bestRank);
      const w = Math.exp(-delta / temperature);
      total += w;
      return w;
    });
    let roll = rng() * total;
    let chosenIndex = 0;
    for (let i = 0; i < weights.length; i += 1) {
      roll -= weights[i];
      if (roll <= 0) { chosenIndex = i; break; }
    }
    return pool.splice(chosenIndex, 1)[0];
  }

  function chooseSimulatedUserPick(pool, roster, draft, overallPick) {
    if (!pool.length) return null;
    const candidates = pool.slice(0, Math.min(MODEL.simulatedUserCandidateLimit, pool.length));
    const nextPick = nextUserPick(overallPick + 1, draft);
    const context = { decisionPick: overallPick, followingPick: nextPick, onClock:true };
    let best = null;
    for (const p of candidates) {
      const value = marginalRosterValue(p, roster, draft);
      if (!Number.isFinite(value.decisionValue)) continue;
      const alt = nextPick ? expectedAlternative(p, pool, nextPick) : null;
      const altValue = alt ? marginalRosterValue(alt, roster, draft).decisionValue : null;
      const waitCost = Number.isFinite(altValue) ? value.decisionValue - altValue : 0;
      const gone = nextPick ? conditionalGoneProbability(p, overallPick, nextPick) : 1;

      // Keep simulated future picks intentionally lightweight. The full multi-turn
      // positional-depth forecast is calculated for the real decision and at the
      // simulation horizon; recalculating it for dozens of players inside every
      // simulated pick added a great deal of work without adding comparable signal.
      const urgency = urgencyScore(value.decisionValue, gone, waitCost);
      if (!rosterRelevant(p, roster, draft, context, urgency)) continue;

      // When RB/WR/FLEX capacity is still open, do not simulate a future choice that
      // goes directly to the bench. This removes irrational RB-RB-RB-RB style paths
      // while still allowing QB/TE to be delayed after the core skill slots are filled.
      const core = coreSkillStatus(roster, draft);
      if (core.filled < core.slots && !rosterImpact(p, roster, draft).improvesStarter) continue;

      const score = value.decisionValue * (0.78 + 0.22 * urgency) + Math.max(0, waitCost) * 0.35;
      if (!best || score > best.score || (score === best.score && p.rank < best.player.rank)) best = { player:p, score };
    }
    return best?.player || null;
  }

  function offensiveStarterProjection(roster, draft = state.currentDraft) {
    const config = configFor(draft);
    const allocated = allocateRoster(roster, config).filter(x => !x.slot.startsWith('BN') && x.slot !== 'D/ST' && x.slot !== 'K');
    let total = 0;
    let filled = 0;
    for (const slotRow of allocated) {
      if (!slotRow.player) continue;
      total += safeNumber(slotRow.player.projectedPoints, 0);
      filled += 1;
    }
    return { total, filled, starterSlots: allocated.length, allocated };
  }

  function rosterImpact(player, roster, draft = state.currentDraft) {
    const before = offensiveStarterProjection(roster, draft);
    const after = offensiveStarterProjection(roster.concat(player), draft);
    return {
      projectionGain: after.total - before.total,
      filledGain: after.filled - before.filled,
      improvesStarter: after.filled > before.filled || after.total > before.total + 0.5
    };
  }

  function coreSkillStatus(roster, draft = state.currentDraft) {
    const config = configFor(draft);
    const allocated = allocateRoster(roster, config).filter(x => ['RB','WR','FLEX'].includes(x.slot));
    return { filled: allocated.filter(x => x.player).length, slots: allocated.length };
  }

  function urgencyScore(currentValue, goneIfWait, waitCost) {
    if (!Number.isFinite(currentValue) || currentValue <= 0) return 0;
    const relativeDrop = Math.max(0, Math.min(1, safeNumber(waitCost, 0) / Math.max(1, currentValue)));
    return Math.max(0.12, Math.min(1, 0.12 + 0.58 * safeNumber(goneIfWait, 0) + 0.30 * relativeDrop));
  }

  function specialPositionEligible(player, roster, draft, context, urgency = 0) {
    if (player.position !== 'D/ST' && player.position !== 'K') return true;
    const offense = offensiveStarterProjection(roster, draft);
    if (offense.filled < offense.starterSlots) return false;
    const allocated = allocateRoster(roster, configFor(draft));
    const slot = allocated.find(x => x.slot === player.position);
    if (slot?.player) return false;
    if (!context?.followingPick) return true;
    return urgency >= MODEL.specialUrgencyThreshold;
  }

  function rosterRelevant(player, roster, draft = state.currentDraft, context = decisionContext(draft), urgency = 0) {
    if (player.position === 'D/ST' || player.position === 'K') {
      return specialPositionEligible(player, roster, draft, context, urgency);
    }
    const core = coreSkillStatus(roster, draft);
    const impact = rosterImpact(player, roster, draft);
    if (core.filled < core.slots) return impact.improvesStarter;
    const offense = offensiveStarterProjection(roster, draft);
    if (impact.improvesStarter) return true;
    // Once the core RB/WR/FLEX starters are occupied, allow RB/WR depth even if QB or
    // TE is intentionally being deferred. Do not surface redundant backup QB/TE targets
    // unless they would actually upgrade a starter or FLEX spot.
    if (offense.filled < offense.starterSlots) return player.position === 'RB' || player.position === 'WR';
    return player.position === 'RB' || player.position === 'WR';
  }

  function horizonRosterScore(roster, draft = state.currentDraft, remainingPool = [], horizonPick = null) {
    const model = leagueModels[draft.leagueId];
    const offense = offensiveStarterProjection(roster, draft);
    let deferred = 0;
    const nextPick = horizonPick ? nextUserPick(horizonPick + 1, draft) : null;

    // Do not pretend empty RB/WR/FLEX slots will magically be fixed later; that is the
    // scarcity signal the simulation is meant to expose. QB and TE are different because
    // viable strategies intentionally defer them. Instead of a fixed placeholder only,
    // estimate the best same-position production likely to remain at the next turn after
    // the horizon. This lets a flat TE/QB tier retain real option value beyond four picks.
    for (const row of offense.allocated) {
      if (!row.player && (row.slot === 'QB' || row.slot === 'TE')) {
        const fallback = MODEL.singletonDeferredCredit * (model.starterBaseline[row.slot] || 0);
        const future = nextPick
          ? expectedBestPositionProjectionAtPick(row.slot, remainingPool, horizonPick, nextPick).expectedProjection * MODEL.deferredFuturePickDiscount
          : 0;
        deferred += Math.max(0, future || fallback);
      }
    }

    // Once RB/WR/FLEX starters are actually filled, useful RB/WR bench depth has some
    // residual value rather than becoming literally worthless at the arbitrary horizon.
    // Keep the weight small so starter construction still dominates.
    let benchResidual = 0;
    const core = coreSkillStatus(roster, draft);
    if (core.filled >= core.slots) {
      const bench = allocateRoster(roster, configFor(draft))
        .filter(x => x.slot.startsWith('BN') && x.player && (x.player.position === 'RB' || x.player.position === 'WR'))
        .map(x => Math.max(0, model.vorp.get(x.player.id) || 0))
        .sort((a,b) => b-a)
        .slice(0, 2);
      benchResidual = bench.reduce((sum, v) => sum + v * MODEL.horizonBenchVorpWeight, 0);
    }

    return {
      score: offense.total + deferred + benchResidual,
      actualStarterProjection: offense.total,
      deferred,
      benchResidual,
      filled: offense.filled,
      starterSlots: offense.starterSlots
    };
  }

  function buildSimulationCandidates(allRecs, roster, draft) {
    const selected = [];
    const seen = new Set();
    const add = r => {
      if (!r || seen.has(r.player.id)) return;
      seen.add(r.player.id);
      selected.push(r);
    };
    const eligible = allRecs.filter(r => rosterRelevant(r.player, roster, draft, decisionContext(draft), r.urgency));
    eligible.slice(0, MODEL.simulationCandidateLimit).forEach(add);
    ['QB','RB','WR','TE'].forEach(pos => eligible.filter(r => r.player.position === pos).slice(0, MODEL.simulationExtraPerPosition).forEach(add));
    return selected;
  }

  function runFourPickSimulationBatch(firstRec, allAvailable, rosterPlayers, draft = state.currentDraft, simStart = 0, simCount = MODEL.simulationsPerCandidate) {
    const current = currentOverallPick(draft);
    const futurePicks = futureUserPicks(current, draft, 3);
    const userPicks = [current, ...futurePicks];
    const lastUserPick = userPicks[userPicks.length - 1];
    const count = futurePicks.length ? simCount : 1;
    const scores = [];
    let filledTotal = 0;
    const pathPairs = new Map();

    for (let offset = 0; offset < count; offset += 1) {
      const sim = simStart + offset;
      const rng = mulberry32(hashString(`${draftStateFingerprint(draft)}|scenario-${sim}`));
      const pool = allAvailable.filter(p => p.id !== firstRec.player.id).slice().sort((a,b) => a.rank - b.rank);
      const roster = rosterPlayers.concat(firstRec.player);
      const pathPlayers = [firstRec.player.name];
      const pathPositions = [firstRec.player.position];

      for (let pick = current + 1; pick <= lastUserPick; pick += 1) {
        if (teamAtPick(pick, configFor(draft)) === draft.draftSlot) {
          const chosen = chooseSimulatedUserPick(pool, roster, draft, pick);
          if (chosen) {
            const idx = pool.findIndex(p => p.id === chosen.id);
            if (idx >= 0) pool.splice(idx, 1);
            roster.push(chosen);
            pathPlayers.push(chosen.name);
            pathPositions.push(chosen.position);
          }
        } else {
          sampleOpponentPick(pool, pick, rng);
        }
      }

      const horizon = horizonRosterScore(roster, draft, pool, lastUserPick);
      scores.push(horizon.score);
      filledTotal += horizon.filled;
      const pairKey = JSON.stringify([pathPositions.join(' → '), pathPlayers.join(' → ')]);
      pathPairs.set(pairKey, (pathPairs.get(pairKey) || 0) + 1);
    }

    return { scores, filledTotal, pathPairs, simulations:count, picksPlanned:userPicks.length, lastUserPick };
  }

  function mergeSimulationBatches(first, second) {
    if (!first) return second;
    if (!second) return first;
    const pathPairs = new Map(first.pathPairs);
    for (const [key, count] of second.pathPairs.entries()) pathPairs.set(key, (pathPairs.get(key) || 0) + count);
    return {
      scores:first.scores.concat(second.scores),
      filledTotal:first.filledTotal + second.filledTotal,
      pathPairs,
      simulations:first.simulations + second.simulations,
      picksPlanned:first.picksPlanned,
      lastUserPick:first.lastUserPick
    };
  }

  function finalizeSimulationBatch(batch) {
    const scores = batch.scores.slice().sort((a,b) => a-b);
    const avg = scores.reduce((sum,x) => sum+x, 0) / Math.max(1, scores.length);
    const p25 = scores[Math.floor((scores.length - 1) * 0.25)] || avg;
    const p75 = scores[Math.floor((scores.length - 1) * 0.75)] || avg;
    const commonPairKey = Array.from(batch.pathPairs.entries()).sort((a,b) => b[1] - a[1])[0]?.[0];
    const commonPair = commonPairKey ? JSON.parse(commonPairKey) : ['', ''];
    return {
      avgHorizonScore:avg,
      p25,
      p75,
      avgFilledStarters:batch.filledTotal / Math.max(1, batch.simulations),
      positionPath:commonPair[0],
      playerPath:commonPair[1],
      simulations:batch.simulations,
      picksPlanned:batch.picksPlanned,
      lastUserPick:batch.lastUserPick
    };
  }

  function simulationResults(allRecs, draft = state.currentDraft) {
    const key = `${draftStateFingerprint(draft)}|sim-v6-adaptive`;
    if (simulationCache.key === key) return simulationCache.results;
    const results = new Map();
    const context = decisionContext(draft);
    if (!context.onClock) {
      simulationCache = { key, results };
      return results;
    }
    const currentRoster = userRosterIds(draft).map(id => playerMap.get(id)).filter(Boolean);
    const offensive = offensiveStarterProjection(currentRoster, draft);
    if (offensive.filled >= offensive.starterSlots) {
      simulationCache = { key, results };
      return results;
    }
    const drafted = draftedSet(draft);
    const available = players.filter(p => !drafted.has(p.id)).sort((a,b) => a.rank - b.rank);
    const roster = currentRoster;
    const candidates = buildSimulationCandidates(allRecs, roster, draft);
    if (!candidates.length) {
      simulationCache = { key, results };
      return results;
    }

    // Stage 1: cheaply screen every serious candidate on the same first 64 scenarios.
    // This preserves cross-candidate comparability while avoiding 256 full paths for
    // players that are clearly behind after the initial screen.
    const screeningCount = Math.min(MODEL.simulationScreeningCount, MODEL.simulationsPerCandidate);
    const screeningBatches = new Map();
    const screeningResults = new Map();
    for (const rec of candidates) {
      const batch = runFourPickSimulationBatch(rec, available, roster, draft, 0, screeningCount);
      screeningBatches.set(rec.player.id, batch);
      screeningResults.set(rec.player.id, finalizeSimulationBatch(batch));
    }

    const screened = candidates.slice().sort((a,b) =>
      screeningResults.get(b.player.id).avgHorizonScore - screeningResults.get(a.player.id).avgHorizonScore ||
      b.onClockScore - a.onClockScore || a.player.rank - b.player.rank
    );
    const bestScreen = screeningResults.get(screened[0].player.id).avgHorizonScore;
    const nearTolerance = Math.max(1, Math.abs(bestScreen) * MODEL.simulationFinalistNearPct);
    const finalistIds = new Set();
    const addFinalist = rec => { if (rec) finalistIds.add(rec.player.id); };

    // Always advance the strongest screen results. Also protect against a noisy 64-path
    // screen by advancing anyone very close to the leader, the best immediate two-pick
    // options, and the best screened candidate at each core offensive position.
    screened.slice(0, MODEL.simulationFinalistCount).forEach(addFinalist);
    screened.filter(rec => Math.abs(bestScreen - screeningResults.get(rec.player.id).avgHorizonScore) <= nearTolerance).forEach(addFinalist);
    candidates.slice().sort((a,b) => b.onClockScore - a.onClockScore || a.player.rank - b.player.rank).slice(0, 3).forEach(addFinalist);
    ['QB','RB','WR','TE'].forEach(pos => addFinalist(screened.find(rec => rec.player.position === pos)));

    const remainingCount = Math.max(0, MODEL.simulationsPerCandidate - screeningCount);
    for (const rec of candidates) {
      if (!finalistIds.has(rec.player.id)) continue;
      let combined = screeningBatches.get(rec.player.id);
      if (remainingCount > 0) {
        const finalBatch = runFourPickSimulationBatch(rec, available, roster, draft, screeningCount, remainingCount);
        combined = mergeSimulationBatches(combined, finalBatch);
      }
      results.set(rec.player.id, finalizeSimulationBatch(combined));
    }

    simulationCache = { key, results };
    return results;
  }

  function recommendationFor(player, availablePlayers, rosterPlayers, draft = state.currentDraft, context = decisionContext(draft), nextPickPool = buildNextPickPool(availablePlayers, draft, context), depthForecasts = null) {
    const value = marginalRosterValue(player, rosterPlayers, draft);
    if (!Number.isFinite(value.decisionValue)) {
      return { player, ...value, currentValue:-Infinity, onClockScore:-Infinity, targetScore:-Infinity, pathValue:null, waitCost:null, gone:0, beforeMyPick:0, alt:null, expectedNext:null, urgency:0, tier:null };
    }

    const alt = context.followingPick ? expectedAlternative(player, availablePlayers, context.followingPick) : null;
    const altValue = alt ? marginalRosterValue(alt, rosterPlayers, draft).decisionValue : null;
    const waitCost = Number.isFinite(altValue) ? value.decisionValue - altValue : null;
    const gone = context.followingPick && context.decisionPick
      ? conditionalGoneProbability(player, context.decisionPick, context.followingPick) : 0;
    const beforeMyPick = !context.onClock && context.decisionPick
      ? conditionalGoneProbability(player, context.current, context.decisionPick) : 0;
    const expectedNext = expectedBestNextPick(player, rosterPlayers, draft, context, nextPickPool);
    const pathValue = value.decisionValue + expectedNext.expectedValue;
    const marketValue = context.decisionPick ? context.decisionPick - player.rank : 0;
    const scarcity = multiTurnScarcityForecast(player, availablePlayers, draft, context, depthForecasts?.get(player.position));

    // Keep three questions separate instead of hiding them in one blended score:
    // 1) currentValue = how much we value the player if he is available right now.
    // 2) targetScore = planning utility before our turn (value × chance he reaches us).
    // 3) onClockScore = two-pick path value once the choice is real and availability is known.
    const currentValue = value.decisionValue;
    const targetAvailability = context.onClock ? 1 : (1 - beforeMyPick);
    const rawUrgency = urgencyScore(currentValue, gone, waitCost);
    const urgency = Math.max(0.08, Math.min(1, rawUrgency * scarcity.timingFactor));
    const targetUrgencyFactor = 0.35 + 0.65 * urgency;
    const targetScore = currentValue * targetAvailability * targetUrgencyFactor;
    const onClockScore = pathValue;

    return {
      player, ...value, alt, waitCost, vona:waitCost, gone, beforeMyPick, expectedNext, scarcity, rawUrgency, urgency,
      currentValue, targetScore, onClockScore, pathValue, marketValue, targetPick:context.followingPick,
      tier: tiers[player.position]?.get(player.id) || null
    };
  }

  function recommendationReason(rec, valueRank = null, simulation = null, immediateRank = null) {
    const pieces = [];
    const context = decisionContext();
    if (!context.onClock) {
      if (valueRank) pieces.push(`#${valueRank} on the current-value board`);
      if (context.decisionPick) pieces.push(`${pct(1 - rec.beforeMyPick)} estimated chance to reach ${formatPick(context.decisionPick, configFor())}`);
      if (rec.scarcity?.safeTurns >= 2) pieces.push(`low positional urgency: comparable ${rec.player.position} production is forecast to remain for about ${rec.scarcity.safeTurns} turns`);
      else if (rec.urgency < 0.25 && context.followingPick) pieces.push(`low urgency: the model expects a good chance you can wait another turn`);
      else if (rec.urgency >= 0.60) pieces.push(`high urgency if you want him: waiting carries meaningful availability or tier-drop risk`);
      else if (Number.isFinite(rec.rawVols)) pieces.push(`${fmt(rec.rawVols)} pts over the last modeled ${rec.player.position} starter`);
      return pieces.slice(0,3).join('; ') + '.';
    }

    if (immediateRank) pieces.push(`#${immediateRank} on the immediate two-pick view`);
    if (simulation) pieces.push(`${simulation.simulations} rank-driven paths average ${fmt(simulation.avgHorizonScore,0)} horizon pts through ${formatPick(simulation.lastUserPick, configFor())}`);
    if (Number.isFinite(rec.starterGain) && rec.starterGain > 8) pieces.push(`adds ${fmt(rec.starterGain)} pts above the modeled starter baseline now`);
    else if (Number.isFinite(rec.rawVols)) pieces.push(`${fmt(rec.rawVols)} pts over the last modeled ${rec.player.position} starter`);
    if (!simulation && rec.expectedNext?.likelyPlayer && rec.targetPick) pieces.push(`two-pick lookahead most often pairs him with ${rec.expectedNext.likelyPlayer.name} around ${formatPick(rec.targetPick, configFor())}`);
    if (rec.scarcity?.safeTurns >= 2) pieces.push(`${rec.player.position} depth looks flat for about ${rec.scarcity.safeTurns} more turns`);
    else if (Number.isFinite(rec.waitCost) && rec.waitCost > 8 && rec.alt) pieces.push(`waiting at ${rec.player.position} costs about ${fmt(rec.waitCost)} model-value vs ${rec.alt.name}`);
    else if (rec.gone >= .65 && rec.targetPick) pieces.push(`${pct(rec.gone)} directional chance of going before ${formatPick(rec.targetPick, configFor())} if you pass`);
    if (!pieces.length) pieces.push('strong current player value with a favorable multi-pick roster path');
    return pieces.slice(0,3).join('; ') + '.';
  }

  function renderAll() {
    if (!dataset || !state.currentDraft) return;
    syncControlsFromState();
    renderStatus();
    renderRecommendations();
    renderBoard();
    renderRoster();
    renderHistory();
    renderMocks();
    renderData();
    els.undoBtn.disabled = state.currentDraft.picks.length === 0;
  }

  function syncControlsFromState() {
    const draft = state.currentDraft;
    const config = configFor(draft);
    els.leagueSelect.value = draft.leagueId;
    els.draftSlot.max = String(config.teams);
    els.draftSlot.value = String(draft.draftSlot);
    els.draftName.value = draft.name || '';
    els.sortSelect.value = state.sort;
  }

  function renderStatus() {
    const draft = state.currentDraft;
    const config = configFor(draft);
    const current = currentOverallPick(draft);
    const max = totalPicks(config);
    const finished = current > max;
    const owner = finished ? null : teamAtPick(current, config);
    const isMine = owner === draft.draftSlot;
    const upcoming = finished ? null : (isMine ? nextUserPick(current + 1, draft) : nextUserPick(current, draft));
    const myCount = userRosterIds(draft).length;
    const progress = Math.min(1, draft.picks.length / max);

    els.currentPickMetric.textContent = finished ? 'Complete' : formatPick(current, config);
    els.turnMetric.textContent = finished ? 'Draft finished' : (isMine ? 'Your pick' : `Team ${owner} on the clock`);
    els.nextPickMetric.textContent = upcoming ? formatPick(upcoming, config) : '—';
    els.picksAwayMetric.textContent = upcoming ? `${Math.max(0, upcoming - current)} picks away` : 'No later pick';
    els.rosterCountMetric.textContent = `${myCount} / ${rosterSize(config)}`;
    els.rosterNeedMetric.textContent = rosterNeedText();
    els.progressMetric.textContent = `${Math.round(progress * 100)}%`;
    els.draftedMetric.textContent = `${draft.picks.length} / ${max} drafted`;
  }

  function rosterNeedText() {
    const config = configFor();
    const roster = userRosterIds().map(id => playerMap.get(id)).filter(Boolean);
    const allocated = allocateRoster(roster, config);
    const missing = allocated.filter(x => !x.player && !x.slot.startsWith('BN')).map(x => x.slot);
    return missing.length ? Array.from(new Set(missing)).slice(0,4).join(' • ') : 'Starters filled';
  }

  function currentRecommendations() {
    const draft = state.currentDraft;
    const key = draftStateFingerprint(draft);
    if (recommendationCache.key === key) return recommendationCache.recs;
    const drafted = draftedSet();
    const available = players.filter(p => !drafted.has(p.id));
    const roster = userRosterIds().map(id => playerMap.get(id)).filter(Boolean);
    const context = decisionContext(draft);
    const nextPickPool = buildNextPickPool(available, draft, context);
    const depthForecasts = new Map(ALL_POSITIONS.map(pos => [pos, positionDepthForecast(pos, available, draft, context)]));
    const recs = available.map(p => recommendationFor(p, available, roster, draft, context, nextPickPool, depthForecasts))
      .sort((a,b) => b.currentValue - a.currentValue || a.player.rank - b.player.rank);
    recommendationCache = { key, recs };
    return recs;
  }

  function renderRecommendations() {
    const config = configFor();
    const current = currentOverallPick();
    const context = decisionContext();
    if (current > totalPicks(config)) {
      els.recommendationCards.innerHTML = '<div class="empty-state panel">Draft complete. Save this draft as a mock to compare it in Mock Lab.</div>';
      return;
    }

    const all = currentRecommendations().filter(r => Number.isFinite(r.currentValue));
    const valueRank = new Map(all.map((r,i) => [r.player.id, i + 1]));
    let recs;
    let simulations = new Map();
    let immediateRank = new Map();
    let simulationTopAvg = null;
    let simulationTieTolerance = 0;
    let simulationTieCount = 0;
    if (context.onClock) {
      const eligibleNow = all.filter(r => rosterRelevant(r.player, userRosterIds().map(id => playerMap.get(id)).filter(Boolean), state.currentDraft, context, r.urgency));
      const immediate = eligibleNow.slice().sort((a,b) => b.onClockScore - a.onClockScore || b.currentValue - a.currentValue || a.player.rank - b.player.rank);
      immediateRank = new Map(immediate.map((r,i) => [r.player.id, i + 1]));
      simulations = simulationResults(all);
      if (simulations.size) {
        const simulatedEligible = eligibleNow.filter(r => simulations.has(r.player.id))
          .sort((a,b) => simulations.get(b.player.id).avgHorizonScore - simulations.get(a.player.id).avgHorizonScore || b.onClockScore - a.onClockScore || a.player.rank - b.player.rank);
        simulationTopAvg = simulations.get(simulatedEligible[0]?.player.id)?.avgHorizonScore ?? null;
        simulationTieTolerance = Number.isFinite(simulationTopAvg) ? Math.max(1, Math.abs(simulationTopAvg) * MODEL.simulationTiePct) : 0;
        simulationTieCount = Number.isFinite(simulationTopAvg)
          ? simulatedEligible.filter(r => Math.abs(simulationTopAvg - simulations.get(r.player.id).avgHorizonScore) <= simulationTieTolerance).length
          : 0;
        recs = simulatedEligible.slice(0,3);
        els.recommendationHint.textContent = 'Decision Support now uses an adaptive Monte Carlo: every serious candidate is screened on the same 64 deterministic paths, then the strongest and strategically protected finalists are extended to 256 paths. Cards are ranked only from the 256-path finalist set. Candidates within 0.5% of the best average are labeled essentially tied. Simulated future picks use a lighter one-turn evaluator while the full multi-turn position-depth forecast remains active for the real decision and horizon scoring.';
      } else {
        recs = immediate.slice(0,3);
        els.recommendationHint.textContent = 'Your offensive starting slots are filled, so the longer-horizon roster-construction simulation steps aside and the cards use the immediate two-pick view for depth and late-round decisions.';
      }
      els.recommendationEyebrow.textContent = 'Decision support';
      els.recommendationTitle.textContent = 'Best choices right now';
    } else {
      const roster = userRosterIds().map(id => playerMap.get(id)).filter(Boolean);
      recs = all.filter(r => (1 - r.beforeMyPick) > 0.02 && rosterRelevant(r.player, roster, state.currentDraft, context, r.urgency))
        .sort((a,b) => b.targetScore - a.targetScore || b.currentValue - a.currentValue || a.player.rank - b.player.rank)
        .slice(0,3);
      els.recommendationEyebrow.textContent = 'Planning ahead';
      els.recommendationTitle.textContent = context.decisionPick ? `Priority targets at ${formatPick(context.decisionPick, config)}` : 'Priority targets';
      els.recommendationHint.textContent = 'This is a planning list, not a player ranking. It shows roster-relevant players who can plausibly reach your upcoming pick, then discounts options that are likely to remain replaceable across several later turns. Already-covered positions stay visible only when the player would improve your starting lineup. The Draft Board below stays ordered by intrinsic player value.';
    }

    els.recommendationCards.innerHTML = recs.map((r,i) => {
      const p = r.player;
      const rank = valueRank.get(p.id);
      const sim = simulations.get(p.id) || null;
      const displayedGone = context.onClock ? r.gone : r.beforeMyPick;
      const goneLabel = context.onClock ? 'Gone if wait' : 'Gone by my pick';
      const badge = context.onClock && sim ? `Avg ${sim.picksPlanned}-pick ${fmt(sim.avgHorizonScore,0)}` : (context.onClock ? `2-pick ${fmt(r.pathValue)}` : `Avail ${pct(1 - r.beforeMyPick)}`);
      const isSimulationTie = Boolean(context.onClock && sim && Number.isFinite(simulationTopAvg) && Math.abs(simulationTopAvg - sim.avgHorizonScore) <= simulationTieTolerance && simulationTieCount > 1);
      const label = context.onClock
        ? (sim ? `${isSimulationTie ? 'Top group' : `#${i+1}`} • avg ${sim.picksPlanned}-pick outlook` : `#${i+1} 2-pick outlook`)
        : `#${i+1} priority target`;
      const tieMessage = isSimulationTie
        ? `Essentially tied with the top ${sim.picksPlanned}-pick outlook (within ${(MODEL.simulationTiePct * 100).toFixed(1)}%). Treat the ordering inside this group as a preference/tier decision.`
        : '';
      return `<article class="rec-card">
        <div class="rec-rank">
          <div>
            <div class="team-line">${label}${context.onClock ? ` • Immediate #${immediateRank.get(p.id) || '—'}` : ''} • Model rank ${rank || '—'} • ESPN ${p.rank}</div>
            <h3>${escapeHtml(p.name)} ${p.injuryStatus ? `<span class="status-badge">${p.injuryStatus}</span>` : ''}</h3>
            <div class="team-line">${escapeHtml(p.team)} • <span class="pos-badge">${p.position}</span> • Tier ${r.tier || '—'}</div>
          </div>
          <span class="score-badge">${badge}</span>
        </div>
        <div class="rec-metrics">
          <div><span>Projection</span><strong>${fmt(p.projectedPoints)}</strong></div>
          <div><span>Model value</span><strong>${fmt(r.currentValue)}</strong></div>
          <div><span>VOLS</span><strong>${fmt(r.rawVols)}</strong></div>
          <div><span>${goneLabel}</span><strong>${pct(displayedGone)}</strong></div>
          <div><span title="Timing signal: combines gone-if-wait risk with the relative same-position value drop. It affects recommendation timing, not Draft Board value.">Urgency</span><strong>${pct(r.urgency)}</strong></div>
        </div>
        ${context.onClock ? `<div class="path-line"><span>Immediate 2-pick:</span><strong>${fmt(r.pathValue)}</strong><span>Likely next:</span><strong>${r.expectedNext?.likelyPlayer ? escapeHtml(r.expectedNext.likelyPlayer.name) : '—'}</strong></div>` : ''}
        ${r.scarcity?.forecasts?.length ? `<div class="path-line"><span>Position depth:</span><strong>${r.scarcity.safeTurns ? `safe ~${r.scarcity.safeTurns} turn${r.scarcity.safeTurns === 1 ? '' : 's'}` : 'cliff near'}</strong><span>Proj if waiting:</span><strong>${r.scarcity.forecasts.map(f => fmt(f.expectedProjection,0)).join(' → ')}</strong></div>` : ''}
        ${context.onClock && sim ? `<div class="path-line simulation-path"><span>Common ${sim.picksPlanned}-pick shape:</span><strong>${escapeHtml(sim.positionPath || '—')}</strong><span>Middle 50%:</span><strong>${fmt(sim.p25,0)}–${fmt(sim.p75,0)} horizon pts</strong><span>Avg starters filled:</span><strong>${fmt(sim.avgFilledStarters,1)}/${config.rosterSlots.filter(slot => !['D/ST','K'].includes(slot)).length}</strong></div>` : ''}
        ${context.onClock && sim ? `<div class="path-line simulation-path"><span>Common player path:</span><strong>${escapeHtml(sim.playerPath || '—')}</strong></div>` : ''}
        ${tieMessage ? `<div class="path-line"><span>Model call:</span><strong>${escapeHtml(tieMessage)}</strong></div>` : ''}
        <p class="rec-reason">${escapeHtml(recommendationReason(r, rank, sim, immediateRank.get(p.id)))}</p>
        <button class="button draft-player" type="button" data-player-id="${p.id}">${teamAtPick(current, config) === state.currentDraft.draftSlot ? 'Draft to my team' : 'Mark drafted'}</button>
      </article>`;
    }).join('');
    els.recommendationCards.querySelectorAll('.draft-player').forEach(btn => btn.addEventListener('click', () => draftPlayer(btn.dataset.playerId)));
  }

  function renderBoard() {
    const config = configFor();
    const current = currentOverallPick();
    const context = decisionContext();
    let recs = currentRecommendations().slice();
    const q = state.search.trim().toLowerCase();
    if (state.activePosition !== 'ALL') recs = recs.filter(r => r.player.position === state.activePosition);
    if (q) recs = recs.filter(r => `${r.player.name} ${r.player.team} ${r.player.position}`.toLowerCase().includes(q));

    const sorters = {
      value: (a,b) => b.currentValue - a.currentValue || a.player.rank - b.player.rank,
      rank: (a,b) => a.player.rank - b.player.rank,
      projection: (a,b) => safeNumber(b.player.projectedPoints,-Infinity) - safeNumber(a.player.projectedPoints,-Infinity) || a.player.rank-b.player.rank,
      vols: (a,b) => safeNumber(b.rawVols,-Infinity) - safeNumber(a.rawVols,-Infinity),
      vorp: (a,b) => safeNumber(b.rawVorp,-Infinity) - safeNumber(a.rawVorp,-Infinity),
      vona: (a,b) => safeNumber(b.waitCost,-Infinity) - safeNumber(a.waitCost,-Infinity),
      path: (a,b) => safeNumber(b.pathValue,-Infinity) - safeNumber(a.pathValue,-Infinity)
    };
    recs.sort(sorters[state.sort] || sorters.value);

    const isMine = current <= totalPicks(config) && teamAtPick(current,config) === state.currentDraft.draftSlot;
    els.playerTableBody.innerHTML = recs.map(r => {
      const p = r.player;
      const displayedGone = context.onClock ? r.gone : r.beforeMyPick;
      const goneClass = displayedGone >= .65 ? 'gone-high' : displayedGone >= .35 ? 'gone-medium' : '';
      const vClass = safeNumber(r.rawVorp) >= 0 ? 'value-positive' : 'value-negative';
      return `<tr>
        <td>${p.rank}</td>
        <td><div class="player-name">${escapeHtml(p.name)} ${p.injuryStatus ? `<span class="status-badge">${p.injuryStatus}</span>` : ''}</div><div class="player-meta">${escapeHtml(p.team)}</div></td>
        <td><span class="pos-badge">${p.position}</span></td>
        <td class="num">${fmt(p.projectedPoints)}</td>
        <td class="num value-positive">${fmt(r.currentValue)}</td>
        <td class="num ${safeNumber(r.rawVols) >= 0 ? 'value-positive' : 'value-negative'}">${fmt(r.rawVols)}</td>
        <td class="num ${vClass}">${fmt(r.rawVorp)}</td>
        <td class="num">${fmt(r.waitCost)}</td>
        <td class="num ${goneClass}">${pct(displayedGone)}</td>
        <td>${r.tier || '—'}</td>
        <td><button class="button tiny secondary draft-player" type="button" data-player-id="${p.id}" ${current > totalPicks(config) ? 'disabled' : ''}>${isMine ? 'Mine' : 'Drafted'}</button></td>
      </tr>`;
    }).join('');
    els.playerTableBody.querySelectorAll('.draft-player').forEach(btn => btn.addEventListener('click', () => draftPlayer(btn.dataset.playerId)));
    const goneMeaning = context.onClock
      ? `chance the player is drafted before your following pick ${formatPick(context.followingPick, config)} if you pass`
      : `chance the player is drafted before your upcoming pick ${formatPick(context.decisionPick, config)}`;
    els.boardFootnote.textContent = `${recs.length} available shown. The default Draft Board order is current model value only; availability does not change that order. VOLS uses the modeled last starter and VORP uses the deeper waiver line. K and D/ST keep their raw projections/VOLS visible but receive a heuristic reliability discount in Model Value because preseason special-position projections are less actionable and easier to replace/stream. “Gone” is the ${goneMeaning}; it is a heuristic based on ESPN rank because the PDF does not include ADP. Two-pick and multi-turn timing signals are used only for recommendation timing; the Draft Board remains an intrinsic current-value view.`;
  }

  function renderRoster() {
    const config = configFor();
    const roster = userRosterIds().map(id => playerMap.get(id)).filter(Boolean);
    const slots = allocateRoster(roster, config);
    els.rosterSlots.innerHTML = slots.map(s => `<div class="roster-slot">
      <span class="slot-label">${s.slot.startsWith('BN') ? 'BN' : s.slot}</span>
      <span class="slot-player ${s.player ? '' : 'slot-empty'}">${s.player ? escapeHtml(s.player.name) : 'Open'}</span>
      <span class="slot-points">${s.player ? fmt(s.player.projectedPoints) : ''}</span>
    </div>`).join('');
  }

  function renderHistory() {
    const config = configFor();
    const recent = state.currentDraft.picks.slice(-16).reverse();
    if (!recent.length) {
      els.draftHistory.innerHTML = '<li class="slot-empty">No picks yet.</li>';
      return;
    }
    els.draftHistory.innerHTML = recent.map(pick => {
      const p = playerMap.get(pick.playerId);
      return `<li><span class="${pick.isMine ? 'mine' : ''}">${formatPick(pick.pick,config)} ${escapeHtml(p?.name || pick.playerId)}</span> <span class="player-meta">${pick.isMine ? 'YOU' : `Team ${pick.teamNumber}`}</span></li>`;
    }).join('');
  }

  function draftPlayer(playerId) {
    const draft = state.currentDraft;
    const config = configFor(draft);
    const current = currentOverallPick(draft);
    if (current > totalPicks(config)) return;
    if (draftedSet(draft).has(playerId)) return;
    const owner = teamAtPick(current, config);
    draft.picks.push({ pick: current, playerId, teamNumber: owner, isMine: owner === draft.draftSlot });
    draft.updatedAt = new Date().toISOString();
    persist();
    renderAll();
  }

  function undoPick() {
    if (!state.currentDraft.picks.length) return;
    state.currentDraft.picks.pop();
    state.currentDraft.updatedAt = new Date().toISOString();
    persist();
    renderAll();
  }

  function resetDraft() {
    if (state.currentDraft?.picks?.length && !window.confirm('Start a new draft? Your current draft will remain only if you saved a mock snapshot.')) return;
    const leagueId = state.currentDraft?.leagueId || '12';
    const slot = state.currentDraft?.draftSlot || 1;
    state.currentDraft = makeNewDraft(leagueId, slot);
    persist();
    renderAll();
  }

  function saveSnapshot() {
    const draft = deepClone(state.currentDraft);
    const config = configFor(draft);
    draft.id = uid('mock');
    draft.name = (state.currentDraft.name || '').trim() || `${config.teams}-team • slot ${draft.draftSlot} • ${draft.picks.length} picks`;
    draft.savedAt = new Date().toISOString();
    state.savedMocks.unshift(draft);
    persist();
    renderMocks();
    flashSaved('Mock snapshot saved');
  }

  function renderMocks() {
    if (!state.savedMocks.length) {
      els.savedMocksList.innerHTML = '<div class="empty-state">No saved mocks yet. Save a snapshot from the Draft Room.</div>';
      els.mockComparison.innerHTML = '<div class="empty-state">Select at least two saved mocks to compare.</div>';
      return;
    }
    const checkedIds = new Set(Array.from(document.querySelectorAll('.mock-compare-check:checked')).map(x => x.value));
    els.savedMocksList.innerHTML = state.savedMocks.map(mock => {
      const config = LEAGUES[mock.leagueId];
      const mine = (mock.picks || []).filter(p => p.isMine).length;
      return `<article class="mock-item">
        <div class="mock-item-head">
          <input class="mock-compare-check" type="checkbox" value="${mock.id}" aria-label="Compare ${escapeHtml(mock.name)}" ${checkedIds.has(mock.id) ? 'checked' : ''}>
          <div><h3>${escapeHtml(mock.name)}</h3><div class="mock-meta">${config.name} • slot ${mock.draftSlot} • ${mine}/${rosterSize(config)} rostered • ${mock.picks.length} total picks</div></div>
          <span class="pos-badge">${mock.picks.length >= totalPicks(config) ? 'Complete' : 'Partial'}</span>
        </div>
        <div class="mock-actions">
          <button class="button tiny secondary load-mock" type="button" data-id="${mock.id}">Load</button>
          <button class="button tiny secondary rename-mock" type="button" data-id="${mock.id}">Rename</button>
          <button class="button tiny danger-ghost delete-mock" type="button" data-id="${mock.id}">Delete</button>
        </div>
      </article>`;
    }).join('');

    els.savedMocksList.querySelectorAll('.mock-compare-check').forEach(cb => cb.addEventListener('change', renderMockComparison));
    els.savedMocksList.querySelectorAll('.load-mock').forEach(btn => btn.addEventListener('click', () => loadMock(btn.dataset.id)));
    els.savedMocksList.querySelectorAll('.rename-mock').forEach(btn => btn.addEventListener('click', () => renameMock(btn.dataset.id)));
    els.savedMocksList.querySelectorAll('.delete-mock').forEach(btn => btn.addEventListener('click', () => deleteMock(btn.dataset.id)));
    renderMockComparison();
  }

  function mockMetrics(mock) {
    const config = LEAGUES[mock.leagueId];
    const model = leagueModels[mock.leagueId];
    const minePicks = (mock.picks || []).filter(p => p.isMine);
    const roster = minePicks.map(p => playerMap.get(p.playerId)).filter(Boolean);
    const actualStarter = lineupValue(roster, config, model, 'none');
    const aboveReplacement = lineupValue(roster, config, model, 'starter') - baselineLineupValue(config, model, 'starter');
    const rosterProjection = roster.reduce((sum,p) => sum + safeNumber(p.projectedPoints,0), 0);
    const espnValue = minePicks.reduce((sum,pick) => {
      const p = playerMap.get(pick.playerId);
      return sum + (p ? pick.pick - p.rank : 0);
    }, 0);
    const counts = Object.fromEntries(ALL_POSITIONS.map(pos => [pos, roster.filter(p => p.position === pos).length]));
    const firstThree = minePicks.slice(0,3).map(x => playerMap.get(x.playerId)?.name).filter(Boolean).join(' / ') || '—';
    return { config, minePicks, roster, actualStarter, aboveReplacement, rosterProjection, espnValue, counts, firstThree };
  }

  function renderMockComparison() {
    const ids = Array.from(document.querySelectorAll('.mock-compare-check:checked')).map(x => x.value);
    const mocks = ids.map(id => state.savedMocks.find(m => m.id === id)).filter(Boolean);
    if (mocks.length < 2) {
      els.mockComparison.innerHTML = '<div class="empty-state">Select at least two saved mocks to compare.</div>';
      return;
    }
    const metrics = mocks.map(mockMetrics);
    const rows = [
      ['League', i => metrics[i].config.name],
      ['Draft slot', i => mocks[i].draftSlot],
      ['My roster', i => `${metrics[i].minePicks.length}/${rosterSize(metrics[i].config)}`],
      ['Starter projection', i => fmt(metrics[i].actualStarter)],
      ['Starter edge vs baseline', i => fmt(metrics[i].aboveReplacement)],
      ['Full roster projection', i => fmt(metrics[i].rosterProjection)],
      ['ESPN pick value', i => `${metrics[i].espnValue >= 0 ? '+' : ''}${Math.round(metrics[i].espnValue)}`],
      ['QB / RB / WR / TE', i => `${metrics[i].counts.QB} / ${metrics[i].counts.RB} / ${metrics[i].counts.WR} / ${metrics[i].counts.TE}`],
      ['First 3 picks', i => metrics[i].firstThree]
    ];
    els.mockComparison.innerHTML = `<div class="compare-scroll"><table class="compare-table"><thead><tr><th>Metric</th>${mocks.map(m => `<th>${escapeHtml(m.name)}</th>`).join('')}</tr></thead><tbody>${rows.map(([label,fn]) => `<tr><td><strong>${label}</strong></td>${mocks.map((m,i) => `<td>${escapeHtml(String(fn(i)))}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`;
  }

  function loadMock(id) {
    const mock = state.savedMocks.find(m => m.id === id);
    if (!mock) return;
    if (state.currentDraft.picks.length && !window.confirm('Load this mock into the Draft Room and replace the active draft?')) return;
    state.currentDraft = deepClone(mock);
    state.currentDraft.id = uid('active');
    state.currentDraft.name = `${mock.name} (working copy)`;
    persist();
    activateTab('draft');
    renderAll();
  }

  function renameMock(id) {
    const mock = state.savedMocks.find(m => m.id === id);
    if (!mock) return;
    const name = window.prompt('Mock name', mock.name);
    if (!name?.trim()) return;
    mock.name = name.trim().slice(0,80);
    persist();
    renderMocks();
  }

  function deleteMock(id) {
    const mock = state.savedMocks.find(m => m.id === id);
    if (!mock) return;
    if (!window.confirm(`Delete “${mock.name}”?`)) return;
    state.savedMocks = state.savedMocks.filter(m => m.id !== id);
    persist();
    renderMocks();
  }

  function renderData() {
    const meta = dataset.metadata;
    els.dataStamp.textContent = `${meta.playerCount} players • captured Aug 26, 2026`;
    els.datasetInfo.innerHTML = `
      <dt>Season</dt><dd>${meta.season}</dd>
      <dt>Players</dt><dd>${meta.playerCount}</dd>
      <dt>Source</dt><dd>Supplied ESPN pre-draft table</dd>
      <dt>Scoring</dt><dd>${escapeHtml(meta.scoringLabel)}</dd>`;

    const model = leagueModels[state.currentDraft.leagueId];
    els.replacementLevels.innerHTML = ALL_POSITIONS.map(pos => {
      const p = model.replacement[pos];
      const starter = model.starterBaseline[pos];
      return `<div class="replacement-card"><span>${pos} starter / replacement</span><strong>${fmt(starter)} / ${p ? fmt(p.projectedPoints) : '—'}</strong><small>${p ? `replacement: ${escapeHtml(p.name)}` : ''}</small></div>`;
    }).join('');
  }

  function persist() {
    try {
      localStorage.setItem(STORAGE.current, JSON.stringify(state.currentDraft));
      localStorage.setItem(STORAGE.mocks, JSON.stringify(state.savedMocks));
      localStorage.setItem(STORAGE.prefs, JSON.stringify({ activePosition: state.activePosition, sort: state.sort }));
      flashSaved('Saved in browser');
    } catch (err) {
      console.error(err);
      els.saveIndicator.textContent = 'Browser save failed';
    }
  }

  function flashSaved(message) {
    els.saveIndicator.textContent = message;
    window.clearTimeout(flashSaved.timer);
    flashSaved.timer = window.setTimeout(() => { els.saveIndicator.textContent = 'Ready'; }, 1300);
  }

  function exportBackup() {
    const backup = { version:1, updatedAt:new Date().toISOString(), savedMocks:state.savedMocks, currentDraft:state.currentDraft };
    const blob = new Blob([JSON.stringify(backup,null,2)], {type:'application/json'});
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'draft-backup.json';
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
    els.backupStatus.textContent = 'Backup exported. Replace data/draft-backup.json in the repo and commit it when you want cross-device restore.';
  }

  function validateBackup(obj) {
    return obj && obj.version === 1 && Array.isArray(obj.savedMocks);
  }

  function importBackupObject(obj, {merge=true, allowCurrent=true} = {}) {
    if (!validateBackup(obj)) throw new Error('That file is not a Fantasy Draft Companion v1 backup.');
    if (merge) {
      const byId = new Map(state.savedMocks.map(m => [m.id,m]));
      obj.savedMocks.forEach(m => byId.set(m.id,m));
      state.savedMocks = Array.from(byId.values()).sort((a,b) => String(b.savedAt || b.updatedAt || '').localeCompare(String(a.savedAt || a.updatedAt || '')));
    } else {
      state.savedMocks = obj.savedMocks;
    }
    if (allowCurrent && obj.currentDraft && (!state.currentDraft || state.currentDraft.picks.length === 0)) state.currentDraft = obj.currentDraft;
    persist();
    renderAll();
  }

  async function importBackupFile(file) {
    try {
      const obj = JSON.parse(await file.text());
      importBackupObject(obj, {merge:true, allowCurrent:true});
      els.backupStatus.textContent = 'Backup imported and merged with browser saves.';
    } catch (err) {
      els.backupStatus.textContent = err.message || 'Could not import backup.';
    } finally {
      els.importBackupInput.value = '';
    }
  }

  async function reloadRepoBackup({silent=false} = {}) {
    try {
      const res = await fetch(`./data/draft-backup.json?ts=${Date.now()}`, {cache:'no-store'});
      if (!res.ok) throw new Error(`Repo backup returned ${res.status}`);
      const obj = await res.json();
      importBackupObject(obj, {merge:true, allowCurrent:true});
      if (!silent) els.backupStatus.textContent = 'Repo backup loaded and merged.';
      return true;
    } catch (err) {
      if (!silent) els.backupStatus.textContent = `Repo backup could not be loaded: ${err.message}`;
      return false;
    }
  }

  function activateTab(name) {
    document.querySelectorAll('.tab').forEach(t => t.classList.toggle('active', t.dataset.tab === name));
    document.querySelectorAll('.tab-panel').forEach(p => p.classList.toggle('active', p.id === `tab-${name}`));
  }

  function wireEvents() {
    document.querySelectorAll('.tab').forEach(tab => tab.addEventListener('click', () => activateTab(tab.dataset.tab)));
    els.undoBtn.addEventListener('click', undoPick);
    els.newDraftBtn.addEventListener('click', resetDraft);
    els.saveSnapshotBtn.addEventListener('click', saveSnapshot);
    els.playerSearch.addEventListener('input', () => { state.search = els.playerSearch.value; renderBoard(); });
    els.sortSelect.addEventListener('change', () => { state.sort = els.sortSelect.value; persist(); renderBoard(); });
    els.positionFilters.addEventListener('click', (e) => {
      const btn = e.target.closest('[data-pos]');
      if (!btn) return;
      state.activePosition = btn.dataset.pos;
      els.positionFilters.querySelectorAll('.pill').forEach(p => p.classList.toggle('active', p === btn));
      persist(); renderBoard();
    });
    els.draftName.addEventListener('input', () => {
      state.currentDraft.name = els.draftName.value.slice(0,80);
      state.currentDraft.updatedAt = new Date().toISOString();
      persist();
    });
    els.leagueSelect.addEventListener('change', () => changeLeague(els.leagueSelect.value));
    els.draftSlot.addEventListener('change', () => changeSlot(els.draftSlot.value));
    els.exportBackupBtn.addEventListener('click', exportBackup);
    els.importBackupInput.addEventListener('change', () => {
      const file = els.importBackupInput.files?.[0];
      if (file) importBackupFile(file);
    });
    els.reloadRepoBackupBtn.addEventListener('click', () => reloadRepoBackup({silent:false}));
  }

  function changeLeague(newId) {
    if (!LEAGUES[newId]) return;
    if (state.currentDraft.picks.length && !window.confirm('Changing league format will reset the active draft. Continue?')) {
      els.leagueSelect.value = state.currentDraft.leagueId;
      return;
    }
    const oldName = state.currentDraft.name;
    const slot = Math.min(state.currentDraft.draftSlot, LEAGUES[newId].teams);
    state.currentDraft = makeNewDraft(newId, slot);
    state.currentDraft.name = oldName;
    persist(); renderAll();
  }

  function changeSlot(value) {
    const config = configFor();
    const newSlot = clampInt(value,1,config.teams,state.currentDraft.draftSlot);
    if (newSlot === state.currentDraft.draftSlot) { els.draftSlot.value = String(newSlot); return; }
    if (state.currentDraft.picks.length && !window.confirm('Changing draft slot will reset the active draft because pick ownership changes. Continue?')) {
      els.draftSlot.value = String(state.currentDraft.draftSlot);
      return;
    }
    const leagueId = state.currentDraft.leagueId;
    const oldName = state.currentDraft.name;
    state.currentDraft = makeNewDraft(leagueId,newSlot);
    state.currentDraft.name = oldName;
    persist(); renderAll();
  }

  function loadLocalState() {
    try {
      const current = JSON.parse(localStorage.getItem(STORAGE.current) || 'null');
      const mocks = JSON.parse(localStorage.getItem(STORAGE.mocks) || '[]');
      const prefs = JSON.parse(localStorage.getItem(STORAGE.prefs) || '{}');
      if (current?.leagueId && Array.isArray(current.picks)) state.currentDraft = current;
      if (Array.isArray(mocks)) state.savedMocks = mocks;
      if (prefs.activePosition) state.activePosition = prefs.activePosition;
      if (prefs.sort) state.sort = prefs.sort === 'recommendation' || prefs.sort === 'path' ? 'value' : prefs.sort;
    } catch (err) {
      console.warn('Could not load local state', err);
    }
    if (!state.currentDraft) state.currentDraft = makeNewDraft('12',1);
  }

  function escapeHtml(value) {
    return String(value ?? '').replace(/[&<>'"]/g, ch => ({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;'}[ch]));
  }

  async function init() {
    wireEvents();
    try {
      const res = await fetch('./data/players-2026.json');
      if (!res.ok) throw new Error(`Player data returned ${res.status}`);
      dataset = await res.json();
      players = dataset.players;
      playerMap = new Map(players.map(p => [p.id,p]));
      leagueModels = Object.fromEntries(Object.entries(LEAGUES).map(([id,config]) => [id,computeLeagueModel(config)]));
      tiers = computeTiers();
      loadLocalState();

      // On a fresh browser, seed from the committed repo backup if it contains anything.
      const hadLocalMocks = state.savedMocks.length > 0;
      const hadLocalPicks = state.currentDraft.picks.length > 0;
      if (!hadLocalMocks && !hadLocalPicks) await reloadRepoBackup({silent:true});

      els.positionFilters.querySelectorAll('.pill').forEach(p => p.classList.toggle('active', p.dataset.pos === state.activePosition));
      renderAll();
    } catch (err) {
      console.error(err);
      document.querySelector('main').innerHTML = `<section class="panel" style="padding:24px"><h2>Could not load the draft tool</h2><p>${escapeHtml(err.message)}</p><p class="footnote">If you opened index.html directly from your filesystem, serve this folder with a simple local web server or use GitHub Pages.</p></section>`;
    }
  }

  init();
})();
