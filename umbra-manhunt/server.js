'use strict';

/*
 * Umbra — GPS manhunt game server.
 *
 * Serves the static client from ./public and runs the authoritative game
 * over a WebSocket. The server owns all game state so no player can cheat
 * by reading the socket: each client is only told what its role is allowed
 * to see (hunters are always visible; shadows are revealed to hunters only
 * during a "ping", and are always visible to themselves).
 *
 * No database, no accounts, no API keys. Rooms live in memory and disappear
 * when empty.
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { WebSocketServer } = require('ws');

const PORT = process.env.PORT || 3000;
const PUBLIC_DIR = path.join(__dirname, 'public');

// ----------------------------------------------------------------------------
// Static file server
// ----------------------------------------------------------------------------

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

const server = http.createServer((req, res) => {
  let urlPath = decodeURIComponent((req.url || '/').split('?')[0]);
  if (urlPath === '/') urlPath = '/index.html';

  // Resolve inside PUBLIC_DIR only (block path traversal).
  const filePath = path.join(PUBLIC_DIR, path.normalize(urlPath));
  if (!filePath.startsWith(PUBLIC_DIR)) {
    res.writeHead(403).end('Forbidden');
    return;
  }

  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain' }).end('Not found');
      return;
    }
    const ext = path.extname(filePath).toLowerCase();
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
    res.end(data);
  });
});

// ----------------------------------------------------------------------------
// Game model
// ----------------------------------------------------------------------------

/** Default, host-tunable game settings. */
function defaultConfig() {
  return {
    hunterRatio: 0.34,     // fraction of players that start as Hunters
    durationSec: 20 * 60,  // round length
    pingIntervalSec: 180,  // time between pings
    pingDurationSec: 10,   // how long a ping stays revealed
    catchRadiusM: 15,      // how close a Hunter must be to tag a Shadow
    zoneRadiusM: 600,      // play-zone radius around the starting centroid
    convertOnCatch: true,  // caught Shadows become Hunters (vs. simply out)
  };
}

const rooms = new Map(); // code -> Room

class Room {
  constructor(code) {
    this.code = code;
    this.players = new Map(); // id -> player
    this.phase = 'lobby';     // 'lobby' | 'running' | 'over'
    this.config = defaultConfig();
    this.zone = null;         // { lat, lng, radius }
    this.startedAt = 0;
    this.endsAt = 0;
    this.nextPingAt = 0;
    this.pingUntil = 0;
    this.pingSnapshot = [];   // [{ id, lat, lng }] shadows revealed this ping
    this.winner = null;       // 'hunters' | 'shadows'
    this.tick = null;         // interval handle while running
  }

  hostId() {
    // First still-connected player is the host.
    for (const p of this.players.values()) if (p.connected) return p.id;
    return null;
  }

  alivePlayers() {
    return [...this.players.values()].filter((p) => p.connected);
  }
}

function makePlayer(id, name) {
  return {
    id,
    name: name.slice(0, 24) || 'Player',
    role: null,      // 'hunter' | 'shadow'
    caught: false,   // a shadow who has been tagged
    lat: null,
    lng: null,
    acc: null,
    hasFix: false,
    connected: true,
    ws: null,
  };
}

// ----------------------------------------------------------------------------
// Geometry
// ----------------------------------------------------------------------------

const R_EARTH = 6371000; // metres

function distanceM(a, b) {
  if (a.lat == null || b.lat == null) return Infinity;
  const dLat = ((b.lat - a.lat) * Math.PI) / 180;
  const dLng = ((b.lng - a.lng) * Math.PI) / 180;
  const la1 = (a.lat * Math.PI) / 180;
  const la2 = (b.lat * Math.PI) / 180;
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(la1) * Math.cos(la2) * Math.sin(dLng / 2) ** 2;
  return 2 * R_EARTH * Math.asin(Math.min(1, Math.sqrt(h)));
}

