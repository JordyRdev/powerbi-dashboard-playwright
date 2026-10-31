# Quality data (`data` branch)

This branch is written by CI. Do not edit it by hand.

It holds the test results of every CI run on `main` and the star schema built from
them. The code that builds it lives on `main` in `pipeline/`; the model is described
in `docs/data-model.md` there.

| Path                  | Contents                                                               |
| --------------------- | ---------------------------------------------------------------------- |
| `raw/<run_id>/`       | Raw results of one run: Playwright JSON and JUnit (gzip), run metadata |
| `model/*.parquet`     | Star schema for Power BI                                               |
| `model/csv/*.csv`     | The same tables as CSV                                                 |
| `model/manifest.json` | Build time, row counts and the data quality checks                     |

The branch always has a single commit: each CI run rebuilds the model from all raw
runs and replaces the snapshot.

Power BI reads the Parquet files with the Web connector, for example:

```text
https://raw.githubusercontent.com/JordyR1986/powerbi-dashboard-playwright/data/model/fact_test_result.parquet
```
