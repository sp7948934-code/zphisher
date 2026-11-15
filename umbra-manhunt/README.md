# Umbra — GPS Manhunt

A real-life **GPS manhunt** game for a group of friends. Your city is the map.
Players split into **Hunters** and **Shadows** and chase each other on foot, on
real streets. Shadows try to survive the round; Hunters track them down. Every
few minutes a **ping** flashes every Shadow's position on the Hunters' maps —
then it goes dark again.

It's a small web app plus a tiny WebSocket server. **No accounts, no database,
no API keys.** Free map tiles from OpenStreetMap.

> ⚠️ **Play responsibly.** This shares players' live location with each other
> while the game is open. Agree on a safe play area and boundaries first, watch
> for traffic, and only play with people who have opted in. Don't use it to
> track anyone without their knowledge and consent.

---

## How a round works

1. One person is the **host**. Everyone opens the link and joins the same
   **room code**.
2. In the lobby, each player's dot turns **green** once their phone has a GPS
   fix. The host can tune the settings (round length, ping interval, catch
   distance, play-zone size, how many hunters).
3. The host taps **Start manhunt**. Roles are assigned at random and a circular
   **play zone** is drawn around the group's starting point.
4. **Hunters** are always visible to everyone. **Shadows** are hidden — except
   during a **ping**, when their current location flashes on the Hunters' maps
   for a few seconds.
5. A Hunter who gets within the **catch distance** of a Shadow tags them. By
   default a caught Shadow **joins the Hunters** (zombie-style), so the hunt
   snowballs.
6. **Hunters win** if every Shadow is caught. **Shadows win** if at least one
   Shadow survives to the final whistle.

The server is authoritative and only tells each phone what its role is allowed
to see, so you can't cheat by peeking at the network traffic.

---

## Run it

```bash
cd umbra-manhunt
npm install
npm start
# → http://localhost:3000   (set PORT to change)
```

On the same machine, open `http://localhost:3000`. Localhost is a "secure
context", so the browser allows GPS there for quick testing.

### Playing with friends on real streets

Phones on the open internet will **only grant location over HTTPS**. Two easy
ways to get an HTTPS URL everyone can open:

- **A tunnel** (fastest): run the server locally and expose it, e.g.
  ```bash
  npx localtunnel --port 3000
  # or: cloudflared tunnel --url http://localhost:3000
  ```
  Share the `https://…` URL the tunnel prints.
- **A host**: deploy to any Node host (Render, Railway, Fly.io, a small VPS).
  Set the `PORT` env var if the platform requires it. The app serves itself on
  one port — no separate build step.

Then everyone opens the URL, allows location, enters the **same room code**, and
the host starts the game.

---

## Settings (host, in the lobby)

| Setting | Default | What it does |
| --- | --- | --- |
| Round length | 20 min | How long Shadows must survive. |
| Ping every | 3:00 | Time between pings. |
| Ping reveal | 10 s | How long a ping stays visible. |
| Catch distance | 15 m | How close a Hunter must get to tag a Shadow. |
| Play zone radius | 600 m | Size of the circle around the start point. |
| Hunters at start | ~1 in 3 | Share of players who begin as Hunters. |
| Caught → Hunter | on | Caught Shadows join the Hunters, or are simply out. |

GPS accuracy in a city is roughly 5–20 m, so a catch distance below ~10 m can
get fussy. 15–25 m plays well.

---

## Project layout

```
umbra-manhunt/
├── server.js        # HTTP static server + authoritative WebSocket game loop
├── package.json
└── public/
    ├── index.html   # lobby + game UI
    ├── style.css
    └── app.js       # map, HUD, geolocation, talks to the server
```

Tech: Node (built-in `http`) + [`ws`](https://github.com/websockets/ws) on the
server; [Leaflet](https://leafletjs.com/) + OpenStreetMap tiles on the client.
No framework, no bundler.

## License

MIT.
