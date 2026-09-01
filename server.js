import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import QRCode from 'qrcode';
import { WebSocketServer } from 'ws';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 3000;
const PUBLIC_DIR = path.join(__dirname, 'public');

// How long a disconnected phone keeps its slot (and its blob, on the host) before
// it's given up for good. A sleeping/backgrounded phone can rejoin within this.
const GRACE_MS = 60000;

// Distinct per-player colors. The server hands one out on join so the desktop
// circle and the phone's own screen agree on which color a player is.
const PALETTE = [
  '#4f9dff', '#3ddc84', '#ff6b6b', '#ffd166',
  '#c77dff', '#ff8fab', '#2ec4b6', '#f79d65',
];

// ---------------------------------------------------------------------------
// In-memory room map. No persistence — a room lives only as long as its host.
// rooms: Map<code, { host, slots: Map<id, slot>, nextId, colorIndex }>
//   slot: { id, token, name, color, ws|null, dcTimer|null }
// A slot outlives its socket: when a phone drops we keep the slot (so the host
// keeps the blob) until it rejoins with its token or the grace timer expires.
// ---------------------------------------------------------------------------
const rooms = new Map();

// 4-char codes, uppercase, ambiguous glyphs (O/0/I/1) removed for QR-less typing.
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
function genCode() {
  let code;
  do {
    code = Array.from({ length: 4 }, () =>
      CODE_ALPHABET[Math.floor(Math.random() * CODE_ALPHABET.length)]
    ).join('');
  } while (rooms.has(code));
  return code;
}

function send(ws, obj) {
  if (ws && ws.readyState === ws.OPEN) ws.send(JSON.stringify(obj));
}
function broadcast(room, obj) {
  for (const s of room.slots.values()) send(s.ws, obj);
}

// ---------------------------------------------------------------------------
// Static file / route serving
// ---------------------------------------------------------------------------
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.webp': 'image/webp',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.ogg': 'audio/ogg',
};

async function serveFile(res, filename) {
  try {
    const full = path.join(PUBLIC_DIR, filename);
    // Guard against path traversal for anything derived from the request URL.
    if (full !== PUBLIC_DIR && !full.startsWith(PUBLIC_DIR + path.sep)) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('Not found');
      return;
    }
    const body = await readFile(full);
    res.writeHead(200, { 'Content-Type': MIME[path.extname(full)] || 'application/octet-stream' });
    res.end(body);
  } catch {
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('Not found');
  }
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  if (url.pathname === '/' || url.pathname === '/index.html') {
    await serveFile(res, 'host.html');
  } else if (url.pathname === '/controller') {
    await serveFile(res, 'controller.html');
  } else if (url.pathname.startsWith('/images/') || url.pathname.startsWith('/sound/')) {
    await serveFile(res, decodeURIComponent(url.pathname).replace(/^\/+/, ''));
  } else if (url.pathname === '/health') {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('ok');
  } else {
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('Not found');
  }
});

// ---------------------------------------------------------------------------
// WebSocket relay
// ---------------------------------------------------------------------------
const wss = new WebSocketServer({ server });

