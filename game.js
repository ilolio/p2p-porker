// ─────────────────────────────────────────
//  Deck & Hand Evaluation
// ─────────────────────────────────────────
const SUITS = ['♠','♥','♦','♣'];
const RANKS = ['2','3','4','5','6','7','8','9','10','J','Q','K','A'];
const RANK_VAL = Object.fromEntries(RANKS.map((r,i) => [r, i+2]));

function makeDeck() {
  const d = [];
  for (const s of SUITS) for (const r of RANKS) d.push({r, s});
  return d;
}

function shuffle(arr) {
  const a = [...arr];
  for (let i = a.length-1; i>0; i--) {
    const j = Math.floor(Math.random()*(i+1));
    [a[i],a[j]] = [a[j],a[i]];
  }
  return a;
}

function cardVal(c) { return RANK_VAL[c.r]; }

// Returns {rank, name, tiebreak[]}
function evaluateHand(cards) {
  // best 5 from up to 7 cards
  const combos = choose5(cards);
  let best = null;
  for (const c of combos) {
    const e = eval5(c);
    if (!best || compare(e, best) > 0) best = e;
  }
  return best;
}

function choose5(cards) {
  const result = [];
  const n = cards.length;
  for (let a=0; a<n-4; a++)
  for (let b=a+1; b<n-3; b++)
  for (let c=b+1; c<n-2; c++)
  for (let d=c+1; d<n-1; d++)
  for (let e=d+1; e<n; e++)
    result.push([cards[a],cards[b],cards[c],cards[d],cards[e]]);
  return result;
}

function eval5(cards) {
  const vals = cards.map(cardVal).sort((a,b)=>b-a);
  const suits = cards.map(c=>c.s);
  const flush = suits.every(s=>s===suits[0]);
  const straight = isStraight(vals);

  const counts = {};
  for (const v of vals) counts[v] = (counts[v]||0)+1;
  const groups = Object.entries(counts)
    .sort((a,b) => b[1]-a[1] || b[0]-a[0])
    .map(([v,n])=>({v:+v,n}));

  if (flush && straight) {
    const isRoyal = vals[0]===14 && vals[1]===13;
    return { rank: isRoyal?9:8, name: isRoyal?'ロイヤルフラッシュ':'ストレートフラッシュ', tb: vals };
  }
  if (groups[0].n===4) return { rank:7, name:'フォーカード', tb: [groups[0].v, groups[1].v] };
  if (groups[0].n===3 && groups[1].n===2) return { rank:6, name:'フルハウス', tb: [groups[0].v, groups[1].v] };
  if (flush) return { rank:5, name:'フラッシュ', tb: vals };
  if (straight) return { rank:4, name:'ストレート', tb: vals };
  if (groups[0].n===3) return { rank:3, name:'スリーカード', tb: [groups[0].v, groups[1].v, groups[2].v] };
  if (groups[0].n===2 && groups[1].n===2) return { rank:2, name:'ツーペア', tb: [groups[0].v, groups[1].v, groups[2].v] };
  if (groups[0].n===2) return { rank:1, name:'ワンペア', tb: [groups[0].v, ...vals.filter(v=>v!==groups[0].v)] };
  return { rank:0, name:'ハイカード', tb: vals };
}

function isStraight(vals) {
  const s = [...new Set(vals)];
  if (s.length < 5) return false;
  if (s[0]-s[4]===4) return true;
  // A-2-3-4-5
  if (s[0]===14 && s[1]===5 && s[2]===4 && s[3]===3 && s[4]===2) return true;
  return false;
}

function compare(a, b) {
  if (a.rank !== b.rank) return a.rank - b.rank;
  for (let i=0; i<Math.max(a.tb.length,b.tb.length); i++) {
    const d = (a.tb[i]||0) - (b.tb[i]||0);
    if (d) return d;
  }
  return 0;
}

// ─────────────────────────────────────────
//  UI helpers
// ─────────────────────────────────────────
function cardHTML(card, faceDown=false) {
  if (faceDown) return `<div class="card back"></div>`;
  const red = card.s==='♥'||card.s==='♦';
  return `<div class="card${red?' red':''}">
    <div>${card.r}</div><div class="suit">${card.s}</div>
  </div>`;
}

