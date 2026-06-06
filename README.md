# Sunny Capitals — Trading Dashboard

A personal trading-journal dashboard that connects live to your own Notion workspace.
Performance stats, equity curve, session/pair/setup expectancy, prop-firm pass projection,
rule-adherence scoring, a pre-trade checklist, AI trade reviews, and a daily briefing.

---

## Quick start (3 steps)

### 1. Install Node.js (one time)
Download the **LTS** version from https://nodejs.org and run the installer.

### 2. Duplicate the Notion template
Open the template — **https://app.notion.com/p/37723c91d44d81448ae6c6c795cfbe76** — and
click **Duplicate** (top-right) to copy it into your own workspace. It contains two
databases, **Accounts** and **Trades**, already set up with every field the dashboard needs.

### 3. Run the dashboard
- **Windows:** double-click `START.bat`
- **Mac/Linux:** open a terminal in this folder and run `bash START.sh`

Your browser opens at `http://localhost:3000`. On first run you'll see a **setup wizard** —
follow the 4 steps to connect your Notion integration token, your Trades database ID, and
(optionally) an Anthropic API key for AI reviews. That's it.

---

## How it works

The dashboard reads your trades live from Notion every time you open it or click **⟳ Refresh**.
Nothing is uploaded anywhere — the server runs locally on your machine and talks directly to
Notion's API (and Anthropic's, only if you add a key for AI reviews).

Your settings are saved to a local `config.json` (created by the setup wizard).

---

## Your Notion setup

**Accounts** database — one row per trading account, with:
`Account Name`, `Firm`, `Phase` (Phase 1 / Phase 2 / Funded), `Status` (Active / Passed /
Failed / Withdrawn / Backtest), `Initial Balance`, `Profit Target`, `Max Daily Loss %`,
`Max Drawdown %`. The balance/target/limit fields must be **Number** type.

**Trades** database — one row per trade, linked to an account via the `Account` relation.
Fill in `Pair`, `Direction`, `Session`, `Entry Time` (24h, e.g. `14:30`), `Open/Close Date`,
`% Risk`, `RR Ratio`, `Gross PnL`, `Commission`, `Profit/Loss`, `Status`, `Confluence`
(multi-select), and `Mistakes` (multi-select). The more you fill in, the more the analytics
can tell you — see the **Data Quality** panel on the Analysis page.

---

## ⚠ Before you share this with someone else

`config.json` and `last_review.json` contain **your** Notion token, API key and trading data.
**Do not send them to anyone.** When sharing the folder:

1. Delete `config.json` and `last_review.json` (the recipient's setup wizard creates a fresh
   `config.json`). A `config.example.json` template is included for reference.
2. If you ever exposed your Anthropic key, rotate it at https://console.anthropic.com.

(If you use git, the included `.gitignore` already excludes these files.)

---

## Troubleshooting

**"Node.js is not installed"** → install it from https://nodejs.org, then run START again.

**Dashboard shows the setup wizard again** → your `config.json` is missing or incomplete;
just complete the wizard.

**"No trades yet"** → you're connected but haven't logged trades; add one in Notion and hit
**⟳ Refresh**.

**Gauges or projections are empty** → fill in the account's Number fields (Initial Balance,
Profit Target, Max Drawdown %) and set its Status to Active.

**Port already in use** → open `server.js` and change `const PORT = 3000` to another number.

---

## Files

| File | Purpose |
|------|---------|
| `server.js` | Local Node server — talks to Notion / Anthropic |
| `dashboard.html` | The dashboard UI |
| `setup.html` | First-run setup wizard |
| `config.example.json` | Template for `config.json` (safe to share) |
| `config.json` | **Your** private settings — never share |
| `START.bat` / `START.sh` | Launch scripts |
