# Slack ↔ HubSpot Tasks Starter (No-code friendly deploy)

This starter lets you:
- Run `/task` in Slack to open a modal
- Search & pick a HubSpot Deal inside Slack
- Create a HubSpot Task linked to that Deal (with assignee, due date, description)
- Mark the task complete from Slack
- Get a daily digest of Due Today / Overdue in a chosen Slack channel

## One-time setup

### 1) Create tokens
- **Slack**: Create a Slack app (from https://api.slack.com/apps), install to your workspace. Get:
  - `SLACK_BOT_TOKEN`
  - `SLACK_SIGNING_SECRET`
- **HubSpot**: Create a **Private App**. Copy:
  - `HUBSPOT_TOKEN`

### 2) Configure OAuth scopes & features
- Slack App → **OAuth & Permissions** → Bot Token Scopes:
  - `commands`, `chat:write`, `chat:write.public`
- Slack App → **Slash Commands**:
  - Create `/task` with Request URL: `https://YOUR-APP-URL/slack/commands`
- Slack App → **Interactivity & Shortcuts**:
  - Enable, set Request URL: `https://YOUR-APP-URL/slack/events`

### 3) Deploy (Render.com)
- Fork this repo to your GitHub account
- On Render, create a **Web Service** connected to your repo
- Environment:
  - `SLACK_BOT_TOKEN`, `SLACK_SIGNING_SECRET`, `HUBSPOT_TOKEN`
  - `PORT` (Render provides), `DIGEST_CHANNEL_ID` (e.g., your #sales channel ID)
- Build command: *(none)*
- Start command: `node src/index.js`

> To find a channel ID: In Slack, right-click a channel → View channel details → Copy channel ID.

### 4) Set URLs in Slack
- After deploy, paste your live URL into Slack app:
  - `/slack/commands` for the slash command
  - `/slack/events` for Interactivity
- Reinstall the Slack app to update permissions.

### 5) Try it
- In Slack: type `/task` → fill modal → submit
- You should get a DM confirming the HubSpot task was created.
- Click **Mark Complete** to close it in HubSpot.

### 6) Daily Digest
- By default, posts at **09:00 Europe/Warsaw** to `DIGEST_CHANNEL_ID`.
- Change schedule in `src/index.js` (cron line).

## Local dev
- `cp .env.example .env` and fill values
- `npm install`
- `npm run dev`
- Use `ngrok` to expose your local server for Slack URLs.