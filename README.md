# Thredy

A self-hosted, real-time chat platform inspired by Discord: servers, text channels, live messaging, and online presence. Text chat only for now — no voice/video.

## Stack
- **Backend:** Node.js, Express, Socket.io, SQLite (via `better-sqlite3`), JWT auth, bcrypt password hashing
- **Frontend:** Plain HTML/CSS/JavaScript — no build step, no framework

## Features
- Register / log in (JWT-based sessions)
- Create a server → get a shareable invite code
- Join a server with an invite code
- Create text channels inside a server
- Real-time messaging via WebSockets (Socket.io)
- Message history stored in SQLite and loaded on channel open
- Live online/offline presence and a "user is typing…" indicator

## Running it locally

Requirements: **Node.js 18+**

```bash
npm install
cp .env.example .env
```

Open `.env` and set `JWT_SECRET` to a long random string (this is what signs login sessions — keep it secret):

```
PORT=3000
JWT_SECRET=replace_with_a_long_random_string
CORS_ORIGIN=*
```

Then start it:

```bash
npm start
```

Visit **http://localhost:3000**, create an account, create a server, and share the invite code (shown in a toast when you open a server you own) with a friend so they can join.

## Deploying to your own server/host

Thredy is a single Node process that serves both the API and the static frontend, so hosting it is straightforward:

1. Copy this folder to your server (or `git clone` it if you push it to a repo).
2. `npm install --production`
3. Create a `.env` file as above. Set `CORS_ORIGIN` to your actual domain (e.g. `https://chat.example.com`) instead of `*` once you're live.
4. Run it with a process manager so it survives reboots and restarts on crash, e.g.:
   ```bash
   npm install -g pm2
   pm2 start server.js --name thredy
   pm2 save
   ```
5. Put a reverse proxy (Nginx or Caddy) in front of it for HTTPS and to forward port 80/443 to the app's port. Socket.io needs WebSocket upgrade headers forwarded — for Nginx add:
   ```nginx
   location / {
     proxy_pass http://localhost:3000;
     proxy_http_version 1.1;
     proxy_set_header Upgrade $http_upgrade;
     proxy_set_header Connection "upgrade";
     proxy_set_header Host $host;
   }
   ```
6. The SQLite database file (`thredy.db`) is created automatically next to `server.js`. Back it up periodically — it's the entire state of your platform (users, servers, channels, messages).

## Project structure

```
thredy/
├── server.js              # Entry point: Express + Socket.io setup
├── db.js                  # SQLite connection + schema
├── middleware/auth.js      # JWT sign/verify + auth middleware
├── routes/
│   ├── auth.js             # /api/auth/register, /login, /me
│   ├── servers.js          # /api/servers (create, join, channels, members)
│   └── messages.js         # /api/messages/:channelId (history)
├── sockets/index.js        # Real-time messaging, presence, typing
└── public/                 # Frontend (served as static files)
    ├── index.html
    ├── css/style.css
    └── js/app.js
```

## Notes and next steps
- Passwords are hashed with bcrypt; never stored in plaintext.
- Messages are rate-limited per socket (8 messages / 5 seconds) to blunt basic spam/flooding. It's intentionally simple — fine for a small self-hosted community, not meant to stop a determined attacker running many connections.
- Only the server owner can create channels for now. Anyone with a server's invite code can join it — there's no admin approval step yet. A fuller role/permission system (admin/mod roles, per-channel permissions, kicking/banning, regenerating invite codes) is a natural next feature.
- Member lists and presence update live over the socket connection (joining a server, going online/offline) — no page reload needed.
- Voice/video channels would need WebRTC (with a STUN/TURN server for users behind NATs) — a separate, sizable addition on top of this.
- For production scale beyond a single server process, you'd eventually swap SQLite for Postgres and add a Redis adapter for Socket.io so you can run multiple app instances behind a load balancer.
- `CORS_ORIGIN` in `.env` is actually wired into the Express CORS middleware — set it to your real domain once you're live instead of leaving it as `*`.
