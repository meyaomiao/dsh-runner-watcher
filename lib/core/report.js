/**
 * Dashboard rendering.
 *
 * The template is plain HTML + vanilla JS (no framework, no bundler) so the
 * generated file opens directly from disk, and so the repository stays
 * reviewable. The payload is inlined as a JSON literal.
 * @module dsh-runner-watcher/core/report
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { briefJobs } from './analyze.js';
import { toIso } from './util.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const TEMPLATE_PATH = path.join(HERE, '..', 'dashboard.html.tpl');

/** Assemble the dashboard payload from a snapshot + analysis. */
export function buildPayload({
  snapshot,
  stats,
  jobs,
  registry,
  hours,
  rollingWindow,
  dataDir,
  liveIntervalSec = 0,
  generated = new Date(),
}) {
  return {
    generated: toIso(generated),
    hours,
    dataDir,
    liveIntervalSec: Number(liveIntervalSec ?? 0),
    snap: snapshot,
    stats,
    rps: stats?.rps ?? null,
    score_model: stats?.score_model ?? null,
    registry: {
      runners: (registry?.runners ?? []).map((r) => ({
        id: r.id,
        label: r.label,
        transport: r.transport,
        identity: r.identity ?? {},
        enabled: r.enabled !== false,
        addedBy: r.addedBy ?? null,
        addedAt: r.addedAt ?? null,
        lastSeenAt: r.lastSeenAt ?? null,
        state: r.state ?? null,
      })),
      pending: registry?.pending ?? [],
    },
    jobs: briefJobs((jobs ?? []).slice(0, 400)),
    job_names: stats?.by_job_name ?? [],
    hourly: stats?.hourly ?? [],
    score_series: stats?.score_series ?? [],
    score_by_runner: stats?.score_by_runner ?? {},
  };
}

/** Render the dashboard HTML. */
export async function renderDashboard(options, { templatePath = TEMPLATE_PATH } = {}) {
  const tpl = await fs.readFile(templatePath, 'utf8');
  const payload = buildPayload(options);
  const refreshMeta = options.refreshSeconds > 0
    ? `<meta http-equiv="refresh" content="${Number(options.refreshSeconds)}"/>`
    : '';
  // `<` is escaped so a job name containing markup cannot close the script tag.
  const blob = JSON.stringify(payload).replace(/</g, '\\u003c');
  return tpl.replace('__REFRESH_META__', refreshMeta).replace('__PAYLOAD__', blob);
}

/** Render and write the dashboard; returns the file path. */
export async function writeDashboard(options, { outFile, templatePath } = {}) {
  const html = await renderDashboard(options, { templatePath });
  const target = outFile ?? path.join(options.dataDir, 'dashboard.html');
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, html, 'utf8');
  return target;
}
