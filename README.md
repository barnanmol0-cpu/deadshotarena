# Deadshot-inspired multiplayer arena game

This project is now a true browser-based multiplayer shooter inspired by the style and energy of Deadshot.io. It includes:

- a neon tactical HUD
- WASD movement and mouse aim
- click-to-fire combat
- synchronized multiplayer state via WebSockets
- score, kill tracking, and health system
- a live arena with other players and bots

## Run locally

From the project folder, start the multiplayer server:

```powershell
"C:\Program Files\Adobe\Adobe Creative Cloud Experience\libs\node.exe" server.js
```

Then open:

```text
http://localhost:3001
```

## Files

- `index.html` – main UI and HUD layout
- `style.css` – arena styling and Deadshot-inspired visual design
- `script.js` – client-side networking, controls, and rendering
- `server.js` – authoritative multiplayer gameplay server
- `package.json` – startup script for the game server

## Notes

This version uses a real WebSocket server and shared game state instead of local-only simulation, so multiple browser clients can connect to the same match state.