function log(msg) {
  const el = document.getElementById('gameLog');
  if (!el) return;
  const p = document.createElement('p');
  p.textContent = msg;
  el.appendChild(p);
  el.scrollTop = el.scrollHeight;
}

function setStatus(id, msg) {
  const el = document.getElementById(id);
  if (el) el.textContent = msg;
}

// ─────────────────────────────────────────
//  Game State (host-authoritative)
// ─────────────────────────────────────────
const STARTING_CHIPS = 1000;
const SMALL_BLIND = 10;
const BIG_BLIND = 20;

let state = null; // full game state, only host manages

function newState(players) {
  return {
    players: players.map((p,i) => ({
      id: p.id, name: p.name, chips: STARTING_CHIPS,
      hand: [], bet: 0, totalBet: 0, folded: false, allIn: false,
      seatIndex: i,
    })),
    deck: [],
    community: [],
    pot: 0,
    phase: 'waiting', // waiting | preflop | flop | turn | river | showdown
    dealerIdx: 0,
    currentIdx: 0,
    currentBet: 0,
    lastRaiser: -1,
    firstToActIdx: 0,
    handNum: 0,
  };
}

// ─────────────────────────────────────────
//  Network layer
// ─────────────────────────────────────────
let myPeer = null;
let myId = '';
let myName = '';
let isHost = false;
let hostConn = null; // guest -> host connection
let guestConns = {}; // host -> { peerId: DataConnection }
let players = []; // lobby list [{id, name}]
let myStateView = null; // local copy of game state view

function broadcast(msg) {
  for (const conn of Object.values(guestConns)) {
    try { conn.send(msg); } catch(e) {}
  }
}

function sendToHost(msg) {
  if (isHost) { handleHostMsg(myId, msg); return; }
  try { hostConn.send(msg); } catch(e) { console.error(e); }
}

function sendTo(peerId, msg) {
  if (peerId === myId) { handleGuestMsg(msg); return; }
  const conn = guestConns[peerId];
  if (conn) conn.send(msg);
}

function handleHostMsg(fromId, msg) {
  // Messages from guests (or self) to host
  if (msg.type === 'join') {
    if (state) { sendTo(fromId, {type:'error', text:'ゲーム中です'}); return; }
    if (players.find(p=>p.id===fromId)) return;
    players.push({id: fromId, name: msg.name});
    broadcast({type:'lobby', players});
    sendTo(fromId, {type:'lobby', players});
    renderLobby();
  } else if (msg.type === 'action') {
    processAction(fromId, msg);
  } else if (msg.type === 'readyNext') {
    readyPlayers.add(fromId);
    if (readyPlayers.size >= state.players.filter(p=>p.chips>0).length) {
      startHand();
    }
  }
}

function handleGuestMsg(msg) {
  // Messages from host
  if (msg.type === 'lobby') {
    players = msg.players;
    renderLobby();
  } else if (msg.type === 'gameState') {
    myStateView = msg.state;
    renderGame(msg.state);
  } else if (msg.type === 'error') {
    log('エラー: ' + msg.text);
  } else if (msg.type === 'log') {
    log(msg.text);
  }
}

// ─────────────────────────────────────────
//  Lobby UI
// ─────────────────────────────────────────
function renderLobby() {
  const list = document.getElementById('playerList');
  const hostId = players[0]?.id;
  list.innerHTML = players.map(p =>
    `<div class="player-item">
      ${p.id===hostId ? '<span class="badge">ホスト</span>' : ''}
      <span>${p.name}</span>
    </div>`
  ).join('');
  const startBtn = document.getElementById('startBtn');
  if (isHost) {
    startBtn.classList.remove('hidden');
    startBtn.disabled = players.length < 2;
    startBtn.textContent = `ゲーム開始 (${players.length}人)`;
  }
}

// ─────────────────────────────────────────
//  Hand logic (host only)
// ─────────────────────────────────────────
let readyPlayers = new Set();