function centroid(points) {
  const fixed = points.filter((p) => p.lat != null);
  if (!fixed.length) return null;
  const lat = fixed.reduce((s, p) => s + p.lat, 0) / fixed.length;
  const lng = fixed.reduce((s, p) => s + p.lng, 0) / fixed.length;
  return { lat, lng };
}

// ----------------------------------------------------------------------------
// WebSocket wiring
// ----------------------------------------------------------------------------

const wss = new WebSocketServer({ server });

wss.on('connection', (ws) => {
  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });

  ws.room = null;
  ws.playerId = null;

  ws.on('message', (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return;
    }
    handleMessage(ws, msg);
  });

  ws.on('close', () => {
    const room = rooms.get(ws.room);
    if (!room) return;
    const p = room.players.get(ws.playerId);
    if (p) {
      p.connected = false;
      p.ws = null;
    }
    // Drop empty rooms.
    if (room.alivePlayers().length === 0) {
      if (room.tick) clearInterval(room.tick);
      rooms.delete(room.code);
    } else {
      broadcastState(room);
    }
  });
});

// Keep-alive ping so dead sockets are reaped.
setInterval(() => {
  for (const ws of wss.clients) {
    if (ws.isAlive === false) { ws.terminate(); continue; }
    ws.isAlive = false;
    try { ws.ping(); } catch { /* ignore */ }
  }
}, 30000);

function send(ws, obj) {
  if (ws && ws.readyState === ws.OPEN) ws.send(JSON.stringify(obj));
}

function handleMessage(ws, msg) {
  switch (msg.type) {
    case 'join': return onJoin(ws, msg);
    case 'pos': return onPos(ws, msg);
    case 'config': return onConfig(ws, msg);
    case 'start': return onStart(ws, msg);
    case 'reset': return onReset(ws, msg);
    default: return;
  }
}

function onJoin(ws, msg) {
  let code = String(msg.room || '').trim().toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 6);
  if (!code) code = randomCode();

  let room = rooms.get(code);
  if (!room) {
    room = new Room(code);
    rooms.set(code, room);
  }
  if (room.phase !== 'lobby') {
    // Allow rejoining a game in progress only if the name already exists? Keep simple: block new joins mid-game.
    send(ws, { type: 'error', message: 'That game has already started.' });
    return;
  }

  const id = crypto.randomUUID();
  const player = makePlayer(id, String(msg.name || ''));
  player.ws = ws;
  room.players.set(id, player);

  ws.room = code;
  ws.playerId = id;

  send(ws, { type: 'joined', id, room: code });
  broadcastState(room);
}

function onPos(ws, msg) {
  const room = rooms.get(ws.room);
  if (!room) return;
  const p = room.players.get(ws.playerId);
  if (!p) return;
  if (typeof msg.lat !== 'number' || typeof msg.lng !== 'number') return;
  p.lat = msg.lat;
  p.lng = msg.lng;
  p.acc = typeof msg.acc === 'number' ? msg.acc : null;
  p.hasFix = true;
  // State is broadcast on the running tick; in the lobby, nudge an update so
  // the host sees who has a GPS fix.
  if (room.phase === 'lobby') broadcastState(room);
}

function onConfig(ws, msg) {
  const room = rooms.get(ws.room);
  if (!room || room.phase !== 'lobby') return;
  if (ws.playerId !== room.hostId()) return;
  const c = room.config;
  const cfg = msg.config || {};
  if (Number.isFinite(cfg.durationSec)) c.durationSec = clamp(cfg.durationSec, 60, 3 * 3600);
  if (Number.isFinite(cfg.pingIntervalSec)) c.pingIntervalSec = clamp(cfg.pingIntervalSec, 15, 1800);
  if (Number.isFinite(cfg.pingDurationSec)) c.pingDurationSec = clamp(cfg.pingDurationSec, 3, 60);
  if (Number.isFinite(cfg.catchRadiusM)) c.catchRadiusM = clamp(cfg.catchRadiusM, 5, 100);
  if (Number.isFinite(cfg.zoneRadiusM)) c.zoneRadiusM = clamp(cfg.zoneRadiusM, 100, 5000);
  if (Number.isFinite(cfg.hunterRatio)) c.hunterRatio = clamp(cfg.hunterRatio, 0.1, 0.9);
  if (typeof cfg.convertOnCatch === 'boolean') c.convertOnCatch = cfg.convertOnCatch;
  broadcastState(room);
}

