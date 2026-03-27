const http = require('http');
const WebSocket = require('ws');

const server = http.createServer();
const wss = new WebSocket.Server({ server });

const kvizovi = {};
const clients = new Map(); // FIX: Map umjesto {}, WS objekti ne mogu biti kljucevi u {}

function broadcast(pin, msg, excludeWs = null) {
  wss.clients.forEach(ws => {
    const info = clients.get(ws);
    if (ws.readyState === WebSocket.OPEN && info && info.pin === pin && ws !== excludeWs) {
      ws.send(JSON.stringify(msg));
    }
  });
}

function sendTo(ws, msg) {
  if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
}

function getScoreboard(kviz) {
  return Object.values(kviz.players)
    .sort((a, b) => b.score - a.score)
    .map(p => ({ name: p.name, score: p.score }));
}

function getAdminWs(pin) {
  for (const [ws, info] of clients.entries()) {
    if (info.pin === pin && info.role === 'admin' && ws.readyState === WebSocket.OPEN) return ws;
  }
  return null;
}

wss.on('connection', (ws) => {
  clients.set(ws, {});

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }
    const { type, payload } = msg;
    const info = clients.get(ws);

    if (type === 'ADMIN_CREATE') {
      const { title, duration, questions } = payload;
      const pin = String(Math.floor(100000 + Math.random() * 900000));
      kvizovi[pin] = {
        title,
        duration: duration || 60,
        questions,
        status: 'lobby',
        currentQ: -1,
        players: {},
        answers: {},      // FIX: bio [], sad je {}
        questionStartTime: null,
        timerHandle: null
      };
      clients.set(ws, { pin, role: 'admin' });
      sendTo(ws, { type: 'ADMIN_CREATED', payload: { pin, title } });
    }

    else if (type === 'PLAYER_JOIN') {
      const { pin, name } = payload;
      const kviz = kvizovi[pin];
      if (!kviz) { sendTo(ws, { type: 'ERROR', payload: 'Kviz nije pronađen!' }); return; }
      if (kviz.status !== 'lobby') { sendTo(ws, { type: 'ERROR', payload: 'Kviz je već počeo ili je završio!' }); return; }

      const playerId = 'p_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6);
      kviz.players[playerId] = { name, score: 0, id: playerId };
      clients.set(ws, { pin, role: 'player', playerId, name });

      // FIX: šaljemo name natrag igracu
      sendTo(ws, { type: 'JOINED', payload: {
        playerId, name, title: kviz.title,
        duration: kviz.duration, questionCount: kviz.questions.length
      }});

      const playerList = Object.values(kviz.players).map(p => p.name);
      broadcast(pin, { type: 'LOBBY_UPDATE', payload: { players: playerList } });
      sendTo(ws, { type: 'LOBBY_UPDATE', payload: { players: playerList } });
    }

    else if (type === 'ADMIN_START' || type === 'ADMIN_NEXT') {
      const kviz = kvizovi[info.pin];
      if (!kviz || info.role !== 'admin') return;
      advanceQuestion(info.pin, ws);
    }

    else if (type === 'ADMIN_END_QUESTION') {
      const kviz = kvizovi[info.pin];
      if (!kviz || info.role !== 'admin') return;
      endQuestion(info.pin, ws);
    }

    else if (type === 'ADMIN_FORCE_END') {
      // FIX: posebna poruka za završetak kviza (bio bug - koristio ADMIN_NEXT)
      const kviz = kvizovi[info.pin];
      if (!kviz || info.role !== 'admin') return;
      if (kviz.timerHandle) { clearTimeout(kviz.timerHandle); kviz.timerHandle = null; }
      endKviz(info.pin, ws);
    }

    else if (type === 'PLAYER_ANSWER') {
      const kviz = kvizovi[info.pin];
      if (!kviz || kviz.status !== 'question') return;
      const qIdx = kviz.currentQ;
      if (!kviz.answers[qIdx]) kviz.answers[qIdx] = {};
      if (kviz.answers[qIdx][info.playerId]) return;

      kviz.answers[qIdx][info.playerId] = {
        answer: payload.answer,
        time: Date.now()
      };

      const answerCount = Object.keys(kviz.answers[qIdx]).length;
      const adminWs = getAdminWs(info.pin);
      if (adminWs) sendTo(adminWs, { type: 'ANSWER_COUNT', payload: { count: answerCount } });
    }
  });

  ws.on('close', () => {
    const info = clients.get(ws);
    if (info && info.pin && info.role === 'player') {
      const kviz = kvizovi[info.pin];
      if (kviz && kviz.status === 'lobby') {
        delete kviz.players[info.playerId];
        const playerList = Object.values(kviz.players).map(p => p.name);
        broadcast(info.pin, { type: 'LOBBY_UPDATE', payload: { players: playerList } });
      }
    }
    clients.delete(ws); // FIX: Map.delete
  });
});

