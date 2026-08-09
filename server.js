// Zero-dependency static file server + online multiplayer API for Tic Tac Toe.
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PORT = process.env.PORT || 3000;
const ROOT = path.join(__dirname, 'www');
const ROOM_TTL_MS = 2 * 60 * 60 * 1000; // 2 hours of inactivity

const WIN_LINES = [[0,1,2],[3,4,5],[6,7,8],[0,3,6],[1,4,7],[2,5,8],[0,4,8],[2,4,6]];
function checkWinner(board) {
  for (const line of WIN_LINES) {
    const [a, b, c] = line;
    if (board[a] && board[a] === board[b] && board[a] === board[c]) return { winner: board[a], line };
  }
  return null;
}

/** @type {Map<string, Room>} */
const rooms = new Map();

function makeCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ0123456789';
  let code;
  do {
    code = Array.from({ length: 4 }, () => chars[Math.floor(Math.random() * chars.length)]).join('');
  } while (rooms.has(code));
  return code;
}

function newRoom(xName) {
  const code = makeCode();
  const room = {
    code,
    board: Array(9).fill(''),
    turn: 'X',
    winner: null,
    winLine: null,
    names: { X: xName || 'Player 1', O: 'Player 2' },
    scores: { X: 0, O: 0, draws: 0 },
    tokens: { X: crypto.randomUUID(), O: null },
    joined: { X: true, O: false },
    updatedAt: Date.now()
  };
  rooms.set(code, room);
  return room;
}

function status(room) {
  if (room.winner) return 'won';
  if (room.board.every(Boolean)) return 'draw';
  if (!(room.joined.X && room.joined.O)) return 'waiting';
  return 'playing';
}

function publicState(room, yourSymbol) {
  return {
    code: room.code,
    board: room.board,
    turn: room.turn,
    status: status(room),
    winner: room.winner,
    winLine: room.winLine,
    names: room.names,
    scores: room.scores,
    playersJoined: { X: room.joined.X, O: room.joined.O },
    yourSymbol: yourSymbol || null
  };
}

function symbolForToken(room, token) {
  if (room.tokens.X === token) return 'X';
  if (room.tokens.O === token) return 'O';
  return null;
}

function cleanupRooms() {
  const now = Date.now();
  for (const [code, room] of rooms) {
    if (now - room.updatedAt > ROOM_TTL_MS) rooms.delete(code);
  }
}
setInterval(cleanupRooms, 10 * 60 * 1000);

function sendJson(res, statusCode, data) {
  const body = JSON.stringify(data);
  res.writeHead(statusCode, {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(body),
    'Access-Control-Allow-Origin': '*'
  });
  res.end(body);
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    let size = 0;
    req.on('data', chunk => {
      size += chunk.length;
      if (size > 1e6) { reject(new Error('Payload too large')); req.destroy(); return; }
      data += chunk;
    });
    req.on('end', () => {
      if (!data) return resolve({});
      try { resolve(JSON.parse(data)); } catch (e) { reject(e); }
    });
    req.on('error', reject);
  });
}

/* ============================== API HANDLERS ============================== */
async function handleCreate(req, res) {
  let body;
  try { body = await readJsonBody(req); } catch (e) { return sendJson(res, 400, { error: 'Invalid body' }); }
  const name = (body.name || '').toString().trim().slice(0, 16) || 'Player 1';
  const room = newRoom(name);
  sendJson(res, 200, { token: room.tokens.X, symbol: 'X', state: publicState(room, 'X') });
}

async function handleJoin(req, res) {
  let body;
  try { body = await readJsonBody(req); } catch (e) { return sendJson(res, 400, { error: 'Invalid body' }); }
  const code = (body.code || '').toString().trim().toUpperCase();
  const name = (body.name || '').toString().trim().slice(0, 16) || 'Player 2';
  const room = rooms.get(code);
  if (!room) return sendJson(res, 404, { error: 'Room not found' });
  if (room.joined.O) return sendJson(res, 409, { error: 'Room is already full' });
  room.joined.O = true;
  room.names.O = name;
  room.tokens.O = crypto.randomUUID();
  room.updatedAt = Date.now();
  sendJson(res, 200, { token: room.tokens.O, symbol: 'O', state: publicState(room, 'O') });
}

