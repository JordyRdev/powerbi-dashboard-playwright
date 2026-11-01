# Data model

Every CI run on `main` adds its results to a star schema. The pipeline lives in
`pipeline/` and the output is published on the [`data` branch](https://github.com/JordyRdev/powerbi-dashboard-playwright/tree/data).

## Flow

```mermaid
flowchart LR
  A[raw-results artifact<br/>playwright-results.json<br/>junit.xml, run-meta.json] -->|ingest.ts| B[raw/run_id/<br/>on the data branch]
  B -->|load.ts| C[staging NDJSON<br/>stg_runs, stg_results]
  G[Git tags and commits] --> C
  C -->|01_staging.sql| D[(DuckDB)]
  D -->|02_dims.sql<br/>03_facts.sql| E[star schema]
  E -->|99_checks.sql| F{checks pass?}
  F -->|yes| P[model/*.parquet<br/>model/csv/*.csv]
  F -->|no| X[build fails,<br/>nothing written]
```

1. **Ingest** (`pipeline/ingest.ts`) copies a run's `raw-results` into `raw/<run_id>/`
   (JSON and JUnit gzipped). Storing the same run again replaces its folder, and a re-run
   attempt replaces the earlier attempt.
2. **Load** (`pipeline/load.ts`) validates the files with Zod and flattens Playwright's
   nested JSON into one row per test, project and run.
3. **Build** (`pipeline/build.ts`) runs the SQL in DuckDB, runs the data quality checks
   and only then writes Parquet and CSV. The whole model is rebuilt from the raw archive
   every time, so the result depends only on which runs are in it.

**Idempotent:** ingesting a run twice gives byte-identical Parquet and CSV files. This is
covered by `npm run test:pipeline`.

## Star schema

```mermaid
erDiagram
  fact_test_result }o--|| fact_run : "run_key"
  fact_test_result }o--|| dim_test : "test_key"
  fact_test_result }o--|| dim_project : "project_key"
  fact_test_result }o--|| dim_environment : "environment_key"
  fact_test_result }o--|| dim_release : "release_key"
  fact_test_result }o--|| dim_commit : "commit_key"
  fact_test_result }o--|| dim_date : "date_key"
  fact_test_result }o--|| dim_failure_category : "failure_key"
  fact_run }o--|| dim_release : "release_key"
  fact_run }o--|| dim_commit : "commit_key"
  fact_run }o--|| dim_environment : "environment_key"
  fact_run }o--|| dim_date : "date_key"

  fact_test_result {
    bigint run_key FK
    varchar test_key FK
    varchar project_key FK
    varchar environment_key FK
    varchar release_key FK
    varchar commit_key FK
    int date_key FK
    varchar failure_key FK
    varchar status "passed, failed, flaky, skipped"
    boolean is_flaky
    int retries
    int attempt_count
    bigint duration_ms "final attempt"
    bigint total_duration_ms "all attempts"
    timestamptz started_at
  }
  fact_run {
    bigint run_key PK "GitHub run id"
    varchar trigger "push, schedule, manual"
    int shard_count
    bigint wall_clock_ms
    varchar run_url
    int tests
    int passed
    int failed
    int flaky
    int skipped
  }
  dim_test {
    varchar test_key PK "hash of file + title path"
    varchar title
    varchar title_path
    varchar file
    varchar suite
    varchar test_type "ui, api, visual, demo"
    varchar tags
    boolean is_smoke
    boolean is_demo
    date first_seen
    date last_seen
  }
  dim_project {
    varchar project_key PK
    varchar browser
    varchar device
    varchar layer
  }
  dim_environment {
    varchar environment_key PK
    varchar container_image
    varchar playwright_version
    varchar os
  }
  dim_release {
    varchar release_key PK "Git tag or untagged"
    varchar git_tag
    date release_date
    int release_order
  }
  dim_commit {
    varchar commit_key PK "full SHA"
    varchar short_sha
    timestamptz committed_at
    varchar release_key
  }
  dim_date {
    int date_key PK "yyyymmdd"
    date date
    int iso_year_week
    varchar weekday_name
    boolean is_weekend
  }
  dim_failure_category {
    varchar failure_key PK
    varchar category
    varchar normalized_message
    varchar example_message
  }
```

The diagram shows the main columns; the CSV headers list all of them.

## Grain and keys

| Table                  | Grain                                                                                | Key                              |
| ---------------------- | ------------------------------------------------------------------------------------ | -------------------------------- |
| `fact_test_result`     | One test, on one Playwright project, in one CI run (final result after retries)      | `run_key, test_key, project_key` |
| `fact_run`             | One CI run (the latest attempt if it was re-run)                                     | `run_key`                        |
| `dim_test`             | One test. Title and tags come from the latest run that saw it                        | `test_key`                       |
| `dim_project`          | One Playwright project (api, chromium, firefox, webkit, mobile-chrome, visual, demo) | `project_key`                    |
| `dim_environment`      | One combination of container image and Playwright version                            | `environment_key`                |
| `dim_release`          | One Git tag, plus `untagged` for commits before the first tag                        | `release_key`                    |
| `dim_commit`           | One tested commit                                                                    | `commit_key`                     |
| `dim_date`             | One day (UTC), without gaps between the first and last run                           | `date_key`                       |
| `dim_failure_category` | One category plus normalized message, plus `none` for passing results                | `failure_key`                    |

Keys are natural values or short hashes of them, so they stay the same on every rebuild.

**Releases** come from Git, not from the run: a run belongs to the latest tag reachable
from the commit it tested. Tagging `v1.1` later therefore labels all runs on commits
after `v1.0` correctly, including runs that were stored before the tag existed.

## Definitions

- **Status** is Playwright's final outcome: `expected` → `passed` (or `skipped`),
  `unexpected` → `failed`, `flaky` stays `flaky` (failed first, passed on a retry).
- **Pass rate** = `(passed + flaky) / (passed + flaky + failed)`. Skipped results do not
  count. A flaky test passed in the end, so it counts as passed; the flaky rate shows it
  separately.
- **Flaky rate** = `flaky / (passed + flaky + failed)`.
- **Duration** is the final attempt (`duration_ms`); `total_duration_ms` includes retries,
  which is what the run actually spent.
- **Failure category** is decided by the first matching rule on the error message:
  visual diff → network → locator → timeout → assertion → other. For a failed test the
  last attempt's error is used, for a flaky test the first failing attempt's.
  `normalized_message` replaces numbers and quoted values so equal problems group together.
- **Dates** are UTC.

## Data quality checks

`pipeline/sql/99_checks.sql` runs after every build. If any check finds a problem the
build stops and nothing is written, so the data branch never gets a broken model.

- The fact grain is unique, and every run has exactly one `fact_run` row.
- Every run has at least one result.
- Durations are not negative.
- `status` is a known value and `is_flaky` matches it.
- Failed and flaky results have a failure category.
- Run totals add up, and match Playwright's own summary.
- The JUnit testcase count matches the JSON results.
- No orphan keys: every foreign key exists in its dimension.
- Every dimension key is unique.

## Files on the data branch

| Path                  | Contents                                                      |
| --------------------- | ------------------------------------------------------------- |
| `raw/<run_id>/`       | `run-meta.json`, `playwright-results.json.gz`, `junit.xml.gz` |
| `model/*.parquet`     | The nine tables above (zstd compressed)                       |
| `model/csv/*.csv`     | The same tables as CSV                                        |
| `model/manifest.json` | Build time, number of runs, row counts and check results      |

The data branch always holds a single commit. The raw archive inside it is the history,
and the model is rebuilt from it on every run, so the branch does not grow with every
version of the Parquet files.

Power BI reads the CSV files over HTTPS (the same tables are also stored as Parquet), for example
`https://raw.githubusercontent.com/JordyRdev/powerbi-dashboard-playwright/data/model/csv/fact_test_result.csv`.
The project, the measures and the numbers to check are in [power-bi.md](power-bi.md).

## Running it locally

```bash
# store one or more downloaded raw-results folders
npm run data:ingest -- --raw .data/raw path/to/raw-results
# rebuild the model
npm run data:build -- --raw .data/raw --out .data/model
# or build the same snapshot as CI, without pushing
PUSH=false bash scripts/publish-data.sh path/to/raw-results
```

## Backfill

_Actions → Backfill dataset → Run workflow_ downloads the `raw-results` artifact of
recent CI runs on `main` (artifacts are kept for 90 days) and adds them to the data
branch. It is safe to run more than once.
