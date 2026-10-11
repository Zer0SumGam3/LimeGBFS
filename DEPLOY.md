# Deploying the TLV GBFS dossier on GitHub Pages (cron refresh)

`.github/workflows/refresh.yml` runs hourly: polls the public `data.lime.bike`
feed for a bounded window, rebuilds `site/` from the snapshots, recommits to
`main`, and deploys `site/` to GitHub Pages.

## One-time setup

1. Push this package as the **repository root** (the workflow assumes `build.py`
   at the root, `site/` as the artifact).
2. Repo -> Settings -> Actions -> General -> Workflow permissions -> **Read and
   write permissions** (GITHUB_TOKEN needs `contents: write` to push).
3. Repo -> Settings -> Pages -> Source: **GitHub Actions** (the workflow also
   tries to enable this automatically via `configure-pages`).
4. Actions tab -> "refresh-and-deploy" -> **Run workflow** to verify the first run.

## Why server-side refresh (and client-side LIVE mode cannot work)

The browser LIVE mode will not work from Pages: the feed sends **no
`Access-Control-Allow-Origin` header** (evidence: `evidence/CORS-headers-raw.txt`),
so any browser fetch from your domain is blocked by CORS. The deployed site
stays fresh through THIS cron loop — each run rebuilds `site/data/**` and
recommits — and OFFLINE mode reads the rolling `site/snapshots/` window bundled
in the artifact.

## Knobs (top of `refresh.yml`)

| knob | default | meaning |
|---|---|---|
| `cron` | `17 * * * *` (hourly, :17) | refresh cadence. **Public repos**: free (scheduled Actions minutes are free on public repos). **Private repos**: each run costs ~30 min — hourly is ~12 h/day, far beyond the 2,000-min/month free tier (~33 h). A free-tier fit is ~2 runs/day: `17 */12 * * *`; anything denser is billed. |
| `POLL_MINUTES` | 25 | bounded poll window per run (15 s cadence ≈ 100 snapshots ≈ 17 MB) |
| `KEEP_HOURS` | 3 | rolling snapshot window kept and shipped (≈ 120 MB in the Pages artifact; lower it if deploys feel slow) |
| `HISTORY_MODE` | `rolling` | keeps exactly **one** `refresh:` commit on main (amend-style, `--force-with-lease`) so ~20 MB/run of renders + JSON never accumulates in history. Rolls only when the tip commit is one of ours — any human commit safely falls back to append. Set `append` for ordinary commit history. |

## Notes

- `data/snapshots/` and `site/snapshots/` are gitignored and carried between
  runs by `actions/cache` (rolling key). The Pages artifact is uploaded from the
  runner workspace, so the deployed site still ships the full rolling window.
- The first refresh commit will also *delete* the pre-built snapshots that were
  committed with the initial push — that is intended (repo slims down; the
  deployed artifact keeps its window from the runner).
- GitHub may delay scheduled runs under load (5–20 min typical) and disables
  schedules after ~60 days without repo activity — the refresh commits keep it
  alive.
- Manual refresh anytime: Actions -> Run workflow (`workflow_dispatch`).
