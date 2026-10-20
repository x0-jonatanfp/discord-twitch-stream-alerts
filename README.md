# Discord Twitch Stream Alerts

A TypeScript Discord bot that posts an alert when configured Twitch channels go live. Each Discord server has its own alert channel and Twitch channel list. Shared Twitch channels are monitored once and announced in every server that subscribes to them.

## Requirements

- Node.js 22+
- pnpm 11+
- A Discord bot application/token
- A Twitch developer application (Client ID and Client Secret)

## Discord setup

1. Create a Discord application and bot in the [Developer Portal](https://discord.com/developers/applications).
2. Invite it to each guild with `bot` scope and the permissions `View Channels`, `Send Messages`, and `Embed Links`.
3. No Administrator permission, message-content intent, or member/presence intent is needed.
4. Copy the bot token to local `.env` as `DISCORD_TOKEN`.

## Twitch setup (no Twitch CLI needed)

1. Register a Twitch application at the [Twitch Developer Console](https://dev.twitch.tv/console/apps).
2. Add this exact OAuth Redirect URL: `http://localhost:3000`.
3. Copy its Client ID and Client Secret to local `.env` as `TWITCH_CLIENT_ID` and `TWITCH_CLIENT_SECRET`.
4. Install dependencies, then run `pnpm auth:twitch` from the project directory.
5. Open the displayed Twitch authorization URL and approve the application. The local callback validates OAuth state and writes the user access and refresh tokens to `.env` without printing them.
6. Twitch EventSub WebSocket requires a user access token. `stream.online` requires no additional scopes. The bot refreshes expired access tokens and persists token rotation.

The redirect server binds to loopback on port 3000 only for the OAuth setup and shuts down after authorization or timeout. Nothing needs a public callback URL.

## Local configuration

```bash
cp .env.example .env
chmod 600 .env
cp config/guilds.example.json config/guilds.json
```

Fill `.env` locally. Edit `config/guilds.json` for each Discord guild:

```json
{
  "guilds": [
    {
      "guildId": "YOUR_DISCORD_SERVER_ID",
      "alertChannelId": "YOUR_TEXT_CHANNEL_ID",
      "twitchChannels": ["streamer_one", "streamer_two"]
    }
  ]
}
```

Enable Developer Mode in Discord, then copy server and text channel IDs. Twitch names are channel logins, not URLs. The same Twitch channel can appear in different guild entries; that stream gets an alert in each listed Discord channel.

If a configured Twitch login cannot be resolved (the account was renamed or deleted), the bot logs a warning and keeps monitoring the remaining channels. Update `config/guilds.json` and restart to fix it.

Bot presence matches `server-status`: `BOT_ACTIVITY_TYPE=Custom`, `BOT_ACTIVITY_NAME=x0void.com` and `BOT_ACTIVITY_STATE=🔗 x0void.com`. This free-form custom state is not a clickable link. `BOT_ACTIVITY_URL` is only used by a `Streaming` activity and then must be an HTTPS Twitch/YouTube URL. Presence is reapplied after Discord shard ready/resume events and each Twitch reconciliation cycle.

## Run

```bash
pnpm install
pnpm auth:twitch
pnpm dev
```

Build/run production JavaScript:

```bash
pnpm build
pnpm start
```

## Despliegue con systemd

La unidad está en `deploy/announcements.service` y es una plantilla: `make install` sustituye `@DEPLOY_USER@`, `@DEPLOY_GROUP@`, `@DEPLOY_HOME@`, `@DEST@` y `@NODE_BIN@` antes de instalarla. Por defecto usa el usuario que ejecuta `make`, `/srv/services/announcements` y el `node` del `PATH`; se pueden cambiar por variables:

```bash
make install DEPLOY_USER=announcements DEPLOY_GROUP=announcements DEST=/srv/announcements
```

La instalación del servicio y la actualización del código son pasos separados:

```bash
make install  # crea el destino, instala la unidad y la config; no la habilita ni arranca
make deploy   # build, dependencias de producción y código; habilita si hace falta y reinicia la unidad
```

Antes del primer `make deploy`, prepara `/srv/services/announcements/.env` con permisos `600` y `config/guilds.json` para producción. El deploy no copia `.env` y conserva la configuración de guild existente; `make install` crea esa configuración a partir de la copia local solo si aún no existe. La unidad carga el `.env` del destino con `EnvironmentFile=`; la aplicación también lo lee desde su directorio de trabajo.

`TWITCH_RECONCILE_INTERVAL_SECONDS` defaults to 60 (valid 15–3600). EventSub supplies normal near-real-time start notifications; Helix polling reconciles after reconnect/startup and recovers events missed while disconnected. State is stored under `data/live-state.json` by default.

## Development and tests

```bash
pnpm typecheck
pnpm test
pnpm build
```

Tests use fakes and must not send real Discord messages or create Twitch subscriptions.

## Secret handling

- Never commit `.env`, `config/guilds.json`, OAuth tokens, Discord tokens, or Twitch Client Secret.
- `.env.example` and `config/guilds.example.json` are safe templates only.
- Each person hosting a copy must create their own Discord and Twitch applications and provide their own credentials.
- If a token or client secret is accidentally shared or committed, revoke/rotate it immediately.

## Licencia

MIT. Consulta [LICENSE](LICENSE).
