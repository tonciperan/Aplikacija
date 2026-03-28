const http = require('http');
const WebSocket = require('ws');

const server = http.createServer();
const wss = new WebSocket.Server({ server });

const kvizovi = {};
const clients = new Map(); // FIX: Map umjesto {}, WS objekti ne mogu biti kljucevi u {}


// Normalizacija za tolerantnu usporedbu odgovora
function normalize(str) {
  return str.toLowerCase()
    .replace(/č|ć/g, 'c')
    .replace(/š/g, 's')
    .replace(/ž/g, 'z')
    .replace(/đ/g, 'd')
    .replace(/ije/g, 'je')  // rijeka -> rjeka (konzistentno)
    .replace(/\s+/g, ' ')
    .trim();
}

function checkOpenAnswer(userAnswerStr, openFields) {
  // userAnswerStr je JSON array stringova, openFields je array točnih odgovora
  let userAnswers;
  try { userAnswers = JSON.parse(userAnswerStr); } catch { return false; }
  if (!Array.isArray(userAnswers) || !Array.isArray(openFields)) return false;
  if (userAnswers.length !== openFields.length) return false;
  // Svaki odgovor mora odgovarati svom polju (tolerantno)
  return openFields.every((correct, i) => normalize(userAnswers[i] || '') === normalize(correct));
}

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

    else if (type === 'ADMIN_REJOIN') {
      const { pin } = payload;
      const kviz = kvizovi[pin];
      if (!kviz) { sendTo(ws, { type: 'ERROR', payload: 'Kviz više nije dostupan.' }); return; }
      clients.set(ws, { pin, role: 'admin' });

      if (kviz.status === 'lobby') {
        const playerList = Object.values(kviz.players).map(p => p.name);
        sendTo(ws, { type: 'ADMIN_CREATED', payload: { pin, title: kviz.title } });
        sendTo(ws, { type: 'LOBBY_UPDATE', payload: { players: playerList } });
      } else if (kviz.status === 'question') {
        const q = kviz.questions[kviz.currentQ];
        const qtype = q.type || 'mc';
        const opts = qtype === 'tf' ? ['Točno', 'Netočno']
          : qtype === 'mc' ? (q.options || [q.a, q.b, q.c, q.d].filter(Boolean))
          : [];
        const answerCount = Object.keys(kviz.answers[kviz.currentQ] || {}).length;
        sendTo(ws, { type: 'QUESTION', payload: {
          qIdx: kviz.currentQ, total: kviz.questions.length,
          text: q.text, qtype, openFields: q.openFields || [], options: opts,
          duration: q.duration || kviz.duration, startTime: kviz.questionStartTime
        }});
        sendTo(ws, { type: 'ANSWER_COUNT', payload: { count: answerCount } });
      } else if (kviz.status === 'results') {
        // Pošalji rezultate posljednjeg pitanja
        const qIdx = kviz.currentQ;
        const q = kviz.questions[qIdx];
        const qtype = q.type || 'mc';
        const isOpen = qtype === 'open';
        const opts = qtype === 'tf' ? ['Točno', 'Netočno']
          : qtype === 'mc' ? (q.options || [q.a, q.b, q.c, q.d].filter(Boolean)) : [];
        const letters = 'ABCDEFGH';
        const correctIdx = (q.correct || 'A').charCodeAt(0) - 65;
        const correctText = isOpen ? (q.openFields||[]).join(', ') : (opts[correctIdx] || q.correct || '');
        const counts = {};
        opts.forEach((_, i) => { counts[letters[i]] = 0; });
        Object.values(kviz.answers[qIdx] || {}).forEach(a => { if (counts[a.answer] !== undefined) counts[a.answer]++; });
        const isLast = qIdx >= kviz.questions.length - 1;
        sendTo(ws, { type: 'RESULTS', payload: { correct: q.correct, counts, options: opts, scoreboard: getScoreboard(kviz), isLast, qIdx, isOpen, correctText, openFields: q.openFields||[] } });
      } else if (kviz.status === 'final') {
        sendTo(ws, { type: 'FINAL', payload: { scoreboard: getScoreboard(kviz) } });
      }
    }

    else if (type === 'PLAYER_REJOIN') {
      const { pin, playerId } = payload;
      const kviz = kvizovi[pin];
      if (!kviz || !kviz.players[playerId]) {
        sendTo(ws, { type: 'ERROR', payload: 'Kviz više nije dostupan. Uđi ponovo.' });
        return;
      }
      clients.set(ws, { pin, role: 'player', playerId, name: kviz.players[playerId].name });

      if (kviz.status === 'lobby') {
        const playerList = Object.values(kviz.players).map(p => p.name);
        sendTo(ws, { type: 'JOINED', payload: { playerId, name: kviz.players[playerId].name, title: kviz.title, duration: kviz.duration, questionCount: kviz.questions.length } });
        sendTo(ws, { type: 'LOBBY_UPDATE', payload: { players: playerList } });
      } else if (kviz.status === 'question') {
        const q = kviz.questions[kviz.currentQ];
        const qtype = q.type || 'mc';
        const opts = qtype === 'tf' ? ['Točno', 'Netočno']
          : qtype === 'mc' ? (q.options || [q.a, q.b, q.c, q.d].filter(Boolean))
          : [];
        const alreadyAnswered = !!(kviz.answers[kviz.currentQ] && kviz.answers[kviz.currentQ][playerId]);
        sendTo(ws, { type: 'QUESTION', payload: {
          qIdx: kviz.currentQ, total: kviz.questions.length,
          text: q.text, qtype, openFields: q.openFields || [], options: opts,
          duration: q.duration || kviz.duration, startTime: kviz.questionStartTime,
          alreadyAnswered
        }});
      } else if (kviz.status === 'final') {
        sendTo(ws, { type: 'FINAL', payload: { scoreboard: getScoreboard(kviz) } });
      } else if (kviz.status === 'results' && kviz.lastResults) {
        const lr = kviz.lastResults;
        const res = lr.playerResults[playerId] || { answer: null, gained: 0, correct: lr.correct, isCorrect: false, score: kviz.players[playerId]?.score || 0 };
        sendTo(ws, { type: 'RESULTS', payload: { ...res, counts: lr.counts, options: lr.options, scoreboard: lr.scoreboard, isLast: lr.isLast, isOpen: lr.isOpen, correctText: lr.correctText, openFields: lr.openFields } });
      }
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
      const totalPlayers = Object.keys(kviz.players).length;
      const adminWs = getAdminWs(info.pin);
      if (adminWs) sendTo(adminWs, { type: 'ANSWER_COUNT', payload: { count: answerCount } });
      if (answerCount >= totalPlayers && totalPlayers > 0) {
        setTimeout(() => endQuestion(info.pin, adminWs), 1500);
      }
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
  const qtype = q.type || 'mc';
  const opts = qtype === 'tf' ? ['Točno', 'Netočno']
    : qtype === 'mc' ? (q.options || [q.a, q.b, q.c, q.d].filter(Boolean))
    : [];
  const payload = {
    qIdx: nextIdx,
    total: kviz.questions.length,
    text: q.text,
    qtype,
    openFields: q.openFields || [],
    options: opts,
    duration: q.duration || kviz.duration,
    startTime: kviz.questionStartTime
  };

  broadcast(pin, { type: 'QUESTION', payload }, adminWs);
  sendTo(adminWs, { type: 'QUESTION', payload });

  const qDuration = q.duration || kviz.duration;
  kviz.timerHandle = setTimeout(() => endQuestion(pin, adminWs), qDuration * 1000);
}

