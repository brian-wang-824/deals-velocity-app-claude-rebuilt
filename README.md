# Deals Velocity

A small static dashboard that tracks the Slickdeals frontpage and ranks deals by recent vote velocity. The scraper writes JSON snapshots into `site/public/data/`, and the frontend renders the latest snapshot as a searchable, sortable deal grid.

## What It Does

- Scrapes Slickdeals frontpage cards on a scheduled GitHub Actions workflow.
- Keeps a rolling history of recent snapshots in `history.json`.
- Computes vote delta, recent velocity, lifetime velocity, discount percentage, and velocity labels.
- Publishes a static site that reads `data/deals.json`.
- Lets users filter by posted-time window, search title/store text, and sort by velocity, votes, or newest post time.

## Repository Layout

```text
.
|-- scraper/                  # Slickdeals parser and velocity enrichment
|-- scripts/run_scrape.py      # Scheduled scrape entry point
|-- site/
|   |-- public/app.js          # Browser app and testable helper functions
|   |-- public/data/           # Committed JSON snapshots served by the site
|   |-- scripts/copy-assets.js # Static build asset copy step
|   |-- src/index.html         # App shell
|   `-- src/input.css          # Tailwind source CSS
|-- tests/                     # Python unittest suite
|-- requirements-scraper.txt   # Runtime scraper dependencies
|-- requirements-dev.txt       # Development dependency notes
`-- render.yaml                # Render static-site configuration
```

## Data Files

`site/public/data/history.json` stores the rolling snapshot window used to calculate velocity. `site/public/data/deals.json` stores the latest enriched snapshot consumed by the frontend.

The scheduled scraper commits both files so the static deployment can rebuild from repository state.

## Local Development

Install Python dependencies:

```powershell
python -m pip install -r requirements-dev.txt
```

Install site dependencies:

```powershell
cd site
npm install
```

Build CSS for local static serving:

```powershell
cd site
npm run dev
```

The `dev` script watches `site/src/input.css` and writes `site/public/style.css`, which is intentionally ignored because it is generated.

## Build

```powershell
cd site
npm run build
```

The build writes `site/dist/`, copies `index.html`, `app.js`, and `data/deals.json`, and emits minified Tailwind CSS. `site/dist/` is generated output and should not be committed.

## Run The Scraper

```powershell
python scripts/run_scrape.py
```

This performs one frontpage scrape, appends a new history snapshot, trims the rolling history, computes velocity metrics, and rewrites the JSON data files atomically.

## Tests

Run the Python tests:

```powershell
python -m unittest discover
```

Run the site helper tests:

```powershell
cd site
npm test
```

## Deployment

The included `render.yaml` configures a Render static site:

- Build command: `cd site && npm install && npm run build`
- Publish directory: `site/dist`
- JSON data headers: `Cache-Control: no-cache`

The `.github/workflows/scrape.yml` workflow runs every ten minutes and can also be triggered manually with `workflow_dispatch`.

## Notes For Maintenance

- Keep scraper tests focused on parser behavior and data-shape stability.
- Keep generated files out of source control: `site/dist/`, `site/node_modules/`, `site/public/style.css`, Python caches, and local attachment scratch files are ignored.
- The frontend intentionally reads only `deals.json`; `history.json` is for scraper-side velocity calculations.