function startHand() {
  readyPlayers.clear();
  state.handNum++;
  state.deck = shuffle(makeDeck());
  state.community = [];
  state.pot = 0;
  state.phase = 'preflop';

  const alive = state.players.filter(p => p.chips > 0);
  if (alive.length < 2) { endGame(); return; }

  // reset players
  for (const p of state.players) {
    p.hand = []; p.bet = 0; p.totalBet = 0; p.folded = p.chips===0; p.allIn = false;
  }

  // rotate dealer
  state.dealerIdx = (state.dealerIdx + 1) % state.players.length;
  while (state.players[state.dealerIdx].chips===0)
    state.dealerIdx = (state.dealerIdx+1) % state.players.length;

  // deal 2 cards each
  for (const p of state.players) {
    if (!p.folded) { p.hand = [state.deck.pop(), state.deck.pop()]; }
  }

  // blinds
  const activePlayers = state.players.filter(p=>!p.folded);
  const n = activePlayers.length;
  const dealerPos = activePlayers.findIndex(p=>p.id===state.players[state.dealerIdx].id);
  const sbPos = n===2 ? dealerPos : (dealerPos+1)%n;
  const bbPos = n===2 ? (dealerPos+1)%n : (dealerPos+2)%n;

  const sb = activePlayers[sbPos];
  const bb = activePlayers[bbPos];
  placeBet(sb, SMALL_BLIND);
  placeBet(bb, BIG_BLIND);
  state.currentBet = BIG_BLIND;
  state.lastRaiser = -1;

  // first to act: after BB (or SB in heads-up)
  const firstPos = (bbPos+1)%n;
  state.currentIdx = activePlayers[firstPos].seatIndex;
  state.firstToActIdx = state.currentIdx;

  broadcastState(`ハンド #${state.handNum} 開始`);
  log(`[Host] ハンド #${state.handNum} 開始`);
}

function placeBet(player, amount) {
  const actual = Math.min(amount, player.chips);
  player.chips -= actual;
  player.bet += actual;
  player.totalBet += actual;
  state.pot += actual;
  if (player.chips === 0) player.allIn = true;
}

function broadcastState(logMsg) {
  if (logMsg) {
    broadcast({type:'log', text: logMsg});
    log(logMsg);
  }
  for (const p of state.players) {
    const view = buildStateView(p.id);
    sendTo(p.id, {type:'gameState', state: view});
  }
}

function buildStateView(forPlayerId) {
  return {
    ...state,
    players: state.players.map(p => ({
      ...p,
      // hide other players' hole cards unless showdown
      hand: (p.id===forPlayerId || state.phase==='showdown')
        ? p.hand
        : p.hand.map(() => null),
    })),
    myId: forPlayerId,
  };
}

function processAction(fromId, msg) {
  const p = state.players.find(p=>p.id===fromId);
  if (!p || p.folded || p.allIn) return;
  if (state.players[state.currentIdx]?.id !== fromId) return;

  const action = msg.action;
  const callAmt = state.currentBet - p.bet;

  if (action === 'fold') {
    p.folded = true;
    log(`${p.name} がフォールド`);
    broadcastState(`${p.name}: フォールド`);
  } else if (action === 'check') {
    if (callAmt > 0) return; // invalid
    log(`${p.name} がチェック`);
    broadcastState(`${p.name}: チェック`);
  } else if (action === 'call') {
    placeBet(p, callAmt);
    broadcastState(`${p.name}: コール ${callAmt}`);
  } else if (action === 'raise') {
    const total = msg.amount;
    if (total <= state.currentBet) return;
    placeBet(p, total - p.bet);
    state.currentBet = total;
    state.lastRaiser = p.seatIndex;
    broadcastState(`${p.name}: レイズ → ${total}`);
  }

  advanceTurn();
}