wss.on('connection', (ws, req) => {
  ws.role = null;
  ws.roomCode = null;
  ws.slotId = null;
  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });
  // Preserve the host used by the desktop so the QR points at the same origin.
  ws.hostHeader = req.headers.host;
  ws.forwardedProto = req.headers['x-forwarded-proto'];

  ws.on('message', async (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return; // ignore malformed frames
    }

    switch (msg.type) {
      case 'create-room': {
        const code = genCode();
        rooms.set(code, { host: ws, slots: new Map(), nextId: 1, colorIndex: 0 });
        ws.role = 'host';
        ws.roomCode = code;
        const scheme = typeof ws.forwardedProto === 'string'
          ? ws.forwardedProto.split(',')[0].trim()
          : 'http';
        const url = `${scheme}://${ws.hostHeader}/controller?room=${code}`;
        let qr = null;
        try {
          qr = await QRCode.toDataURL(url, { margin: 1, width: 320 });
        } catch (err) {
          console.error('QR generation failed:', err);
        }
        send(ws, { type: 'room-created', code, url, qr });
        break;
      }

      case 'join': {
        const code = (msg.code || '').toUpperCase();
        const room = rooms.get(code);
        if (!room || !room.host) {
          send(ws, { type: 'error', message: `Room "${code}" not found. Is the desktop page still open?` });
          return;
        }
        const id = room.nextId++;
        const color = PALETTE[room.colorIndex++ % PALETTE.length];
        const name = `Player ${id}`;
        const token = randomUUID();
        room.slots.set(id, { id, token, name, color, ws, dcTimer: null });
        ws.role = 'controller';
        ws.roomCode = code;
        ws.slotId = id;
        send(ws, { type: 'joined', code, id, color, name, token });
        send(room.host, { type: 'controller-joined', id, color, name });
        break;
      }

      case 'rejoin': {
        // A returning phone reconnects into its existing slot (same blob/growth).
        const code = (msg.code || '').toUpperCase();
        const room = rooms.get(code);
        if (!room || !room.host) { send(ws, { type: 'rejoin-failed' }); return; }
        let slot = null;
        for (const s of room.slots.values()) if (s.token === msg.token) { slot = s; break; }
        if (!slot) { send(ws, { type: 'rejoin-failed' }); return; }
        if (slot.dcTimer) { clearTimeout(slot.dcTimer); slot.dcTimer = null; }
        slot.ws = ws;
        ws.role = 'controller';
        ws.roomCode = code;
        ws.slotId = slot.id;
        send(ws, { type: 'joined', code, id: slot.id, color: slot.color, name: slot.name, token: slot.token });
        send(room.host, { type: 'controller-rejoined', id: slot.id });
        break;
      }

      case 'tilt': {
        if (ws.role !== 'controller' || !ws.roomCode) return;
        const room = rooms.get(ws.roomCode);
        if (room) send(room.host, { type: 'tilt', id: ws.slotId, tx: msg.tx, ty: msg.ty });
        break;
      }

      case 'buzz': {
        // Host detected a collision → buzz the involved controllers.
        if (ws.role !== 'host' || !ws.roomCode) return;
        const room = rooms.get(ws.roomCode);
        if (!room) return;
        for (const id of Array.isArray(msg.ids) ? msg.ids : []) {
          send(room.slots.get(id)?.ws, { type: 'buzz', confetti: msg.confetti, rainbow: msg.rainbow });
        }
        break;
      }

      // ---- Controller-initiated identity / lifecycle ----------------------
      case 'set-color': {
        if (ws.role !== 'controller' || !ws.roomCode) return;
        const room = rooms.get(ws.roomCode);
        const slot = room && room.slots.get(ws.slotId);
        if (!slot) return;
        slot.color = String(msg.color || slot.color);
        send(room.host, { type: 'player-color', id: slot.id, color: slot.color });
        break;
      }

      case 'set-name': {
        if (ws.role !== 'controller' || !ws.roomCode) return;
        const room = rooms.get(ws.roomCode);
        const slot = room && room.slots.get(ws.slotId);
        if (!slot) return;
        let n = String(msg.name || '').replace(/\s+/g, ' ').trim().slice(0, 16);
        if (!n) n = `Player ${slot.id}`;
        slot.name = n;
        send(room.host, { type: 'player-name', id: slot.id, name: n });
        break;
      }

      case 'play-again': {
        if (ws.role !== 'controller' || !ws.roomCode) return;
        const room = rooms.get(ws.roomCode);
        if (room) send(room.host, { type: 'play-again' });
        break;
      }

      // ---- Host-initiated broadcasts to controllers -----------------------
      case 'game-over': {
        if (ws.role !== 'host' || !ws.roomCode) return;
        const room = rooms.get(ws.roomCode);
        if (!room) return;
        const winner = room.slots.get(msg.winnerId);
        broadcast(room, {
          type: 'game-over',
          winnerId: msg.winnerId,
          winnerName: winner ? winner.name : 'A player',
          winnerColor: winner ? winner.color : '#ffffff',
        });
        break;
      }

      case 'game-reset': {
        if (ws.role !== 'host' || !ws.roomCode) return;
        const room = rooms.get(ws.roomCode);
        if (!room) return;
        broadcast(room, { type: 'game-reset' });
        break;
      }

      case 'progress': {
        if (ws.role !== 'host' || !ws.roomCode) return;
        const room = rooms.get(ws.roomCode);
        if (!room) return;
        send(room.slots.get(msg.id)?.ws, { type: 'progress', value: msg.value });
        break;
      }

      // ---- Power-ups ------------------------------------------------------
      case 'inventory': {   // host → one phone: that player's stored power-ups
        if (ws.role !== 'host' || !ws.roomCode) return;
        const room = rooms.get(ws.roomCode);
        if (room) send(room.slots.get(msg.id)?.ws, { type: 'inventory', items: msg.items });
        break;
      }
      case 'spin': {        // host → winner's phone: run the slot machine
        if (ws.role !== 'host' || !ws.roomCode) return;
        const room = rooms.get(ws.roomCode);
        if (room) send(room.slots.get(msg.id)?.ws, { type: 'spin', award: msg.award, reel: msg.reel });
        break;
      }
      case 'use-powerup': { // phone → host: activate a stored power-up
        if (ws.role !== 'controller' || !ws.roomCode) return;
        const room = rooms.get(ws.roomCode);
        if (room) send(room.host, { type: 'use-powerup', id: ws.slotId, powerup: msg.powerup });
        break;
      }
    }
  });

  ws.on('close', () => {
    const room = ws.roomCode && rooms.get(ws.roomCode);
    if (!room) return;
    if (ws.role === 'host') {
      // Host gone → tear the room down entirely, tell every controller.
      for (const s of room.slots.values()) { if (s.dcTimer) clearTimeout(s.dcTimer); send(s.ws, { type: 'peer-left' }); }
      rooms.delete(ws.roomCode);
    } else if (ws.role === 'controller') {
      const slot = room.slots.get(ws.slotId);
      if (!slot || slot.ws !== ws) return; // already superseded by a rejoin
      slot.ws = null;
      send(room.host, { type: 'controller-disconnected', id: slot.id });
      slot.dcTimer = setTimeout(() => {
        // Still gone after the grace window → give the slot up for good.
        if (room.slots.get(slot.id) === slot && slot.ws === null) {
          room.slots.delete(slot.id);
          send(room.host, { type: 'controller-left', id: slot.id });
        }
      }, GRACE_MS);
    }
  });
});

// Heartbeat: detect half-open sockets (asleep phones) so a drop is noticed
// promptly and the grace timer starts even when 'close' is delayed.
const heartbeat = setInterval(() => {
  for (const ws of wss.clients) {
    if (ws.isAlive === false) { ws.terminate(); continue; }
    ws.isAlive = false;
    try { ws.ping(); } catch { /* ignore */ }
  }
}, 25000);
wss.on('close', () => clearInterval(heartbeat));

server.listen(PORT, () => {
  console.log(`Tilt controller server listening on http://localhost:${PORT}`);
  console.log(`Desktop:    http://localhost:${PORT}/`);
});
