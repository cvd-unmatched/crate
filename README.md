# Crate

A small local site that pulls in your Discogs collection so you can record what you paid, what shipping cost, and what you sold each record for.

- **Refresh** pulls your collection from Discogs whenever you press it.
- **Paid / Shipping / Sold** are editable per record. Type `12.50` or `12,50`. Enter saves and jumps to the next record, Esc cancels.
- **Bundles**: tick the records from one order (shift-click selects a range), choose **New bundle**, and enter the shipping once. It's split evenly across the records (leftover cents go to the first ones, so the parts always add up exactly) and shown separately from each record's price.
- **Cost** = paid + shipping (or shipping share). **Profit** = sold − cost, only when the purchase price is known.
- Records you remove on Discogs (say, after selling them) stay in Crate with their prices, marked "No longer on Discogs". Records without any data you entered are simply dropped.

## Setup

Requires Node 22 or newer. There are no dependencies to install.

1. Create a personal access token at https://www.discogs.com/settings/developers
2. Copy `.env.example` to `.env` and paste the token after `DISCOGS_TOKEN=`
3. Run it:

```bash
npm start
```

Then open http://localhost:5178 and press **Import from Discogs**.

## Your data

Everything is stored in `data/collection.json` (change the folder with `DATA_DIR`). Every save writes a temp file and renames it into place, and the previous version is kept as `collection.json.bak`. If the file is ever unreadable, Crate refuses to start rather than overwrite it.

## Security

Crate has **no login**. It's built to run on your own machine:

- It listens on `127.0.0.1` only, and rejects requests whose `Host` isn't localhost (blocks DNS rebinding).
- Writes must come from the page itself: cross-origin requests are refused (blocks CSRF).
- Your Discogs token stays on the server; the browser never sees it and it's never logged.
- Strict Content-Security-Policy, no third-party scripts, fonts or npm packages.

If you want to reach it from other devices, put it behind something that handles access, such as Tailscale, and set `HOST=0.0.0.0` plus `ALLOWED_HOSTS=your-machine.your-tailnet.ts.net:5178`. Don't expose it to the public internet as is.

## Tests

```bash
npm test
```
