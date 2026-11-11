import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';
import { build } from '../build';
import { storeRun } from '../raw-store';

const root = join(__dirname, '..', '..', 'powerbi');
const modelDir = join(root, 'Quality.SemanticModel', 'definition');
const reportDir = join(root, 'Quality.Report', 'definition');
const fixtures = join(__dirname, 'fixtures');
const work = mkdtempSync(join(tmpdir(), 'pqd-powerbi-'));
const noRepo = mkdtempSync(join(tmpdir(), 'pqd-powerbi-norepo-'));

after(() => {
  rmSync(work, { recursive: true, force: true });
  rmSync(noRepo, { recursive: true, force: true });
});

type TableModel = {
  columns: Set<string>;
  sourceColumns: Set<string>;
  measures: Set<string>;
  dax: string[];
  csvFile: string | null;
  lineageTag: string | null;
  dataCategory: string | null;
  keyColumn: string | null;
};

const namePattern = String.raw`(?:'([^']+)'|([A-Za-z_][A-Za-z0-9_]*))`;

function objectName(line: string, keyword: string): { name: string; rest: string } | null {
  const match = new RegExp(`^\\t${keyword} ${namePattern}(.*)$`).exec(line);
  if (!match) return null;
  return { name: match[1] ?? match[2] ?? '', rest: match[3] ?? '' };
}

function loadModel(): Map<string, TableModel> {
  const tables = new Map<string, TableModel>();
  const dir = join(modelDir, 'tables');
  for (const file of readdirSync(dir)) {
    const tableName = file.replace(/\.tmdl$/, '');
    const lines = readFileSync(join(dir, file), 'utf8').split('\n');
    const table: TableModel = {
      columns: new Set(),
      sourceColumns: new Set(),
      measures: new Set(),
      dax: [],
      csvFile: null,
      lineageTag: null,
      dataCategory: null,
      keyColumn: null,
    };
    let current: 'column' | 'measure' | null = null;
    let calculatedPartition = false;
    for (const line of lines) {
      if (line.startsWith('table ') && table.lineageTag === null) {
        current = null;
      }
      const category = /^\tdataCategory: (.+)$/.exec(line);
      if (category) table.dataCategory = category[1] ?? null;
      const column = objectName(line, 'column');
      if (column) {
        table.columns.add(column.name);
        current = 'column';
        const inline = /^\s*=\s*(.+)$/.exec(column.rest);
        if (inline?.[1]) table.dax.push(inline[1]);
        continue;
      }
      const measure = objectName(line, 'measure');
      if (measure) {
        table.measures.add(measure.name);
        current = 'measure';
        const inline = /^\s*=\s*(.*)$/.exec(measure.rest);
        if (inline?.[1]) table.dax.push(inline[1]);
        continue;
      }
      if (line.startsWith('\tpartition ') && line.includes('= calculated')) {
        calculatedPartition = true;
        current = null;
        continue;
      }
      if (line.startsWith('\tpartition ')) {
        calculatedPartition = false;
        current = null;
        continue;
      }
      const sourceColumn = /^\t\tsourceColumn: (\S+)$/.exec(line);
      if (sourceColumn?.[1] && current === 'column') table.sourceColumns.add(sourceColumn[1]);
      if (/^\t\tisKey$/.test(line) && current === 'column') {
        table.keyColumn = [...table.columns].at(-1) ?? null;
      }
      if (current && line.startsWith('\t\t\t')) table.dax.push(line.trim());
      const csv = /fnLoadCsv\("([^"]+)"\)/.exec(line);
      if (csv?.[1]) table.csvFile = csv[1];
      if (calculatedPartition && line.startsWith('\t\tsource =')) {
        table.dax.push(line.replace(/^\t\tsource =\s*/, ''));
      }
      if (table.lineageTag === null) {
        const tag = /^\tlineageTag: ([0-9a-f-]+)$/.exec(line);
        if (tag?.[1]) table.lineageTag = tag[1];
      }
    }
    tables.set(tableName, table);
  }
  return tables;
}

function references(dax: string): { columns: [string, string][]; measures: string[] } {
  const columns: [string, string][] = [];
  const withoutColumns = dax.replace(
    new RegExp(`${namePattern}\\[([^\\]]+)\\]`, 'g'),
    (full, quoted: string, bare: string, column: string) => {
      columns.push([quoted || bare, column]);
      return full.replace(`[${column}]`, '');
    },
  );
  const measures = [...withoutColumns.matchAll(/\[([^\]]+)\]/g)].map((match) => match[1] ?? '');
  return { columns, measures };
}