function endQuestion(pin, adminWs) {
  const kviz = kvizovi[pin];
  if (!kviz || kviz.status !== 'question') return;
  if (kviz.timerHandle) { clearTimeout(kviz.timerHandle); kviz.timerHandle = null; }

  kviz.status = 'results';
  const qIdx = kviz.currentQ;
  const q = kviz.questions[qIdx];
  const correct = q.correct;
  const dur = q.duration || kviz.duration;
  const startTime = kviz.questionStartTime;

  const playerResults = {};
  const answers = kviz.answers[qIdx] || {};

  const qtype = q.type || 'mc';
  const isOpen = qtype === 'open';
  const opts = qtype === 'tf' ? ['Točno', 'Netočno']
    : qtype === 'mc' ? (q.options || [q.a, q.b, q.c, q.d].filter(Boolean))
    : [];
  const letters = 'ABCDEFGH';
  const correctIdx = correct ? correct.charCodeAt(0) - 65 : 0;
  const correctText = isOpen ? (q.openFields||[]).join(', ') : (opts[correctIdx] || correct || '');

  Object.entries(kviz.players).forEach(([pid, player]) => {
    const ans = answers[pid];
    let gained = 0;
    let isCorrect = false;
    if (ans) {
      isCorrect = isOpen
        ? checkOpenAnswer(ans.answer, q.openFields || [])
        : ans.answer === correct;
      if (isCorrect) {
        const elapsed = Math.max(0, (ans.time - startTime) / 1000);
        gained = Math.round(1000 * Math.max(0.1, (dur - elapsed) / dur));
        player.score += gained;
      }
    }
    playerResults[pid] = { answer: ans ? ans.answer : null, gained, correct, isCorrect, score: player.score };
  });

  const counts = {};
  opts.forEach((_, i) => { counts[letters[i]] = 0; });
  Object.values(answers).forEach(a => { if (counts[a.answer] !== undefined) counts[a.answer]++; });

  const scoreboard = getScoreboard(kviz);
  const isLast = qIdx >= kviz.questions.length - 1;

  // Pohrani za rejoin
  kviz.lastResults = { correct, counts, options: opts, isLast, qIdx, isOpen, correctText, openFields: q.openFields||[], scoreboard, playerResults };

  wss.clients.forEach(c => {
    const cInfo = clients.get(c);
    if (!cInfo || cInfo.pin !== pin) return;
    if (cInfo.role === 'player') {
      const res = playerResults[cInfo.playerId] || { answer: null, gained: 0, correct, isCorrect: false, score: kviz.players[cInfo.playerId]?.score || 0 };
      sendTo(c, { type: 'RESULTS', payload: { ...res, counts, options: opts, scoreboard, isLast,
        isOpen, correctText, openFields: q.openFields||[] } });
    } else if (cInfo.role === 'admin') {
      sendTo(c, { type: 'RESULTS', payload: { correct, counts, options: opts, scoreboard, isLast, qIdx,
        isOpen, correctText, openFields: q.openFields||[] } });
    }
  });
}

function endKviz(pin, adminWs) {
  const kviz = kvizovi[pin];
  if (!kviz) return;
  kviz.status = 'final';
  const scoreboard = getScoreboard(kviz);
  broadcast(pin, { type: 'FINAL', payload: { scoreboard } }, adminWs);
  sendTo(adminWs, { type: 'FINAL', payload: { scoreboard } });
  setTimeout(() => delete kvizovi[pin], 3600000);
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`LiveKviz server radi na portu ${PORT}`));