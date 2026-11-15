'use strict';

/*
 * Umbra client. Talks to the game server over a WebSocket, renders the map
 * and HUD, and streams this device's GPS up while the game is open.
 *
 * The server decides everything (roles, pings, catches, winner); this file
 * only displays what the server sends and reports our position.
 */

(function () {
  const $ = (id) => document.getElementById(id);

  // ---- Elements ----
  const joinScreen = $('join');
  const gameScreen = $('game');
  const joinForm = $('join-form');
  const nameInput = $('name');
  const roomInput = $('room');
  const joinMsg = $('join-msg');

  // ---- State ----
  let ws = null;
  let me = { id: null, role: null, caught: false, isHost: false };
  let lastState = null;
  let map = null;
  let markers = new Map();   // playerId -> Leaflet marker
  let zoneCircle = null;
  let haveCentered = false;
  let myPos = null;          // {lat, lng, acc}
  let geoWatchId = null;
  let posSendTimer = null;

  // Restore name from a previous session (per-device convenience only).
  try {
    const saved = localStorage.getItem('umbra.name');
    if (saved) nameInput.value = saved;
  } catch { /* ignore */ }

  // ---- Room code helpers ----
  function randomCode() {
    const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    let out = '';
    for (let i = 0; i < 4; i++) out += chars[Math.floor(Math.random() * chars.length)];
    return out;
  }
  $('dice').addEventListener('click', () => { roomInput.value = randomCode(); });

  // ---- Join ----
  joinForm.addEventListener('submit', (e) => {
    e.preventDefault();
    const name = nameInput.value.trim();
    if (!name) { joinMsg.textContent = 'Enter a name first.'; return; }
    try { localStorage.setItem('umbra.name', name); } catch { /* ignore */ }
    joinMsg.textContent = 'Connecting…';
    connect(name, roomInput.value.trim().toUpperCase());
  });

  function wsUrl() {
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    return `${proto}://${location.host}`;
  }

  function connect(name, room) {
    ws = new WebSocket(wsUrl());
    ws.addEventListener('open', () => {
      send({ type: 'join', name, room });
    });
    ws.addEventListener('message', (ev) => {
      let msg;
      try { msg = JSON.parse(ev.data); } catch { return; }
      onMessage(msg);
    });
    ws.addEventListener('close', () => {
      if (!me.id) { joinMsg.textContent = 'Connection closed. Try again.'; return; }
      showToast('Disconnected — reconnecting…');
      setTimeout(() => connect(name, lastState ? lastState.room : room), 1500);
    });
    ws.addEventListener('error', () => {
      joinMsg.textContent = 'Could not connect to the server.';
    });
  }

  function send(obj) {
    if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj));
  }

  // ---- Incoming messages ----
  function onMessage(msg) {
    switch (msg.type) {
      case 'joined':
        me.id = msg.id;
        enterGame();
        startGeolocation();
        break;
      case 'state':
        lastState = msg;
        render(msg);
        break;
      case 'ping':
        flashPingBanner();
        break;
      case 'caught':
        if (msg.id === me.id) showToast(`You were caught by ${msg.by}!`);
        else showToast(`${msg.name} was caught by ${msg.by}`);
        break;
      case 'error':
        if (!me.id) joinMsg.textContent = msg.message;
        else showToast(msg.message);
        break;
    }
  }

  function enterGame() {
    joinScreen.hidden = true;
    gameScreen.hidden = false;
    if (!map) initMap();
    setTimeout(() => map.invalidateSize(), 60);
    wireHostControls();
  }

  // ---- Map ----
  function initMap() {
    map = L.map('map', { zoomControl: false, attributionControl: true }).setView([0, 0], 2);
    L.control.zoom({ position: 'bottomright' }).addTo(map);
    L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxZoom: 19,
      attribution: '&copy; OpenStreetMap',
    }).addTo(map);
  }

  function markerIcon(p, isSelf) {
    const cls = isSelf ? 'self' : (p.role === 'hunter' ? 'hunter' : 'shadow');
    const ping = p.pinged ? ' ping' : '';
    const label = isSelf ? 'You' : p.name;
    return L.divIcon({
      className: '',
      html: `<div class="pin ${cls}${ping}"><div class="tag">${escapeHtml(label)}</div><div class="core"></div></div>`,
      iconSize: [18, 18],
      iconAnchor: [9, 9],
    });
  }

  // ---- Render ----
  function render(s) {
    me.role = s.you.role;
    me.caught = s.you.caught;
    me.isHost = s.you.isHost;

    renderRole(s);
    renderHud(s);
    renderPlayers(s);
    renderZone(s);

    // Overlays
    $('lobby').hidden = s.phase !== 'lobby';
    $('over').hidden = s.phase !== 'over';
    if (s.phase === 'lobby') renderLobby(s);
    if (s.phase === 'over') renderOver(s);
  }

  function renderRole(s) {
    const badge = $('role-badge');
    $('room-badge').textContent = s.room;
    if (s.phase === 'lobby') { badge.textContent = 'Lobby'; badge.className = 'badge'; return; }
    if (me.caught && s.config.convertOnCatch) { badge.textContent = 'Hunter (was caught)'; badge.className = 'badge hunter'; return; }
    if (me.caught) { badge.textContent = 'Caught'; badge.className = 'badge caught'; return; }
    if (me.role === 'hunter') { badge.textContent = 'Hunter'; badge.className = 'badge hunter'; }
    else { badge.textContent = 'Shadow'; badge.className = 'badge shadow'; }
  }

  function renderHud(s) {
    $('timer').textContent = s.phase === 'running' ? fmtTime(s.timeLeftSec) : '--:--';
    $('ping-timer').textContent = s.phase === 'running' ? (s.pingActive ? 'NOW' : fmtTime(s.nextPingSec)) : '--:--';
    $('count-shadows').textContent = s.counts.shadows;
    $('count-hunters').textContent = s.counts.hunters;
    const subhud = $('subhud');
    subhud.hidden = s.phase !== 'running';
  }

  function renderPlayers(s) {
    const seen = new Set();
    for (const p of s.players) {
      if (p.lat == null || p.lng == null) continue;
      seen.add(p.id);
      const isSelf = p.id === me.id;
      let m = markers.get(p.id);
      const icon = markerIcon(p, isSelf);
      if (!m) {
        m = L.marker([p.lat, p.lng], { icon, zIndexOffset: isSelf ? 1000 : 0 });
        m.addTo(map);
        markers.set(p.id, m);
      } else {
        m.setLatLng([p.lat, p.lng]);
        m.setIcon(icon);
      }
    }
    // Remove markers we no longer see (e.g. a shadow that stopped being pinged).
    for (const [id, m] of markers) {
      if (!seen.has(id)) { map.removeLayer(m); markers.delete(id); }
    }
    // Center on us the first time we appear.
    const selfP = s.players.find((p) => p.id === me.id && p.lat != null);
    if (selfP && !haveCentered) {
      map.setView([selfP.lat, selfP.lng], 16);
      haveCentered = true;
    }
  }

  function renderZone(s) {
    if (!s.zone) {
      if (zoneCircle) { map.removeLayer(zoneCircle); zoneCircle = null; }
      $('zone-banner').hidden = true;
      return;
    }
    if (!zoneCircle) {
      zoneCircle = L.circle([s.zone.lat, s.zone.lng], {
        radius: s.zone.radius, color: '#7c4dff', weight: 2,
        fillColor: '#7c4dff', fillOpacity: 0.06, dashArray: '6 8',
      }).addTo(map);
    } else {
      zoneCircle.setLatLng([s.zone.lat, s.zone.lng]);
      zoneCircle.setRadius(s.zone.radius);
    }
    // Out-of-zone warning (based on our own last fix).
    if (s.phase === 'running' && myPos) {
      const d = haversine(myPos, s.zone);
      $('zone-banner').hidden = d <= s.zone.radius;
    } else {
      $('zone-banner').hidden = true;
    }
  }

  // ---- Lobby ----
  function renderLobby(s) {
    $('lobby-room').textContent = s.room;
    const ul = $('lobby-players');
    ul.innerHTML = '';
    for (const p of s.players) {
      const li = document.createElement('li');
      const dot = document.createElement('span');
      dot.className = 'dot' + (p.hasFix ? ' ok' : '');
      li.appendChild(dot);
      const nm = document.createElement('span');
      nm.textContent = p.name;
      li.appendChild(nm);
      if (p.isHost) {
        const h = document.createElement('span'); h.className = 'host-tag'; h.textContent = 'host'; li.appendChild(h);
      }
      if (p.id === me.id) {
        const y = document.createElement('span'); y.className = 'you'; y.textContent = 'you'; li.appendChild(y);
      }
      ul.appendChild(li);
    }
    $('host-controls').hidden = !me.isHost;
    $('wait-msg').hidden = me.isHost;
  }

  let hostWired = false;
  function wireHostControls() {
    if (hostWired) return;
    hostWired = true;

    const sliders = [
      ['s-duration', 'o-duration', (v) => `${v} min`],
      ['s-ping', 'o-ping', (v) => fmtTime(+v)],
      ['s-pingdur', 'o-pingdur', (v) => `${v}s`],
      ['s-catch', 'o-catch', (v) => `${v} m`],
      ['s-zone', 'o-zone', (v) => `${v} m`],
      ['s-ratio', 'o-ratio', (v) => ratioLabel(+v)],
    ];
    for (const [sid, oid, fmt] of sliders) {
      const s = $(sid), o = $(oid);
      const update = () => { o.textContent = fmt(s.value); sendConfig(); };
      s.addEventListener('input', () => { o.textContent = fmt(s.value); });
      s.addEventListener('change', update);
    }
    $('s-convert').addEventListener('change', sendConfig);

    $('start-btn').addEventListener('click', () => send({ type: 'start' }));
    $('again-btn').addEventListener('click', () => send({ type: 'reset' }));
  }

  function sendConfig() {
    send({
      type: 'config',
      config: {
        durationSec: +$('s-duration').value * 60,
        pingIntervalSec: +$('s-ping').value,
        pingDurationSec: +$('s-pingdur').value,
        catchRadiusM: +$('s-catch').value,
        zoneRadiusM: +$('s-zone').value,
        hunterRatio: +$('s-ratio').value / 100,
        convertOnCatch: $('s-convert').checked,
      },
    });
  }

  function ratioLabel(pct) {
    const inv = Math.max(1, Math.round(100 / pct));
    return `~1 in ${inv}`;
  }

  // ---- Game over ----
  function renderOver(s) {
    const title = $('over-title'), sub = $('over-sub');
    const iWon =
      (s.winner === 'hunters' && (me.role === 'hunter')) ||
      (s.winner === 'shadows' && me.role === 'shadow' && !me.caught);
    if (s.winner === 'hunters') {
      title.textContent = 'Hunters win';
      sub.textContent = 'Every shadow was tracked down.';
    } else {
      title.textContent = 'Shadows win';
      sub.textContent = 'A shadow survived to the final whistle.';
    }
    title.style.color = s.winner === 'hunters' ? 'var(--hunter)' : 'var(--shadow)';
    if (iWon) sub.textContent += ' You made it. 🏆';
    $('again-btn').hidden = !me.isHost;
    $('again-hint').hidden = me.isHost;
  }

  // ---- Geolocation ----
  function startGeolocation() {
    if (!('geolocation' in navigator)) {
      setGpsChip(false, 'No GPS');
      return;
    }
    let lastSent = 0;
    geoWatchId = navigator.geolocation.watchPosition(
      (pos) => {
        myPos = { lat: pos.coords.latitude, lng: pos.coords.longitude, acc: pos.coords.accuracy };
        setGpsChip(true, `±${Math.round(pos.coords.accuracy)}m`);
        // Send the first fix (and any fix after a 2s gap) right away for snappy feedback.
        const now = Date.now();
        if (now - lastSent > 2000) {
          lastSent = now;
          send({ type: 'pos', lat: myPos.lat, lng: myPos.lng, acc: myPos.acc });
        }
      },
      (err) => {
        setGpsChip(false, err.code === 1 ? 'Location blocked' : 'No fix');
      },
      { enableHighAccuracy: true, maximumAge: 2000, timeout: 15000 }
    );
    // Also push on a steady cadence so stationary players keep reporting
    // (watchPosition may not fire when you don't move).
    posSendTimer = setInterval(() => {
      if (myPos) { lastSent = Date.now(); send({ type: 'pos', lat: myPos.lat, lng: myPos.lng, acc: myPos.acc }); }
    }, 3000);
  }

  function setGpsChip(ok, text) {
    const chip = $('gps-chip');
    chip.textContent = ok ? `GPS ${text}` : text;
    chip.className = 'chip chip-gps ' + (ok ? 'ok' : 'bad');
  }

  // ---- UI bits ----
  let pingBannerTimer = null;
  function flashPingBanner() {
    const b = $('ping-banner');
    b.hidden = false;
    clearTimeout(pingBannerTimer);
    const dur = (lastState && lastState.config ? lastState.config.pingDurationSec : 10) * 1000;
    pingBannerTimer = setTimeout(() => { b.hidden = true; }, dur);
  }

  let toastTimer = null;
  function showToast(text) {
    const t = $('toast');
    t.textContent = text;
    t.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { t.hidden = true; }, 4000);
  }

  // ---- utils ----
  function fmtTime(sec) {
    sec = Math.max(0, Math.round(sec));
    const m = Math.floor(sec / 60);
    const s = sec % 60;
    return `${m}:${String(s).padStart(2, '0')}`;
  }
  function haversine(a, b) {
    const R = 6371000;
    const dLat = ((b.lat - a.lat) * Math.PI) / 180;
    const dLng = ((b.lng - a.lng) * Math.PI) / 180;
    const la1 = (a.lat * Math.PI) / 180, la2 = (b.lat * Math.PI) / 180;
    const h = Math.sin(dLat / 2) ** 2 + Math.cos(la1) * Math.cos(la2) * Math.sin(dLng / 2) ** 2;
    return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
  }
  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  // Keep the screen awake during a game, where supported.
  let wakeLock = null;
  async function requestWake() {
    try {
      if ('wakeLock' in navigator) wakeLock = await navigator.wakeLock.request('screen');
    } catch { /* ignore */ }
  }
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && !gameScreen.hidden) requestWake();
  });
  gameScreenObserverStart();
  function gameScreenObserverStart() {
    const mo = new MutationObserver(() => { if (!gameScreen.hidden) requestWake(); });
    mo.observe(gameScreen, { attributes: true, attributeFilter: ['hidden'] });
  }
})();