describe('Power BI model', () => {
  const tables = loadModel();
  const measures = tables.get('Metrics')?.measures ?? new Set<string>();

  it('loads every star schema CSV with the columns the pipeline writes', async () => {
    const raw = join(work, 'raw');
    storeRun(join(fixtures, 'run-1001'), raw);
    storeRun(join(fixtures, 'run-1002'), raw);
    await build(raw, join(work, 'model'), noRepo);

    const imported = [...tables.values()].filter((table) => table.csvFile);
    assert.ok(imported.length >= 9);
    for (const table of imported) {
      const header = readFileSync(join(work, 'model', 'csv', table.csvFile ?? ''), 'utf8')
        .split('\n')[0]
        ?.split(',');
      assert.deepEqual(
        [...table.sourceColumns].sort(),
        [...(header ?? [])].sort(),
        table.csvFile ?? '',
      );
    }
  });

  it('keeps the date table, single direction relationships and the public GitHub source', () => {
    const date = tables.get('dim_date');
    assert.equal(date?.dataCategory, 'Time');
    assert.equal(date?.keyColumn, 'Date');

    const relationships = readFileSync(join(modelDir, 'relationships.tmdl'), 'utf8');
    const from = [...relationships.matchAll(/^relationship /gm)];
    const directions = [...relationships.matchAll(/crossFilteringBehavior: oneDirection/g)];
    assert.equal(directions.length, from.length);
    assert.equal(from.length, 13);
    assert.equal(relationships.includes('fact_test_result.run_key'), false);

    const expressions = readFileSync(join(modelDir, 'expressions.tmdl'), 'utf8');
    assert.match(
      expressions,
      /https:\/\/raw\.githubusercontent\.com\/JordyRdev\/powerbi-playwright-dashboard\/data\/model\/csv/,
    );
    assert.match(expressions, /"GitHub" meta \[IsParameterQuery=true/);
    assert.match(expressions, /p Local Folder/);
  });

  it('only uses columns and measures that exist', () => {
    const allMeasures = new Set<string>();
    for (const table of tables.values()) {
      for (const name of table.measures) allMeasures.add(name);
    }
    for (const required of [
      'Pass rate',
      'Fail rate',
      'Flaky rate',
      'Flaky test count',
      'Tests',
      'Runs',
      'Average duration (s)',
      'P90 duration (s)',
      'Duration change',
      'Pass rate vs previous release',
      'Failure results',
    ]) {
      assert.ok(measures.has(required), required);
    }

    const pass = tables.get('Metrics')?.dax.join('\n') ?? '';
    assert.match(pass, /\[Passed\] \+ \[Flaky\]/);
    assert.match(pass, /DIVIDE \( \[Flaky\], \[Executed\] \)/);

    for (const table of tables.values()) {
      const used = references(table.dax.join('\n'));
      for (const [tableName, column] of used.columns) {
        assert.ok(tables.get(tableName)?.columns.has(column), `${tableName}[${column}]`);
      }
      for (const measure of used.measures) {
        assert.ok(allMeasures.has(measure), `[${measure}]`);
      }
    }

    const relText = readFileSync(join(modelDir, 'relationships.tmdl'), 'utf8');
    for (const match of relText.matchAll(/^(?:from|to)Column: ([^.]+)\.(.+)$/gm)) {
      const tableName = match[1] ?? '';
      const column = match[2] ?? '';
      assert.ok(tables.get(tableName)?.columns.has(column), `${tableName}.${column}`);
    }
  });

  it('binds every visual to a column or measure in the model', () => {
    const pages = readdirSync(join(reportDir, 'pages')).filter((name) => name !== 'pages.json');
    assert.deepEqual(pages.sort(), ['duration', 'failures', 'flaky', 'overview', 'releases']);
    let visuals = 0;
    for (const page of pages) {
      const visualDir = join(reportDir, 'pages', page, 'visuals');
      for (const visual of readdirSync(visualDir)) {
        visuals += 1;
        const body = JSON.parse(readFileSync(join(visualDir, visual, 'visual.json'), 'utf8'));
        const found: [string, string, 'column' | 'measure'][] = [];
        const walk = (node: unknown): void => {
          if (Array.isArray(node)) {
            for (const item of node) walk(item);
            return;
          }
          if (!node || typeof node !== 'object') return;
          const record = node as {
            Column?: { Expression?: { SourceRef?: { Entity?: string } }; Property?: string };
            Measure?: { Expression?: { SourceRef?: { Entity?: string } }; Property?: string };
          };
          if (record.Column?.Property && record.Column.Expression?.SourceRef?.Entity) {
            found.push([
              record.Column.Expression.SourceRef.Entity,
              record.Column.Property,
              'column',
            ]);
          }
          if (record.Measure?.Property && record.Measure.Expression?.SourceRef?.Entity) {
            found.push([
              record.Measure.Expression.SourceRef.Entity,
              record.Measure.Property,
              'measure',
            ]);
          }
          for (const value of Object.values(record)) walk(value);
        };
        walk(body);
        if (body.visual?.visualType === 'textbox') {
          assert.equal(found.length, 0, visual);
          continue;
        }
        assert.ok(found.length > 0, visual);
        for (const [entity, property, kind] of found) {
          const table = tables.get(entity);
          assert.ok(table, entity);
          if (kind === 'column') assert.ok(table.columns.has(property), `${entity}[${property}]`);
          else assert.ok(table.measures.has(property), `${entity}[${property}]`);
        }
      }
    }
    assert.ok(visuals >= 70);

    const layout = JSON.parse(
      readFileSync(join(root, 'Quality.SemanticModel', 'diagramLayout.json'), 'utf8'),
    ) as { diagrams: { nodes: { nodeIndex: string; nodeLineageTag: string }[] }[] };
    for (const node of layout.diagrams[0]?.nodes ?? []) {
      assert.equal(tables.get(node.nodeIndex)?.lineageTag, node.nodeLineageTag);
    }
  });
});
