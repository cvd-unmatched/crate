# Crate

A small self-hosted site that pulls in your Discogs collection so you can record what you paid, what shipping cost, and what you sold each record for.

- **Refresh** pulls your collection from Discogs whenever you press it.
- **Paid / Shipping / Sold** are editable per record. Hover a row, click the field, type `12.50` or `12,50`. Enter saves and jumps to the next record, Esc cancels.
- **Gifts**: hover a row and click the gift icon next to Paid. A gift counts as paid nothing; any price you typed before is kept and comes back if you undo it.
- **Where you got it**: hover a row and click "Where did you get it?" under the title (say, `rommelmarkt Patershol`). Places you've used before are suggested as you type, and search finds them.
- **Bundles**: tick the records from one order (shift-click selects a range), choose **New bundle**, and enter the shipping once. It's split evenly across the records (leftover cents go to the first ones, so the parts always add up exactly) and shown separately from each record's price.
- **Cost** = paid + shipping (or shipping share). **Profit** = sold − cost, only when the purchase price is known.
- **Search** by artist, title, label, catalog number or year. Press `/` to jump to it.
- Records you remove on Discogs (say, after selling them) stay in Crate with their prices, marked "No longer on Discogs". Records without any data you entered are simply dropped.

## Get a Discogs token

Create a personal access token at https://www.discogs.com/settings/developers, then copy `.env.example` to `.env` and paste it after `DISCOGS_TOKEN=`. Crate only reads your collection with it.

## Run with Docker (recommended)

Put `compose.yaml` and your `.env` in one folder, set the image version in `compose.yaml` to the tag you released, then:

```bash
docker compose up -d
```

Open http://localhost:5178 and press **Import from Discogs**.

### Ports

| Container port | Protocol | What | Published in `compose.yaml` as |
| --- | --- | --- | --- |
| `5178` | TCP (HTTP) | Web page and API | `127.0.0.1:5178:5178`, so only this machine can reach it |

The container port follows `PORT`. You can publish it on any outside port (for example `127.0.0.1:8080:5178`); `localhost` works on any port.

### Volumes

| Path in container | Volume in `compose.yaml` | Contains |
| --- | --- | --- |
| `/data` | `crate-data` (named volume) | `collection.json`: every price, bundle and gift you've entered, plus the synced Discogs details. `collection.json.bak`: the version before the last save. |

This is the only thing worth backing up. The container runs as user `node` (uid 1000); if you use a bind mount instead of the named volume, that folder must be writable by uid 1000.

### Environment variables

Set these in `.env`. `compose.yaml` loads it with `env_file`.

| Variable | Required | Default (Docker image) | Default (plain Node) | What it does |
| --- | --- | --- | --- | --- |
| `DISCOGS_TOKEN` | **Yes** | none | none | Your Discogs personal access token. Without it the page shows setup steps. |
| `ALLOWED_HOSTS` | No | empty | empty | Extra host names you'll open Crate by, comma separated, e.g. `homelab,homelab.tailnet.ts.net,100.101.102.103`. An entry without a port matches any port. `localhost`, `127.0.0.1` and `[::1]` are always allowed. Anything else is refused, which blocks DNS-rebinding attacks. |
| `PORT` | No | `5178` | `5178` | Port the server listens on. |
| `HOST` | No | `0.0.0.0` | `127.0.0.1` | Address the server listens on. Inside Docker it has to be `0.0.0.0`; control who can reach it with the `ports:` line instead. |
| `DATA_DIR` | No | `/data` | `./data` | Folder for `collection.json` and its backup. |

`compose.yaml` pins `HOST`, `PORT` and `DATA_DIR` under `environment:`, which wins over `.env`, so a stray line in `.env` can't break the container.

The image also sets `CRATE_VERSION` to the release it was built from; it's shown at the bottom of the page. You don't need to set it. Running from source shows `dev`.

### Reaching it from other devices

Crate has **no login**, so never publish it to the internet. To use it from your phone or laptop, go through Tailscale:

1. Change the port line to your server's Tailscale IP: `"100.101.102.103:5178:5178"`.
2. Add the names you'll type in the browser to `.env`: `ALLOWED_HOSTS=homelab,homelab.your-tailnet.ts.net,100.101.102.103`.
3. `docker compose up -d`, then open `http://homelab:5178` from any device on your tailnet.

### Back up, restore, upgrade

Back up before every upgrade:

```bash
docker compose cp crate:/data/collection.json ./crate-backup.json
```

Restore a backup (stop first, so the running app can't save over it):

```bash
docker compose stop crate
docker compose cp ./crate-backup.json crate:/data/collection.json
docker compose start crate
```

Upgrade: back up, change the version in `compose.yaml`, then:

```bash
docker compose pull
docker compose up -d
```

## Releasing an image

Pushing a version tag to GitHub runs the tests and then builds the image for `linux/amd64` and `linux/arm64` (see `.github/workflows/docker.yml`):

```bash
git tag v1.0.0
git push origin v1.0.0
```

Tags must look like `v1.2.3`. Tag `v1.2.3` publishes `ghcr.io/cvd-unmatched/crate:1.2.3`, `:1.2`, `:1` and `:latest`. Pin the full version in `compose.yaml`.

The first time, GitHub may create the package as private. Either make it public (your GitHub profile → Packages → crate → Package settings → Change visibility), or log in on the machine that pulls it with a token that has `read:packages`:

```bash
docker login ghcr.io -u cvd-unmatched
```

To build the image yourself instead:

```bash
docker build -t crate .
```

## Run without Docker

Requires Node 22 or newer. There are no dependencies to install.

```bash
npm start
```

Then open http://localhost:5178. Data goes to `./data/collection.json`.

## Your data

Every save writes a temp file and renames it into place, and the previous version is kept as `collection.json.bak`. If the file is ever unreadable, Crate refuses to start rather than overwrite it. On `docker stop` it finishes any save in progress before exiting.

## Security

- Listens on `127.0.0.1` outside Docker; the compose file publishes it on `127.0.0.1` only.
- Requests must use an allowed host name (blocks DNS rebinding), and writes must come from the page itself (blocks CSRF).
- Your Discogs token stays on the server; the browser never sees it, it's never logged, and it's kept out of the image and the git repo.
- Strict Content-Security-Policy, no third-party scripts, fonts or npm packages. The container runs as a non-root user.

## Tests

```bash
npm test
```
