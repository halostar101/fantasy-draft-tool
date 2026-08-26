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
    lookaheadCandidateLimit: 48
  };

  let dataset = null;
  let players = [];
  let playerMap = new Map();
  let leagueModels = {};
  let tiers = {};
  let recommendationCache = { key: null, recs: [] };

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
    const decisionValue = (1 - MODEL.marketPriorWeight) * structuralValue + MODEL.marketPriorWeight * marketPrior;
    return { rawVorp, rawVols, starterGain, structuralValue, marketPrior, decisionValue };
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
    const options = nextPickPool.filter(x => x.player.id !== firstPlayer.id).map(x => {
      const value = marginalRosterValue(x.player, nextRoster, draft);
      return { player:x.player, value:value.decisionValue || 0, survival:x.survival };
    }).filter(x => x.value > 0).sort((a,b) => b.value - a.value || a.player.rank - b.player.rank);

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

  function recommendationFor(player, availablePlayers, rosterPlayers, draft = state.currentDraft, context = decisionContext(draft), nextPickPool = buildNextPickPool(availablePlayers, draft, context)) {
    const value = marginalRosterValue(player, rosterPlayers, draft);
    if (!Number.isFinite(value.decisionValue)) {
      return { player, ...value, currentValue:-Infinity, onClockScore:-Infinity, targetScore:-Infinity, pathValue:null, waitCost:null, gone:0, beforeMyPick:0, alt:null, expectedNext:null, tier:null };
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

    // Keep three questions separate instead of hiding them in one blended score:
    // 1) currentValue = how much we value the player if he is available right now.
    // 2) targetScore = planning utility before our turn (value × chance he reaches us).
    // 3) onClockScore = two-pick path value once the choice is real and availability is known.
    const currentValue = value.decisionValue;
    const targetAvailability = context.onClock ? 1 : (1 - beforeMyPick);
    const targetScore = currentValue * targetAvailability;
    const onClockScore = pathValue;

    return {
      player, ...value, alt, waitCost, vona:waitCost, gone, beforeMyPick, expectedNext,
      currentValue, targetScore, onClockScore, pathValue, marketValue, targetPick:context.followingPick,
      tier: tiers[player.position]?.get(player.id) || null
    };
  }

  function recommendationReason(rec, valueRank = null) {
    const pieces = [];
    const context = decisionContext();
    if (!context.onClock) {
      if (valueRank) pieces.push(`#${valueRank} on the current-value board`);
      if (context.decisionPick) pieces.push(`${pct(1 - rec.beforeMyPick)} estimated chance to reach ${formatPick(context.decisionPick, configFor())}`);
      if (Number.isFinite(rec.rawVols)) pieces.push(`${fmt(rec.rawVols)} pts over the last modeled ${rec.player.position} starter`);
      return pieces.slice(0,3).join('; ') + '.';
    }

    if (Number.isFinite(rec.starterGain) && rec.starterGain > 8) pieces.push(`adds ${fmt(rec.starterGain)} pts above the modeled starter baseline`);
    else if (Number.isFinite(rec.rawVols)) pieces.push(`${fmt(rec.rawVols)} pts over the last modeled ${rec.player.position} starter`);
    if (rec.expectedNext?.likelyPlayer && rec.targetPick) pieces.push(`two-pick lookahead most often pairs him with ${rec.expectedNext.likelyPlayer.name} around ${formatPick(rec.targetPick, configFor())}`);
    if (Number.isFinite(rec.waitCost) && rec.waitCost > 8 && rec.alt) pieces.push(`waiting at ${rec.player.position} costs about ${fmt(rec.waitCost)} model-value vs ${rec.alt.name}`);
    else if (rec.gone >= .65 && rec.targetPick) pieces.push(`${pct(rec.gone)} directional chance of going before ${formatPick(rec.targetPick, configFor())} if you pass`);
    if (!pieces.length) pieces.push('best current blend of player value, roster fit, and next-pick opportunity cost');
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
    const key = `${draft.id}|${draft.updatedAt}|${draft.leagueId}|${draft.draftSlot}|${draft.picks.length}`;
    if (recommendationCache.key === key) return recommendationCache.recs;
    const drafted = draftedSet();
    const available = players.filter(p => !drafted.has(p.id));
    const roster = userRosterIds().map(id => playerMap.get(id)).filter(Boolean);
    const context = decisionContext(draft);
    const nextPickPool = buildNextPickPool(available, draft, context);
    const recs = available.map(p => recommendationFor(p, available, roster, draft, context, nextPickPool))
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
    if (context.onClock) {
      recs = all.slice().sort((a,b) => b.onClockScore - a.onClockScore || b.currentValue - a.currentValue || a.player.rank - b.player.rank).slice(0,3);
      els.recommendationEyebrow.textContent = 'Decision support';
      els.recommendationTitle.textContent = 'Best choices right now';
      els.recommendationHint.textContent = 'You are on the clock. These cards compare actual available players using current model value plus the expected value of your following pick.';
    } else {
      recs = all.filter(r => (1 - r.beforeMyPick) > 0.02)
        .sort((a,b) => b.targetScore - a.targetScore || b.currentValue - a.currentValue || a.player.rank - b.player.rank)
        .slice(0,3);
      els.recommendationEyebrow.textContent = 'Planning ahead';
      els.recommendationTitle.textContent = context.decisionPick ? `Likely targets at ${formatPick(context.decisionPick, config)}` : 'Likely targets';
      els.recommendationHint.textContent = 'This is a planning list, not a player ranking: target score is current model value × estimated chance the player reaches your upcoming pick. The Draft Board below stays ordered by player value.';
    }

    els.recommendationCards.innerHTML = recs.map((r,i) => {
      const p = r.player;
      const rank = valueRank.get(p.id);
      const displayedGone = context.onClock ? r.gone : r.beforeMyPick;
      const goneLabel = context.onClock ? 'Gone if wait' : 'Gone by my pick';
      const badge = context.onClock ? `2-pick ${fmt(r.pathValue)}` : `Avail ${pct(1 - r.beforeMyPick)}`;
      const label = context.onClock ? `#${i+1} recommendation` : `#${i+1} likely target`;
      return `<article class="rec-card">
        <div class="rec-rank">
          <div>
            <div class="team-line">${label} • Model rank ${rank || '—'} • ESPN ${p.rank}</div>
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
        </div>
        ${context.onClock ? `<div class="path-line"><span>Likely next:</span><strong>${r.expectedNext?.likelyPlayer ? escapeHtml(r.expectedNext.likelyPlayer.name) : '—'}</strong></div>` : ''}
        <p class="rec-reason">${escapeHtml(recommendationReason(r, rank))}</p>
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
    els.boardFootnote.textContent = `${recs.length} available shown. The default Draft Board order is current model value only; availability does not change that order. VOLS uses the modeled last starter and VORP uses the deeper waiver line. “Gone” is the ${goneMeaning}; it is a heuristic based on ESPN rank because the PDF does not include ADP. Two-pick lookahead is used only for the on-clock recommendation cards above.`;
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
