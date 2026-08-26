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

  let dataset = null;
  let players = [];
  let playerMap = new Map();
  let leagueModels = {};
  let tiers = {};

  const state = {
    currentDraft: null,
    savedMocks: [],
    activePosition: 'ALL',
    search: '',
    sort: 'recommendation'
  };

  const $ = (id) => document.getElementById(id);

  const els = {
    leagueSelect: $('leagueSelect'), draftSlot: $('draftSlot'), draftName: $('draftName'),
    undoBtn: $('undoBtn'), newDraftBtn: $('newDraftBtn'), saveSnapshotBtn: $('saveSnapshotBtn'),
    currentPickMetric: $('currentPickMetric'), turnMetric: $('turnMetric'), nextPickMetric: $('nextPickMetric'),
    picksAwayMetric: $('picksAwayMetric'), rosterCountMetric: $('rosterCountMetric'), rosterNeedMetric: $('rosterNeedMetric'),
    progressMetric: $('progressMetric'), draftedMetric: $('draftedMetric'), recommendationCards: $('recommendationCards'),
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
    const drafted = new Set();
    const fixedPerTeam = { QB:1, RB:2, WR:2, TE:1, 'D/ST':1, K:1 };

    for (const pos of ALL_POSITIONS) {
      const need = config.teams * fixedPerTeam[pos];
      players.filter(p => p.position === pos).sort((a,b) => a.rank - b.rank).slice(0, need).forEach(p => drafted.add(p.id));
    }

    const flexNeed = config.teams * config.flex;
    players.filter(p => SKILL_POSITIONS.has(p.position) && !drafted.has(p.id))
      .sort((a,b) => a.rank - b.rank)
      .slice(0, flexNeed)
      .forEach(p => drafted.add(p.id));

    const benchNeed = config.teams * config.bench;
    players.filter(p => BENCH_POSITIONS.has(p.position) && !drafted.has(p.id))
      .sort((a,b) => a.rank - b.rank)
      .slice(0, benchNeed)
      .forEach(p => drafted.add(p.id));

    const replacement = {};
    for (const pos of ALL_POSITIONS) {
      const pool = players.filter(p => p.position === pos && !drafted.has(p.id) && Number.isFinite(p.projectedPoints));
      pool.sort((a,b) => b.projectedPoints - a.projectedPoints || a.rank - b.rank);
      replacement[pos] = pool[0] || null;
    }
    const flexPool = players.filter(p => SKILL_POSITIONS.has(p.position) && !drafted.has(p.id) && Number.isFinite(p.projectedPoints));
    flexPool.sort((a,b) => b.projectedPoints - a.projectedPoints || a.rank - b.rank);
    replacement.FLEX = flexPool[0] || null;

    const baseline = Object.fromEntries(Object.entries(replacement).map(([k,p]) => [k, p?.projectedPoints ?? 0]));
    const vorp = new Map();
    players.forEach(p => {
      const base = baseline[p.position] ?? 0;
      vorp.set(p.id, Number.isFinite(p.projectedPoints) ? p.projectedPoints - base : null);
    });

    return { config, expectedDrafted: drafted, replacement, baseline, vorp };
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

  function lineupValue(rosterPlayers, config, model, useReplacement = true) {
    const remaining = rosterPlayers.slice();
    let total = 0;
    const takeBestIndex = (predicate) => remaining.reduce((bestIdx,p,i) => {
      if (!predicate(p)) return bestIdx;
      if (bestIdx === -1) return i;
      return safeNumber(p.projectedPoints,-Infinity) > safeNumber(remaining[bestIdx].projectedPoints,-Infinity) ? i : bestIdx;
    }, -1);

    for (const slot of config.rosterSlots) {
      const predicate = slot === 'FLEX' ? p => SKILL_POSITIONS.has(p.position) : p => p.position === slot;
      const idx = takeBestIndex(predicate);
      const baseline = useReplacement ? (model.baseline[slot] || 0) : 0;
      if (idx === -1) {
        total += baseline;
      } else {
        const p = remaining.splice(idx,1)[0];
        total += useReplacement ? Math.max(baseline, safeNumber(p.projectedPoints,0)) : safeNumber(p.projectedPoints,0);
      }
    }
    return total;
  }

  function baselineLineupValue(config, model) {
    return config.rosterSlots.reduce((sum, slot) => sum + (model.baseline[slot] || 0), 0);
  }

  function conditionalGoneProbability(player, fromPick, toPick) {
    if (!player || !toPick || toPick <= fromPick) return 0;
    const rank = player.rank;
    const sigma = Math.max(5, Math.min(18, 4 + rank * 0.06));
    const cdf = (x) => 1 / (1 + Math.exp(-(x - rank) / sigma));
    const survivalFrom = Math.max(0.005, 1 - cdf(Math.max(0, fromPick - 1)));
    const survivalTo = Math.max(0.0001, 1 - cdf(Math.max(0, toPick - 1)));
    return Math.max(0, Math.min(0.995, 1 - survivalTo / survivalFrom));
  }

  function decisionTargetPick(draft = state.currentDraft) {
    const config = configFor(draft);
    const current = currentOverallPick(draft);
    if (current > totalPicks(config)) return null;
    const onClock = teamAtPick(current, config) === draft.draftSlot;
    return onClock ? nextUserPick(current + 1, draft) : nextUserPick(current, draft);
  }

  function expectedAlternative(player, availablePlayers, targetPick) {
    const same = availablePlayers.filter(p => p.id !== player.id && p.position === player.position && Number.isFinite(p.projectedPoints));
    if (!same.length) return null;
    const atOrAfter = same.filter(p => p.rank >= targetPick).sort((a,b) => a.rank - b.rank);
    if (atOrAfter.length) return atOrAfter[0];
    return same.sort((a,b) => b.rank - a.rank)[0];
  }

  function recommendationFor(player, availablePlayers, rosterPlayers, draft = state.currentDraft) {
    const config = configFor(draft);
    const model = leagueModels[draft.leagueId];
    const current = currentOverallPick(draft);
    const target = decisionTargetPick(draft);
    const rawVorp = model.vorp.get(player.id);
    const before = lineupValue(rosterPlayers, config, model, true);
    const after = lineupValue(rosterPlayers.concat(player), config, model, true);
    const lineupGain = Number.isFinite(player.projectedPoints) ? after - before : null;
    const alt = target ? expectedAlternative(player, availablePlayers, target) : null;
    const altVorp = alt ? model.vorp.get(alt.id) : null;
    const vona = Number.isFinite(rawVorp) && Number.isFinite(altVorp) ? rawVorp - altVorp : null;
    const gone = target ? conditionalGoneProbability(player, current, target) : 0;
    const marketValue = current - player.rank;
    const score = Number.isFinite(rawVorp)
      ? safeNumber(lineupGain) + 0.25 * rawVorp + 0.65 * Math.max(0, safeNumber(vona)) * gone + Math.max(-8, Math.min(10, marketValue * 0.35))
      : -Infinity;
    return {
      player, rawVorp, lineupGain, alt, vona, gone, targetPick: target, marketValue, score,
      tier: tiers[player.position]?.get(player.id) || null
    };
  }

  function recommendationReason(rec) {
    const pieces = [];
    if (Number.isFinite(rec.lineupGain) && rec.lineupGain > 20) pieces.push(`adds ${fmt(rec.lineupGain)} pts over your current replacement-based lineup`);
    else if (Number.isFinite(rec.rawVorp)) pieces.push(`${fmt(rec.rawVorp)} pts over modeled ${rec.player.position} replacement`);
    if (Number.isFinite(rec.vona) && rec.vona > 10 && rec.alt) pieces.push(`waiting projects to cost about ${fmt(rec.vona)} VORP vs ${rec.alt.name}`);
    if (rec.gone >= .65 && rec.targetPick) pieces.push(`${pct(rec.gone)} directional chance of going before ${formatPick(rec.targetPick, configFor())}`);
    if (rec.marketValue >= 6) pieces.push(`has slipped ${rec.marketValue} picks past ESPN rank`);
    if (!pieces.length) pieces.push('best blend of projection, replacement value, and current roster fit');
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
    const drafted = draftedSet();
    const available = players.filter(p => !drafted.has(p.id));
    const roster = userRosterIds().map(id => playerMap.get(id)).filter(Boolean);
    return available.map(p => recommendationFor(p, available, roster)).sort((a,b) => b.score - a.score || a.player.rank - b.player.rank);
  }

  function renderRecommendations() {
    const config = configFor();
    const current = currentOverallPick();
    if (current > totalPicks(config)) {
      els.recommendationCards.innerHTML = '<div class="empty-state panel">Draft complete. Save this draft as a mock to compare it in Mock Lab.</div>';
      return;
    }
    const recs = currentRecommendations().filter(r => Number.isFinite(r.score)).slice(0,3);
    els.recommendationCards.innerHTML = recs.map((r,i) => {
      const p = r.player;
      return `<article class="rec-card">
        <div class="rec-rank">
          <div>
            <div class="team-line">#${i+1} recommendation • ESPN ${p.rank}</div>
            <h3>${escapeHtml(p.name)} ${p.injuryStatus ? `<span class="status-badge">${p.injuryStatus}</span>` : ''}</h3>
            <div class="team-line">${escapeHtml(p.team)} • <span class="pos-badge">${p.position}</span> • Tier ${r.tier || '—'}</div>
          </div>
          <span class="score-badge">${Math.round(r.score)} score</span>
        </div>
        <div class="rec-metrics">
          <div><span>Projection</span><strong>${fmt(p.projectedPoints)}</strong></div>
          <div><span>VORP</span><strong>${fmt(r.rawVorp)}</strong></div>
          <div><span>Gone if wait</span><strong>${pct(r.gone)}</strong></div>
        </div>
        <p class="rec-reason">${escapeHtml(recommendationReason(r))}</p>
        <button class="button draft-player" type="button" data-player-id="${p.id}">${teamAtPick(current, config) === state.currentDraft.draftSlot ? 'Draft to my team' : 'Mark drafted'}</button>
      </article>`;
    }).join('');
    els.recommendationCards.querySelectorAll('.draft-player').forEach(btn => btn.addEventListener('click', () => draftPlayer(btn.dataset.playerId)));
  }

  function renderBoard() {
    const config = configFor();
    const current = currentOverallPick();
    const drafted = draftedSet();
    const available = players.filter(p => !drafted.has(p.id));
    const roster = userRosterIds().map(id => playerMap.get(id)).filter(Boolean);
    let recs = available.map(p => recommendationFor(p, available, roster));
    const q = state.search.trim().toLowerCase();
    if (state.activePosition !== 'ALL') recs = recs.filter(r => r.player.position === state.activePosition);
    if (q) recs = recs.filter(r => `${r.player.name} ${r.player.team} ${r.player.position}`.toLowerCase().includes(q));

    const sorters = {
      recommendation: (a,b) => b.score - a.score || a.player.rank - b.player.rank,
      rank: (a,b) => a.player.rank - b.player.rank,
      projection: (a,b) => safeNumber(b.player.projectedPoints,-Infinity) - safeNumber(a.player.projectedPoints,-Infinity) || a.player.rank-b.player.rank,
      vorp: (a,b) => safeNumber(b.rawVorp,-Infinity) - safeNumber(a.rawVorp,-Infinity),
      vona: (a,b) => safeNumber(b.vona,-Infinity) - safeNumber(a.vona,-Infinity)
    };
    recs.sort(sorters[state.sort] || sorters.recommendation);

    const isMine = current <= totalPicks(config) && teamAtPick(current,config) === state.currentDraft.draftSlot;
    els.playerTableBody.innerHTML = recs.map(r => {
      const p = r.player;
      const goneClass = r.gone >= .65 ? 'gone-high' : r.gone >= .35 ? 'gone-medium' : '';
      const vClass = safeNumber(r.rawVorp) >= 0 ? 'value-positive' : 'value-negative';
      return `<tr>
        <td>${p.rank}</td>
        <td><div class="player-name">${escapeHtml(p.name)} ${p.injuryStatus ? `<span class="status-badge">${p.injuryStatus}</span>` : ''}</div><div class="player-meta">${escapeHtml(p.team)}</div></td>
        <td><span class="pos-badge">${p.position}</span></td>
        <td class="num">${fmt(p.projectedPoints)}</td>
        <td class="num ${vClass}">${fmt(r.rawVorp)}</td>
        <td class="num">${fmt(r.vona)}</td>
        <td class="num ${goneClass}">${pct(r.gone)}</td>
        <td>${r.tier || '—'}</td>
        <td><button class="button tiny secondary draft-player" type="button" data-player-id="${p.id}" ${current > totalPicks(config) ? 'disabled' : ''}>${isMine ? 'Mine' : 'Drafted'}</button></td>
      </tr>`;
    }).join('');
    els.playerTableBody.querySelectorAll('.draft-player').forEach(btn => btn.addEventListener('click', () => draftPlayer(btn.dataset.playerId)));
    els.boardFootnote.textContent = `${recs.length} available shown. “Gone” is a directional estimate derived from ESPN overall rank because the supplied PDF does not include ADP.`;
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
    const actualStarter = lineupValue(roster, config, model, false);
    const aboveReplacement = lineupValue(roster, config, model, true) - baselineLineupValue(config, model);
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
      ['Starter gain vs replacement', i => fmt(metrics[i].aboveReplacement)],
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
      return `<div class="replacement-card"><span>${pos} replacement</span><strong>${p ? `${escapeHtml(p.name)} • ${fmt(p.projectedPoints)}` : '—'}</strong></div>`;
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
      if (prefs.sort) state.sort = prefs.sort;
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