function advanceTurn() {
  const active = state.players.filter(p=>!p.folded && !p.allIn);
  const notFolded = state.players.filter(p=>!p.folded);

  // Only 1 player left
  if (notFolded.length === 1) { showdown(); return; }

  // Find next player
  let idx = state.currentIdx;
  let next = -1;
  for (let i=1; i<=state.players.length; i++) {
    const ni = (idx+i) % state.players.length;
    const np = state.players[ni];
    if (!np.folded && !np.allIn) {
      next = ni; break;
    }
  }

  // Check if betting round is over:
  // - with a bet/raise: done when everyone has called and action returns to the raiser
  // - no bet (all checks): done when action returns to the first player of the street
  const bettingDone = active.every(p => p.bet === state.currentBet) &&
    (active.length === 0 ||
     (state.lastRaiser !== -1
       ? state.players[next]?.seatIndex === state.lastRaiser
       : next === state.firstToActIdx));

  // Also done if everyone is all-in or only one active
  const allDone = active.length <= 1;

  if (bettingDone || allDone || next === -1) {
    nextPhase();
  } else {
    state.currentIdx = next;
    broadcastState();
  }
}

function nextPhase() {
  // reset bets for next street
  for (const p of state.players) { p.bet = 0; }
  state.currentBet = 0;
  state.lastRaiser = -1;
  state.firstToActIdx = -1;

  if (state.phase === 'preflop') {
    state.community.push(state.deck.pop(), state.deck.pop(), state.deck.pop());
    state.phase = 'flop';
  } else if (state.phase === 'flop') {
    state.community.push(state.deck.pop());
    state.phase = 'turn';
  } else if (state.phase === 'turn') {
    state.community.push(state.deck.pop());
    state.phase = 'river';
  } else if (state.phase === 'river') {
    showdown(); return;
  }

  // set first to act: first active after dealer
  const notFolded = state.players.filter(p=>!p.folded);
  if (notFolded.filter(p=>!p.allIn).length <= 1) {
    // run out remaining streets and showdown
    runOut(); return;
  }

  const dealerIdx = state.dealerIdx;
  for (let i=1; i<=state.players.length; i++) {
    const ni = (dealerIdx+i) % state.players.length;
    if (!state.players[ni].folded && !state.players[ni].allIn) {
      state.currentIdx = ni; break;
    }
  }
  state.firstToActIdx = state.currentIdx;
  broadcastState(`[${state.phase.toUpperCase()}]`);
}

function runOut() {
  while (state.community.length < 5) state.community.push(state.deck.pop());
  state.phase = 'river';
  broadcastState('ランアウト');
  setTimeout(showdown, 800);
}

function showdown() {
  state.phase = 'showdown';
  const notFolded = state.players.filter(p=>!p.folded);

  // evaluate hands
  const evals = notFolded.map(p => ({
    p,
    ev: evaluateHand([...p.hand, ...state.community]),
  }));
  evals.sort((a,b) => compare(b.ev, a.ev));

  // Award pot (simplified: winner takes all, side pots TODO)
  const winner = evals[0];
  winner.p.chips += state.pot;
  state.pot = 0;

  const resultText = evals.map(e =>
    `${e.p.name}: ${e.ev.name}`
  ).join('\n');

  broadcastState(`勝者: ${winner.p.name} (${winner.ev.name})`);

  // Send showdown result to all
  for (const p of state.players) {
    const view = buildStateView(p.id);
    sendTo(p.id, {type:'gameState', state: {...view, showdownResult: {
      winner: winner.p.id,
      winnerName: winner.p.name,
      handName: winner.ev.name,
      details: resultText,
    }}});
  }
}

function endGame() {
  const winner = state.players.reduce((a,b)=>a.chips>b.chips?a:b);
  broadcast({type:'log', text:`ゲーム終了！ 優勝: ${winner.name}`});
  log(`ゲーム終了！ 優勝: ${winner.name}`);
}