function onStart(ws, msg) {
  const room = rooms.get(ws.room);
  if (!room || room.phase !== 'lobby') return;
  if (ws.playerId !== room.hostId()) return;

  const players = [...room.players.values()].filter((p) => p.connected);
  if (players.length < 2) {
    send(ws, { type: 'error', message: 'Need at least 2 players to start.' });
    return;
  }

  // Assign roles.
  const shuffled = players.slice().sort(() => Math.random() - 0.5);
  const hunterCount = Math.max(1, Math.round(players.length * room.config.hunterRatio));
  shuffled.forEach((p, i) => {
    p.role = i < hunterCount ? 'hunter' : 'shadow';
    p.caught = false;
  });

  // Play zone centred on everyone's current position (fall back to first fix).
  const center = centroid(players) || { lat: 0, lng: 0 };
  room.zone = { lat: center.lat, lng: center.lng, radius: room.config.zoneRadiusM };

  const now = Date.now();
  room.phase = 'running';
  room.startedAt = now;
  room.endsAt = now + room.config.durationSec * 1000;
  room.nextPingAt = now + room.config.pingIntervalSec * 1000; // grace before first ping
  room.pingUntil = 0;
  room.pingSnapshot = [];
  room.winner = null;

  if (room.tick) clearInterval(room.tick);
  room.tick = setInterval(() => gameTick(room), 1000);

  broadcastState(room);
}

function onReset(ws, msg) {
  const room = rooms.get(ws.room);
  if (!room) return;
  if (ws.playerId !== room.hostId()) return;
  if (room.tick) clearInterval(room.tick);
  room.tick = null;
  room.phase = 'lobby';
  room.zone = null;
  room.winner = null;
  room.pingUntil = 0;
  room.pingSnapshot = [];
  for (const p of room.players.values()) {
    p.role = null;
    p.caught = false;
  }
  broadcastState(room);
}

// ----------------------------------------------------------------------------
// Core loop (runs once per second while a room is 'running')
// ----------------------------------------------------------------------------

function gameTick(room) {
  const now = Date.now();
  const players = [...room.players.values()].filter((p) => p.connected);

  // --- Pings: reveal every alive shadow's current position to hunters. ---
  if (now >= room.nextPingAt) {
    room.pingSnapshot = players
      .filter((p) => p.role === 'shadow' && !p.caught && p.hasFix)
      .map((p) => ({ id: p.id, lat: p.lat, lng: p.lng }));
    room.pingUntil = now + room.config.pingDurationSec * 1000;
    room.nextPingAt = now + room.config.pingIntervalSec * 1000;
    for (const p of players) {
      send(p.ws, { type: 'ping' });
    }
  }

  // --- Catches: a Hunter within catchRadius tags a Shadow. ---
  const hunters = players.filter((p) => p.role === 'hunter' && p.hasFix);
  for (const s of players) {
    if (s.role !== 'shadow' || s.caught || !s.hasFix) continue;
    let tagger = null;
    for (const h of hunters) {
      if (distanceM(s, h) <= room.config.catchRadiusM) { tagger = h; break; }
    }
    if (tagger) {
      s.caught = true;
      if (room.config.convertOnCatch) s.role = 'hunter';
      for (const p of players) {
        send(p.ws, { type: 'caught', id: s.id, name: s.name, by: tagger.name });
      }
    }
  }

  // --- Win conditions. ---
  const shadowsLeft = players.filter((p) => p.role === 'shadow' && !p.caught);
  if (shadowsLeft.length === 0) {
    endGame(room, 'hunters');
    return;
  }
  if (now >= room.endsAt) {
    endGame(room, 'shadows');
    return;
  }

  broadcastState(room);
}

