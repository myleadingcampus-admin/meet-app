# Live Session Module (MVP)

This module implements a practical hybrid live session model:
- Main stream delivery: YouTube Live embedded player
- Live interactions: hand raise + Q&A over WebSockets
- Doubt solving/screen share: embedded public WebRTC room (MiroTalk by default)

## Deploy on Render (Free)

This repo already includes [render.yaml](render.yaml), so setup is quick.

1. Push this project to a GitHub repository.
2. In Render, click New + then Blueprint.
3. Select your GitHub repo.
4. Render will detect [render.yaml](render.yaml) and create the web service automatically.
5. Wait for deploy to finish, then open:
	- `/api/health` to verify service health.
	- `/` to use the app.

Default Render config from [render.yaml](render.yaml):
- Runtime: Node
- Plan: Free
- Build: `npm install`
- Start: `npm start`
- Health check: `/api/health`
- Env: `BREAKOUT_AUTO_CLOSE_MS=600000`

Important note for free plan:
- Render free services can sleep after inactivity, so first request may be slow.

## Run locally

```bash
npm install
npm start
```

Open:
- Home: http://localhost:3000/
- Host view: generated after creating a session
- Participant view: generated after creating a session

## Current features

- Create session
- Start session with YouTube URL
- Participant embedded YouTube player view
- Participant hand raise
- Host moderation of hand raise queue
- Realtime Q&A chat
- Host can open/close Jitsi doubt room link

## Integration into existing web app

Use this as a module in your existing web app.

### 1) Frontend embedding

- Embed/route host operations to `teacher.html?classId=<id>` logic
- Embed/route participant session to `student.html?classId=<id>` logic
- Reuse your existing JWT auth and pass user identity while joining socket rooms

### 2) Backend APIs

- `POST /api/classes` -> create session
- `GET /api/classes/:id` -> session state
- `POST /api/classes/:id/start` -> set session live + YouTube URL
- `POST /api/classes/:id/end` -> end session

### 3) Socket events

Client emits:
- `join:class` `{ classId, userId, role, name }`
- `hand-raise:add`
- `hand-raise:resolve` `{ userId, action: "accept" | "reject" }` (host)
- `chat:send` `{ message }`
- `breakout:open` `{ roomName? }` (host)
- `breakout:close` (host)

Server emits:
- `class:updated`
- `queue:updated`
- `chat:message`
- `breakout:updated`
- `breakout:invited`
- `hand-raise:result`
- `participants:count`

## Important production notes

- Storage is in-memory for MVP. Move class/chat/queue state to PostgreSQL + Redis.
- Add authorization guards with your JWT middleware.
- For 200-1000 participants, keep main audience on YouTube and only a few users in Jitsi breakout.
- Add Redis adapter for Socket.IO when scaling across multiple instances.