// ─────────────────────────────────────────
//  Render game state (all clients)
// ─────────────────────────────────────────
function renderGame(sv) {
  document.getElementById('lobby').classList.add('hidden');
  document.getElementById('roomScreen').classList.add('hidden');
  document.getElementById('gameScreen').classList.remove('hidden');

  const me = sv.players.find(p=>p.id===sv.myId);
  const others = sv.players.filter(p=>p.id!==sv.myId);

  // Community cards
  const cc = document.getElementById('communityCards');
  cc.innerHTML = sv.community.length
    ? sv.community.map(c=>cardHTML(c)).join('')
    : '<span style="color:#555;font-size:.85rem">コミュニティカード</span>';

  document.getElementById('potDisplay').textContent = `Pot: ${sv.pot}`;
  document.getElementById('phaseDisplay').textContent = phaseLabel(sv.phase);

  // Opponents
  const oppEl = document.getElementById('opponents');
  oppEl.innerHTML = others.map(p => {
    const isActive = sv.players[sv.currentIdx]?.id === p.id;
    return `<div class="opponent-box${p.folded?' folded':''}${isActive?' active':''}">
      <div class="opp-name">${escHtml(p.name)}${p.id===sv.players[sv.dealerIdx]?.id?' <span class="badge-dealer">D</span>':''}</div>
      <div class="opp-chips">${p.chips} chips</div>
      <div class="opp-bet">${p.bet>0?'Bet: '+p.bet:''}</div>
      <div class="opp-cards">
        ${(p.hand||[]).map(c=>c?cardHTML(c):cardHTML(null,true)).join('')}
      </div>
    </div>`;
  }).join('');

  // My area
  const myInfo = document.getElementById('myInfo');
  myInfo.textContent = `${me?.name || ''} | ${me?.chips ?? 0} chips${me?.bet>0?' | Bet: '+me.bet:''}${me?.folded?' | FOLD':''}`;

  const myCards = document.getElementById('myCards');
  myCards.innerHTML = (me?.hand||[]).map(c=>c?cardHTML(c):cardHTML(null,true)).join('');

  // Actions
  const isMyTurn = sv.players[sv.currentIdx]?.id === sv.myId && !me?.folded && sv.phase!=='showdown' && sv.phase!=='waiting';
  const actionArea = document.getElementById('actionArea');
  const waitMsg = document.getElementById('waitMsg');

  if (isMyTurn) {
    actionArea.classList.remove('hidden');
    waitMsg.textContent = '';
    const callAmt = sv.currentBet - (me?.bet||0);
    document.getElementById('callLabel').textContent = callAmt>0 ? `コール額: ${callAmt}` : '';
    document.getElementById('btnCall').textContent = callAmt>0 ? `コール (${callAmt})` : 'コール';
    document.getElementById('btnCheck').style.display = callAmt>0 ? 'none' : '';
    document.getElementById('btnCall').style.display = callAmt>0 ? '' : 'none';
    const minRaise = sv.currentBet * 2 || BIG_BLIND;
    document.getElementById('raiseAmount').value = minRaise;
    document.getElementById('raiseAmount').min = minRaise;
  } else {
    actionArea.classList.add('hidden');
    if (sv.phase==='waiting') waitMsg.textContent = 'ゲーム開始を待っています...';
    else if (me?.folded) waitMsg.textContent = 'フォールドしました';
    else waitMsg.textContent = '他のプレイヤーのターンです...';
  }

  // Result overlay
  const overlay = document.getElementById('resultOverlay');
  if (sv.showdownResult) {
    overlay.classList.remove('hidden');
    document.getElementById('resultTitle').textContent =
      sv.showdownResult.winnerName === me?.name ? '🏆 あなたの勝ち!' : `${escHtml(sv.showdownResult.winnerName)} の勝ち`;
    document.getElementById('resultDetails').innerHTML =
      escHtml(sv.showdownResult.details).replace(/\n/g,'<br>') +
      `<br><br>勝利ハンド: <strong>${escHtml(sv.showdownResult.handName)}</strong>`;
    const nextBtn = document.getElementById('nextHandBtn');
    if (isHost) { nextBtn.classList.remove('hidden'); } else {
      nextBtn.classList.add('hidden');
      document.getElementById('resultDetails').innerHTML +=
        '<br><br><em>ホストが次のハンドを開始するのを待っています</em>';
    }
  } else {
    overlay.classList.add('hidden');
  }
}

function phaseLabel(p) {
  return {waiting:'待機中',preflop:'プリフロップ',flop:'フロップ',turn:'ターン',river:'リバー',showdown:'ショーダウン'}[p] || p;
}