function endGame(room, winner) {
  room.phase = 'over';
  room.winner = winner;
  if (room.tick) clearInterval(room.tick);
  room.tick = null;
  broadcastState(room);
}

// ----------------------------------------------------------------------------
// State broadcast (per-recipient visibility filtering)
// ----------------------------------------------------------------------------

function broadcastState(room) {
  const now = Date.now();
  const players = [...room.players.values()];
  const pingActive = now < room.pingUntil;
  const pingedById = new Map(room.pingSnapshot.map((s) => [s.id, s]));

  for (const me of players) {
    if (!me.connected) continue;

    const visible = [];
    for (const p of players) {
      const isSelf = p.id === me.id;
      const reveal = isSelf; // you always see yourself

      // Build the public view of player p as seen by me.
      let showLive = false;
      let pingPos = null;

      if (p.role === 'hunter') {
        // Hunters (and converted shadows) are always visible to everyone.
        showLive = true;
      } else if (p.role === 'shadow') {
        if (isSelf) {
          showLive = true;
        } else if (me.role === 'hunter' && pingActive && pingedById.has(p.id)) {
          // Hunters see shadows only at their pinged snapshot location.
          pingPos = pingedById.get(p.id);
        }
      } else {
        // Lobby (no role yet): everyone visible so the host can see the group.
        showLive = room.phase === 'lobby';
      }

      if (!reveal && !showLive && !pingPos) {
        // Still list the player (name / status) but without a position.
        visible.push({
          id: p.id, name: p.name, role: p.role, caught: p.caught,
          connected: p.connected, hasFix: p.hasFix, isHost: p.id === room.hostId(),
          lat: null, lng: null, you: isSelf,
        });
        continue;
      }

      const pos = pingPos || { lat: p.lat, lng: p.lng };
      visible.push({
        id: p.id, name: p.name, role: p.role, caught: p.caught,
        connected: p.connected, hasFix: p.hasFix, isHost: p.id === room.hostId(),
        lat: pos.lat, lng: pos.lng, acc: isSelf ? p.acc : null,
        pinged: !!pingPos, you: isSelf,
      });
    }

    const aliveShadows = players.filter((p) => p.role === 'shadow' && !p.caught && p.connected).length;
    const hunterCount = players.filter((p) => p.role === 'hunter' && p.connected).length;

    send(me.ws, {
      type: 'state',
      room: room.code,
      phase: room.phase,
      you: { id: me.id, role: me.role, caught: me.caught, isHost: me.id === room.hostId() },
      config: room.config,
      zone: room.zone,
      players: visible,
      counts: { shadows: aliveShadows, hunters: hunterCount, total: room.alivePlayers().length },
      timeLeftSec: room.phase === 'running' ? Math.max(0, Math.round((room.endsAt - now) / 1000)) : 0,
      nextPingSec: room.phase === 'running' ? Math.max(0, Math.round((room.nextPingAt - now) / 1000)) : 0,
      pingActive,
      winner: room.winner,
    });
  }
}

// ----------------------------------------------------------------------------
// Helpers
// ----------------------------------------------------------------------------

function clamp(n, lo, hi) { return Math.max(lo, Math.min(hi, n)); }

function randomCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no easily-confused chars
  let out = '';
  for (let i = 0; i < 4; i++) out += chars[Math.floor(Math.random() * chars.length)];
  return out;
}

server.listen(PORT, () => {
  console.log(`\n  Umbra manhunt server running`);
  console.log(`  Local:   http://localhost:${PORT}`);
  console.log(`  Share the LAN or tunnel URL with players (HTTPS required for GPS off-device).\n`);
});