function handleState(req, res, query) {
  const code = (query.get('code') || '').toUpperCase();
  const token = query.get('token') || '';
  const room = rooms.get(code);
  if (!room) return sendJson(res, 404, { error: 'Room not found' });
  const symbol = symbolForToken(room, token);
  if (!symbol) return sendJson(res, 401, { error: 'Invalid token' });
  sendJson(res, 200, publicState(room, symbol));
}

async function handleMove(req, res) {
  let body;
  try { body = await readJsonBody(req); } catch (e) { return sendJson(res, 400, { error: 'Invalid body' }); }
  const code = (body.code || '').toString().trim().toUpperCase();
  const token = body.token || '';
  const index = Number(body.index);
  const room = rooms.get(code);
  if (!room) return sendJson(res, 404, { error: 'Room not found' });
  const symbol = symbolForToken(room, token);
  if (!symbol) return sendJson(res, 401, { error: 'Invalid token' });

  if (!room.joined.X || !room.joined.O) return sendJson(res, 200, publicState(room, symbol));
  if (room.winner || room.board.every(Boolean)) return sendJson(res, 200, publicState(room, symbol));
  if (room.turn !== symbol) return sendJson(res, 200, publicState(room, symbol));
  if (!Number.isInteger(index) || index < 0 || index > 8 || room.board[index]) return sendJson(res, 200, publicState(room, symbol));

  room.board[index] = symbol;
  const result = checkWinner(room.board);
  if (result) {
    room.winner = result.winner;
    room.winLine = result.line;
    room.scores[result.winner]++;
  } else if (room.board.every(Boolean)) {
    room.scores.draws++;
  } else {
    room.turn = symbol === 'X' ? 'O' : 'X';
  }
  room.updatedAt = Date.now();
  sendJson(res, 200, publicState(room, symbol));
}

async function handleRematch(req, res) {
  let body;
  try { body = await readJsonBody(req); } catch (e) { return sendJson(res, 400, { error: 'Invalid body' }); }
  const code = (body.code || '').toString().trim().toUpperCase();
  const token = body.token || '';
  const room = rooms.get(code);
  if (!room) return sendJson(res, 404, { error: 'Room not found' });
  const symbol = symbolForToken(room, token);
  if (!symbol) return sendJson(res, 401, { error: 'Invalid token' });

  room.board = Array(9).fill('');
  room.winner = null;
  room.winLine = null;
  room.turn = room.turn === 'X' ? 'O' : 'X';
  room.updatedAt = Date.now();
  sendJson(res, 200, publicState(room, symbol));
}

/* ============================== STATIC FILE SERVING ============================== */
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.webmanifest': 'application/manifest+json'
};

function serveStatic(req, res, pathname) {
  let filePath = path.join(ROOT, decodeURIComponent(pathname));
  if (!filePath.startsWith(ROOT)) { res.writeHead(403); return res.end('Forbidden'); }
  if (pathname === '/' || pathname === '') filePath = path.join(ROOT, 'index.html');

  fs.stat(filePath, (err, stat) => {
    if (err || !stat.isFile()) {
      fs.readFile(path.join(ROOT, 'index.html'), (e2, data) => {
        if (e2) { res.writeHead(404); return res.end('Not found'); }
        res.writeHead(200, { 'Content-Type': MIME['.html'] });
        res.end(data);
      });
      return;
    }
    const ext = path.extname(filePath).toLowerCase();
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
    fs.createReadStream(filePath).pipe(res);
  });
}

/* ============================== SERVER ============================== */
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const pathname = url.pathname;

  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type'
    });
    return res.end();
  }

  if (pathname.startsWith('/api/online/')) {
    try {
      if (pathname === '/api/online/create' && req.method === 'POST') return await handleCreate(req, res);
      if (pathname === '/api/online/join' && req.method === 'POST') return await handleJoin(req, res);
      if (pathname === '/api/online/state' && req.method === 'GET') return handleState(req, res, url.searchParams);
      if (pathname === '/api/online/move' && req.method === 'POST') return await handleMove(req, res);
      if (pathname === '/api/online/rematch' && req.method === 'POST') return await handleRematch(req, res);
      return sendJson(res, 404, { error: 'Not found' });
    } catch (e) {
      return sendJson(res, 500, { error: 'Server error' });
    }
  }

  serveStatic(req, res, pathname);
});

server.listen(PORT, () => {
  console.log(`Tic Tac Toe server running at http://localhost:${PORT}`);
});
