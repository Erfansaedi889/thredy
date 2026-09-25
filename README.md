# Thredy (v0.2 — Beta)

A self-hosted, real-time chat platform inspired by Discord: a public homepage, full account creation with email verification, servers with text channels, friends and direct messages (1:1 and group), blocking, an optional "Loom" membership with server boosts, and a small admin panel.

Built and maintained by **Abolfazl**.

## Stack
- **Backend:** Node.js, Express, Socket.io, SQLite (`better-sqlite3`), JWT auth, bcrypt, Nodemailer
- **Frontend:** Plain HTML/CSS/JavaScript — no build step, no framework

## What's in this release

**Public homepage** (`/`) — hero, feature overview, a changelog/news section, and a Loom section. Log in / Sign up buttons lead into the actual app at `/app/`.

**Full registration** — full name, username, email (required + verified), phone (optional), date of birth (13+ only), password + confirmation, and a Terms & Policy agreement checkbox. Accounts can't log in until the email is verified. If SMTP isn't configured, the verification link is printed to the server console (and shown in the UI in dev mode) instead of emailed, so you can still test the full flow locally.

**Servers & channels** — create a server, get an invite code, join other servers, create text channels (server owner only for now), real-time messaging, message history, typing indicators, online presence.

**Friends & DMs** — send a friend request by username, accept/decline, remove a friend. Start a direct message with one friend, or a group DM with three or more people. Block/unblock a user — blocking removes any existing friendship and stops new DMs between you.

**Profile** — change your display name, bio, and avatar color from the profile modal (click your username in the sidebar).

**Loom** — an optional membership. It's not self-serve: purchasing returns a message pointing people to Abolfazl. Granting Loom to an account gives it **3 free boosts**, which can be spent on any server the account is a member of. Boosting raises a server's boost level (level 1 at 2 boosts, level 2 at 7, level 3 at 14 — same shape as a familiar "boost" system).

**Admin panel** — lists all users and lets an admin grant/revoke Loom (with its 3 boosts) or add boosts directly. See "Becoming an admin" below — this is intentionally not exposed to regular users.

**Right-click menu disabled** — the browser's default context menu (Back/Forward/Reload/Save As/Inspect, etc.) is suppressed site-wide. Note this is cosmetic: it doesn't and can't block a determined user's browser devtools.

## Running it locally

Requirements: **Node.js 18+**

```bash
npm install
cp .env.example .env
```

Open `.env` and set at minimum:

```
PORT=3000
JWT_SECRET=replace_with_a_long_random_string
CORS_ORIGIN=*
APP_URL=http://localhost:3000
```

Then start it:

```bash
npm start
```

Visit **http://localhost:3000** for the homepage, or **http://localhost:3000/app/** to jump straight to the app. Create an account — since SMTP isn't configured by default, the verification link will be printed in your terminal. Copy it into your browser to verify, then log in.

### Setting up real email (optional but recommended for production)

Without SMTP settings, verification links only appear in the server console — fine for testing, not for real users. To send real emails, add to `.env`:

```
SMTP_HOST=smtp.gmail.com
SMTP_PORT=587
SMTP_USER=you@gmail.com
SMTP_PASS=your_app_password
SMTP_FROM="Thredy <no-reply@yourdomain.com>"
```

Any standard SMTP provider works (Gmail with an app password, SendGrid, Mailgun, Amazon SES, etc.) — just point the host/port/user/pass at whichever you use. Also set `APP_URL` to your real public URL so the verification link in the email points somewhere reachable.

### Becoming an admin

There's no sign-up flag for admin — that's intentional, so nobody can grant it to themselves. To make your own account an admin, run this **on the server**, after your account exists and its email is verified:

```bash
node scripts/make-admin.js your_username
```

Log out and back in (or just refresh — `/api/auth/me` is re-checked) and you'll see a 🛠️ admin icon in the server rail. From there you can grant Loom (and its 3 free boosts) to any account, or add boosts directly.

## Deploying to your own server/host

1. Copy this folder to your server.
2. `npm install --production`
3. Create `.env` as above, with real `JWT_SECRET`, `CORS_ORIGIN` set to your actual domain, `APP_URL` set to your public URL, and SMTP settings if you want real verification emails.
4. Run it with a process manager:
   ```bash
   npm install -g pm2
   pm2 start server.js --name thredy
   pm2 save
   ```
5. Put a reverse proxy (Nginx or Caddy) in front for HTTPS, forwarding WebSocket upgrade headers for Socket.io:
   ```nginx
   location / {
     proxy_pass http://localhost:3000;
     proxy_http_version 1.1;
     proxy_set_header Upgrade $http_upgrade;
     proxy_set_header Connection "upgrade";
     proxy_set_header Host $host;
   }
   ```
6. Run `node scripts/make-admin.js your_username` once your account exists, to make yourself an admin.
7. The SQLite file (`thredy.db`) holds all state — back it up periodically.

## Project structure

```
thredy/
├── server.js                # Entry point: Express + Socket.io, mounts all routes
├── db.js                    # SQLite connection + full schema
├── middleware/
│   ├── auth.js               # JWT sign/verify + requireAuth
│   └── admin.js               # requireAdmin (re-checks DB, doesn't trust the JWT)
├── utils/mailer.js           # Sends verification emails, or logs the link if SMTP isn't set
├── scripts/make-admin.js     # CLI: node scripts/make-admin.js <username>
├── routes/
│   ├── auth.js                # register, verify-email, resend-verification, login, me
│   ├── servers.js             # create/join servers, channels, members, boost
│   ├── messages.js            # channel message history
│   ├── users.js               # edit profile, look up a user by username
│   ├── friends.js             # friend requests, friends list
│   ├── blocks.js               # block/unblock, blocked list
│   ├── dms.js                  # 1:1 and group DMs
│   ├── premium.js              # Loom status, purchase gate
│   └── admin.js                # grant/revoke Loom & boosts (admin only)
├── sockets/index.js          # Real-time: channel + DM messages, presence, typing, boosts, friend notifications
└── public/
    ├── index.html             # Public homepage / landing page
    ├── css/{style,landing}.css
    ├── js/{app,no-context-menu}.js
    └── app/index.html         # The actual chat app, served at /app/
```

## Known limitations (why this is still "beta")

- Only the server owner can create channels. No moderator roles, kicking, or banning yet.
- Anyone with a server's invite code can join — no approval step.
- Loom purchasing isn't wired to a payment provider on purpose (see "Loom" above).
- No voice/video — that needs WebRTC plus a STUN/TURN server, which is a separate, sizable project on top of this.
- Message rate limiting is basic (8 messages / 5 seconds per socket) — enough to blunt casual spam, not a determined attacker running many connections.
- SQLite is great for getting started; for real scale you'd move to Postgres and add a Redis adapter for Socket.io so you can run multiple app instances behind a load balancer.