function advanceQuestion(pin, adminWs) {
  const kviz = kvizovi[pin];
  if (!kviz) return;
  if (kviz.timerHandle) { clearTimeout(kviz.timerHandle); kviz.timerHandle = null; }

  const nextIdx = kviz.currentQ + 1;
  if (nextIdx >= kviz.questions.length) { endKviz(pin, adminWs); return; }

  kviz.currentQ = nextIdx;
  kviz.status = 'question';
  kviz.questionStartTime = Date.now();
  if (!kviz.answers[nextIdx]) kviz.answers[nextIdx] = {};

  const q = kviz.questions[nextIdx];
  const payload = {
    qIdx: nextIdx,
    total: kviz.questions.length,
    text: q.text,
    answers: { a: q.a, b: q.b, c: q.c || '', d: q.d || '' },
    duration: kviz.duration,
    startTime: kviz.questionStartTime
  };

  broadcast(pin, { type: 'QUESTION', payload });
  sendTo(adminWs, { type: 'QUESTION', payload });

  kviz.timerHandle = setTimeout(() => endQuestion(pin, adminWs), kviz.duration * 1000);
}

function endQuestion(pin, adminWs) {
  const kviz = kvizovi[pin];
  if (!kviz || kviz.status !== 'question') return;
  if (kviz.timerHandle) { clearTimeout(kviz.timerHandle); kviz.timerHandle = null; }

  kviz.status = 'results';
  const qIdx = kviz.currentQ;
  const q = kviz.questions[qIdx];
  const correct = q.correct;
  const dur = kviz.duration;
  const startTime = kviz.questionStartTime;

  const playerResults = {};
  const answers = kviz.answers[qIdx] || {};

  Object.entries(kviz.players).forEach(([pid, player]) => {
    const ans = answers[pid];
    let gained = 0;
    if (ans && ans.answer === correct) {
      const elapsed = Math.max(0, (ans.time - startTime) / 1000);
      gained = Math.round(1000 * Math.max(0.1, (dur - elapsed) / dur));
      player.score += gained;
    }
    playerResults[pid] = { answer: ans ? ans.answer : null, gained, correct, score: player.score };
  });

  const counts = { A: 0, B: 0, C: 0, D: 0 };
  Object.values(answers).forEach(a => { if (counts[a.answer] !== undefined) counts[a.answer]++; });

  const scoreboard = getScoreboard(kviz);
  const isLast = qIdx >= kviz.questions.length - 1;

  wss.clients.forEach(c => {
    const cInfo = clients.get(c);
    if (!cInfo || cInfo.pin !== pin) return;
    if (cInfo.role === 'player') {
      const res = playerResults[cInfo.playerId] || { answer: null, gained: 0, correct, score: kviz.players[cInfo.playerId]?.score || 0 };
      sendTo(c, { type: 'RESULTS', payload: { ...res, counts, scoreboard, isLast, correctText: q[correct.toLowerCase()] } });
    } else if (cInfo.role === 'admin') {
      sendTo(c, { type: 'RESULTS', payload: { correct, correctText: q[correct.toLowerCase()], counts, scoreboard, isLast, qIdx } });
    }
  });
}

function endKviz(pin, adminWs) {
  const kviz = kvizovi[pin];
  if (!kviz) return;
  kviz.status = 'final';
  const scoreboard = getScoreboard(kviz);
  broadcast(pin, { type: 'FINAL', payload: { scoreboard } });
  sendTo(adminWs, { type: 'FINAL', payload: { scoreboard } });
  setTimeout(() => delete kvizovi[pin], 3600000);
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`LiveKviz server radi na portu ${PORT}`));
