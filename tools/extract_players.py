import fitz, re, json, os, unicodedata
import sys
PDF=sys.argv[1] if len(sys.argv)>1 else 'Pre-Draft Strategy Data.pdf'
OUT=sys.argv[2] if len(sys.argv)>2 else 'data/players-2026.json'
doc=fitz.open(PDF)
positions={'QB','RB','WR','TE','D/ST','K'}
statuses={'Q','O','D','IR','SUSP','PUP','NFI','NA'}
candidates={}
for pi in range(1,19):
    page=doc[pi]
    words=page.get_text('words')
    for w in words:
        x0,y,x1,y1,t,*_=w
        if not (85 <= x0 <= 110 and re.fullmatch(r'\d{1,3}', t)):
            continue
        rank=int(t)
        if not (1<=rank<=400): continue
        # Stats line: numeric or -- cells on the same baseline to the right.
        stat_ws=sorted([ww for ww in words if ww[0]>340 and abs(ww[1]-y)<0.8 and (re.fullmatch(r'-?\d+(?:\.\d+)?',ww[4]) or ww[4]=='--')], key=lambda z:z[0])
        stat_tokens=[ww[4] for ww in stat_ws]

        pws=[ww for ww in words if 110<=ww[0]<345 and y-8.5<=ww[1]<=y+14.5]
        groups={}
        for ww in pws:
            ky=round(ww[1],1)
            groups.setdefault(ky,[]).append(ww)
        sg=sorted(groups.items())
        above=[g for g in sg if y-8.5<=g[0]<=y+1.5]
        below=[g for g in sg if y+1.5<g[0]<=y+14.5]
        nameg=min(above,key=lambda g:abs(g[0]-(y-4.2))) if above else None
        teamg=min(below,key=lambda g:abs(g[0]-(y+5.4))) if below else None
        name_tokens=[]; status=None
        nearby_status=[ww[4] for ww in pws if y-8.5<=ww[1]<=y+1.5 and ww[4] in statuses]
        if nearby_status: status=nearby_status[0]
        if nameg:
            for ww in sorted(nameg[1], key=lambda z:z[0]):
                token=ww[4]
                if token in statuses:
                    status=token
                else:
                    name_tokens.append(token)
        name=' '.join(name_tokens).strip()
        team=None; pos=None; elig=[]
        if teamg:
            toks=[ww[4] for ww in sorted(teamg[1],key=lambda z:z[0])]
            pos_idx=None
            for i,token in enumerate(toks):
                clean=token.rstrip(',')
                if clean in positions:
                    pos_idx=i; pos=clean; break
            if pos_idx is not None:
                team=''.join(toks[:pos_idx]).replace(',','').strip()
                for token in toks[pos_idx:]:
                    clean=token.rstrip(',')
                    if clean in positions and clean not in elig: elig.append(clean)
                if not elig: elig=[pos]
        candidates.setdefault(rank,[]).append({
            'page':pi+1,'y':y,'name':name,'status':status,'team':team,'position':pos,'eligibility':elig,'stat_tokens':stat_tokens
        })

# Helpers for merged page-break rows.
def name_quality(s):
    if not s: return -100
    toks=s.split()
    # favor real multi-character name tokens; heavily penalize fragments.
    good=sum(len(re.sub(r"[^A-Za-z'-]",'',x))>=3 for x in toks)
    tiny=sum(len(re.sub(r"[^A-Za-z'-]",'',x))<=2 for x in toks)
    return good*10 + len(s) - tiny*5

players=[]
for rank in range(1,401):
    cs=candidates.get(rank,[])
    if not cs: raise RuntimeError(f'Missing rank {rank}')
    best_name=max(cs,key=lambda c:name_quality(c['name']))
    best_pos=max(cs,key=lambda c:(c['position'] is not None, len(c['team'] or '')))
    # prefer exactly 13 values. If -- row, there are 13 -- tokens.
    exact=[c for c in cs if len(c['stat_tokens'])==13]
    best_stats=exact[-1] if exact else max(cs,key=lambda c:len(c['stat_tokens']))
    name=best_name['name']
    team=best_pos['team']; pos=best_pos['position']; elig=best_pos['eligibility']
    status=next((c['status'] for c in cs if c['status']),None)

    # Manual page-break fixes where the PDF visually continues the same row across pages.
    if rank==18: name='Saquon Barkley'; team='PHI'; pos='RB'; elig=['RB']
    if rank==132: team='CAR'; pos='WR'; elig=['WR']
    if rank==155: name='Isiah Pacheco'; team='DET'; pos='RB'; elig=['RB']; status='Q'
    if rank==269: team='PIT'; pos='QB'; elig=['QB']

    toks=best_stats['stat_tokens']
    if len(toks)!=13:
        # Anthony Richardson has dashes for every projected field; PyMuPDF catches them.
        if rank==337:
            toks=['--']*13
        else:
            raise RuntimeError(f'Rank {rank} has {len(toks)} stat tokens: {toks}; candidates={cs}')
    def val(x, integer=False):
        if x=='--': return None
        return int(float(x)) if integer else float(x)
    fields=['passingYards','passingTD','interceptionsThrown','rushingYards','rushingTD','receptions','receivingYards','receivingTD','defensiveInterceptions','fumbleRecoveries','pointsAllowed','yardsAllowed','fantasyPoints']
    stats={}
    for i,(field,tok) in enumerate(zip(fields,toks)):
        stats[field]=val(tok, integer=(field!='fantasyPoints'))
    players.append({
        'id':f'p{rank:03d}',
        'rank':rank,
        'name':name,
        'team':team,
        'position':pos,
        'eligibility':elig,
        'injuryStatus':status,
        'projectedPoints':stats['fantasyPoints'],
        'stats':stats,
    })

# validation
assert len(players)==400
assert all(p['rank']==i+1 for i,p in enumerate(players))
assert all(p['name'] and p['team'] and p['position'] for p in players)
assert len({p['id'] for p in players})==400

payload={
  'metadata':{
    'season':2026,
    'source':'ESPN Pre-Draft Strategy PDF supplied by user',
    'sourceCapturedAt':'2026-08-26T11:38:00-04:00',
    'scoringLabel':'Half PPR (per user; projected FPTS are taken from the supplied ESPN table)',
    'playerCount':400,
    'notes':['ESPN overall rank is used as a market/draft-order proxy in v1; the supplied PDF does not contain ADP.','Anthony Richardson Sr. (rank 337) has no projected stat line in the supplied table.']
  },
  'players':players
}
os.makedirs(os.path.dirname(OUT),exist_ok=True)
with open(OUT,'w',encoding='utf-8') as f: json.dump(payload,f,indent=2,ensure_ascii=False)
print('wrote',OUT)
from collections import Counter
print('positions',Counter(p['position'] for p in players))
print('injury',Counter(p['injuryStatus'] for p in players if p['injuryStatus']))
for r in [1,17,18,132,155,169,200,269,337,359,400]:
 p=players[r-1]; print(r,p['name'],p['team'],p['position'],p['projectedPoints'],p['injuryStatus'])