function escHtml(s) {
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

// ─────────────────────────────────────────
//  Event wiring
// ─────────────────────────────────────────
document.getElementById('hostBtn').addEventListener('click', () => {
  myName = document.getElementById('playerName').value.trim() || 'Player1';
  setStatus('lobbyStatus', '接続中...');
  myPeer = new Peer(undefined, {config: {iceServers: [{urls:'stun:stun.l.google.com:19302'}]}});

  myPeer.on('open', id => {
    myId = id;
    isHost = true;
    players = [{id: myId, name: myName}];
    document.getElementById('lobby').classList.add('hidden');
    document.getElementById('roomScreen').classList.remove('hidden');
    document.getElementById('roomIdDisplay').textContent = myId;
    renderLobby();
  });

  myPeer.on('connection', conn => {
    conn.on('open', () => {
      guestConns[conn.peer] = conn;
    });
    conn.on('data', msg => handleHostMsg(conn.peer, msg));
    conn.on('close', () => {
      delete guestConns[conn.peer];
      players = players.filter(p=>p.id!==conn.peer);
      broadcast({type:'lobby', players});
      renderLobby();
    });
  });

  myPeer.on('error', e => setStatus('lobbyStatus', 'エラー: '+e.type));
});

document.getElementById('joinBtn').addEventListener('click', () => {
  const roomId = document.getElementById('roomIdInput').value.trim();
  if (!roomId) { setStatus('lobbyStatus','Room IDを入力してください'); return; }
  myName = document.getElementById('playerName').value.trim() || 'Player2';
  setStatus('lobbyStatus','接続中...');

  myPeer = new Peer(undefined, {config: {iceServers: [{urls:'stun:stun.l.google.com:19302'}]}});

  myPeer.on('open', id => {
    myId = id;
    isHost = false;
    hostConn = myPeer.connect(roomId, {reliable: true});
    hostConn.on('open', () => {
      hostConn.send({type:'join', name: myName});
      document.getElementById('lobby').classList.add('hidden');
      document.getElementById('roomScreen').classList.remove('hidden');
      document.getElementById('roomIdDisplay').textContent = roomId;
      document.getElementById('roomIdDisplay').style.fontSize = '0.8rem';
    });
    hostConn.on('data', msg => handleGuestMsg(msg));
    hostConn.on('close', () => setStatus('roomStatus','ホストとの接続が切れました'));
    hostConn.on('error', e => setStatus('lobbyStatus','接続エラー: '+e));
  });
  myPeer.on('error', e => setStatus('lobbyStatus','エラー: '+e.type));
});

document.getElementById('roomIdDisplay').addEventListener('click', function() {
  navigator.clipboard?.writeText(this.textContent).then(()=>{
    const orig = this.textContent;
    this.textContent = 'コピーしました!';
    setTimeout(()=>{ this.textContent = orig; }, 1200);
  });
});

document.getElementById('startBtn').addEventListener('click', () => {
  if (!isHost || players.length < 2) return;
  state = newState(players);
  broadcast({type:'gameState', state: buildStateView(players[0].id)});
  // show game for host
  renderGame(buildStateView(myId));
  startHand();
});

// Action buttons
document.getElementById('btnFold').addEventListener('click', () =>
  sendToHost({type:'action', action:'fold'}));
document.getElementById('btnCall').addEventListener('click', () =>
  sendToHost({type:'action', action:'call'}));
document.getElementById('btnCheck').addEventListener('click', () =>
  sendToHost({type:'action', action:'check'}));
document.getElementById('btnRaise').addEventListener('click', () => {
  const amt = parseInt(document.getElementById('raiseAmount').value,10);
  sendToHost({type:'action', action:'raise', amount: amt});
});

document.getElementById('nextHandBtn').addEventListener('click', () => {
  if (!isHost) return;
  document.getElementById('resultOverlay').classList.add('hidden');
  // remove busted players from active list
  state.players = state.players.filter(p=>p.chips>0);
  if (state.players.length < 2) { endGame(); return; }
  startHand();
});
