/**
 * dsh-runner-scope — DSH (DeepSeek Harness) plugin entry.
 *
 * Hosts self-hosted GitHub Actions runner observability inside DSH:
 *
 *   tools       — runner_scope_* tools the agent can call directly
 *   webServer   — a dashboard served at /dsh-runner-scope (optional service)
 *
 * The plugin owns no state of its own: it opens a session over the configured
 * data directory per call, so the CLI, the dashboard and the agent always see
 * the same registry and the same job store.
 * @module dsh-runner-scope
 */

import fs from 'node:fs/promises';
import { resolveDataDir } from './core/paths.js';
import { DEFAULT_SETTINGS, openSession } from './core/session.js';
import { filterWindow } from './core/store.js';
import { formatBytes, formatDuration, gradeOf } from './core/util.js';

export const name = 'dsh-runner-scope';

/** `tools` is required; the dashboard attaches only where a web server exists. */
export const inject = ['tools'];

export const DASHBOARD_PATH = '/dsh-runner-scope';

/** Tool output contract: a plain string with a presentation title. */
function stringOutput(title) {
  return {
    schema: { type: 'string' },
    render: (_args, value) => [{ type: 'text', text: String(value) }],
    presentationMeta: () => ({ title }),
  };
}

function fmtRunnerLine(r) {
  const id = r.identity ?? {};
  const suffix = r.error ? `  error=${r.error}` : '';
  return `- ${r.label}  [${r.state}]  ${r.source}${suffix}\n    repo=${id.githubUrl ?? '-'}  agent=${id.agentName ?? '-'}#${id.agentId ?? '-'}  pool=${id.poolName ?? '-'}`;
}

function fmtRunnerHealth(r) {
  const lines = [
    `- ${r.label}  [${r.state}]`,
    `    dir      ${r.install_dir}`,
    `    unit     ${r.unit ?? '-'}  ${r.unit_state ?? '-'}/${r.unit_enabled ?? '-'}  restarts=${r.n_restarts ?? 0}`,
    `    memory   current=${formatBytes(r.memory_current_bytes)}  peak=${formatBytes(r.memory_peak_bytes)}`,
    `    cpu      ${((r.cpu_usage_sec ?? 0) / 60).toFixed(1)} min total`,
    `    process  rss=${formatBytes(r.process_rss_bytes)}  listener=${r.listener_running ? 'up' : 'down'}  worker=${r.worker_running ? 'up' : 'down'}`,
    `    disk     _work=${formatBytes(r.work_bytes)}`,
    `    job      ${r.current_job ? `${r.current_job.name} (since ${r.current_job.started})` : 'idle'}`,
  ];
  if (r.error) lines.push(`    error    ${r.error}`);
  return lines.join('\n');
}

function fmtRpsLine(label, rps) {
  if (!rps) return `${label}: no data`;
  return `${label}: RPS ${rps.score ?? '-'} (${rps.grade ?? gradeOf(rps.score)})  reliability=${rps.reliability ?? '-'}  speed=${rps.speed ?? '-'}  efficiency=${rps.efficiency ?? '-'}  stability=${rps.stability ?? '-'}  done=${rps.n}`;
}

function fmtAnalysis(stats) {
  const lines = [
    `window=${stats.windowHours}h  jobs=${stats.completed}  success=${stats.success}  failed=${stats.failed}  success_rate=${(stats.success_rate * 100).toFixed(1)}%`,
    `duration p50=${formatDuration(stats.duration_p50)} p95=${formatDuration(stats.duration_p95)}  workload_avg=${stats.difficulty_avg}`,
    fmtRpsLine('overall', stats.rps),
    '',
    'per runner:',
  ];
  for (const [runnerName, group] of Object.entries(stats.by_runner ?? {})) {
    lines.push(
      `  ${runnerName}: RPS ${group.rps ?? '-'} (${group.grade ?? '-'})  jobs=${group.count}  success=${(group.success_rate * 100).toFixed(1)}%  p50=${formatDuration(group.duration_p50)}`,
    );
  }
  if (stats.by_job_name?.length) {
    lines.push('', 'per job (top):');
    for (const group of stats.by_job_name.slice(0, 10)) {
      lines.push(
        `  ${group.name}: RPS ${group.rps ?? '-'} (${group.grade ?? '-'})  jobs=${group.count}  success=${(group.success_rate * 100).toFixed(1)}%  p50=${formatDuration(group.duration_p50)}`,
      );
    }
  }
  if (stats.weakest?.length) {
    lines.push('', 'weakest jobs (lowest job_score):');
    for (const job of stats.weakest.slice(0, 5)) {
      lines.push(
        `  ${job.started}  ${job.runner}  ${job.name}  ${job.result}  score=${job.job_score}  dur=${formatDuration(job.duration_sec)}`,
      );
    }
  }
  return lines.join('\n');
}

export function apply(ctx, config = {}) {
  const dataDir = resolveDataDir(config);
  const settings = {
    windowHours: Number(config.windowHours ?? DEFAULT_SETTINGS.windowHours),
    rollingWindow: Number(config.rollingWindow ?? DEFAULT_SETTINGS.rollingWindow),
    autoDiscover: config.autoDiscover ?? DEFAULT_SETTINGS.autoDiscover,
    autoAdopt: config.autoAdopt ?? DEFAULT_SETTINGS.autoAdopt,
    refreshSeconds: Number(config.refreshSeconds ?? DEFAULT_SETTINGS.refreshSeconds),
  };
  const session = () => openSession({ dataDir, settings });

  ctx.logger?.info?.(`[runner-scope] data directory: ${dataDir}`);

  ctx.tools.register({
    name: 'runner_scope_status',
    description:
      'Live status of every registered self-hosted GitHub Actions runner: state, cgroup memory/CPU, processes, _work size and the job currently running.',
    parameters: {
      type: 'object',
      properties: {
        verbose: { type: 'boolean', description: 'Include per-runner resource details (default true)' },
      },
      additionalProperties: false,
    },
    output: stringOutput('Runner Scope status'),
    execute: async (args) => {
      const s = await session();
      const status = await s.liveStatus();
      if (!status.runners.length) {
        return `No runners registered yet (data dir: ${dataDir}).\nImport one with runner_scope_add, or call runner_scope_discover to find them automatically.`;
      }
      const verbose = args?.verbose !== false;
      const header = `host=${status.host?.hostname ?? '-'}  cpus=${status.host?.cpus ?? '-'}  runners=${status.runners.length}  ts=${status.ts}`;
      const body = status.runners.map((r) => (verbose ? fmtRunnerHealth(r) : fmtRunnerLine(r)));
      return [header, '', ...body].join('\n');
    },
  });

  ctx.tools.register({
    name: 'runner_scope_list',
    description:
      'List the runner registry: which runners are registered, how each was added (manual/linked/adopted), and which discovered candidates are still pending.',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    output: stringOutput('Runner Scope registry'),
    execute: async () => {
      const s = await session();
      const runners = s.listRunners();
      const pending = s.registry.pending ?? [];
      const lines = [`data dir: ${dataDir}`, `registered: ${runners.length}  pending: ${pending.length}`];
      if (runners.length) {
        lines.push('', 'registered:');
        for (const r of runners) {
          const transport = r.transport ?? {};
          const where =
            transport.kind === 'wsl'
              ? `wsl:${transport.distro}`
              : transport.kind === 'ssh'
                ? `ssh:${transport.user ? `${transport.user}@` : ''}${transport.host}`
                : 'local';
          lines.push(
            `- ${r.id}  ${r.label}  [${where}] ${transport.path}  addedBy=${r.addedBy ?? '-'}  state=${r.state ?? '-'}  agent=${r.identity?.agentName ?? '-'}#${r.identity?.agentId ?? '-'}`,
          );
        }
      }
      if (pending.length) {
        lines.push('', 'pending (discovered, not yet registered):');
        for (const p of pending) {
          lines.push(`- ${p.id}  ${p.label ?? '-'}  ${p.path}  via=${p.via ?? '-'}  agent=${p.identity?.agentName ?? '-'}#${p.identity?.agentId ?? '-'}`);
        }
        lines.push('', 'Register them with runner_scope_adopt (all, or an id list).');
      }
      return lines.join('\n');
    },
  });

  ctx.tools.register({
    name: 'runner_scope_add',
    description:
      'Import one self-hosted runner into the registry by hand. Give the install directory (the folder containing .runner), reachable as local, WSL or SSH.',
    parameters: {
      type: 'object',
      properties: {
        kind: { type: 'string', enum: ['local', 'wsl', 'ssh'], description: 'How to reach the host' },
        path: { type: 'string', description: 'Runner install directory, e.g. /opt/actions-runner' },
        distro: { type: 'string', description: 'WSL distribution name (kind=wsl)' },
        host: { type: 'string', description: 'SSH host (kind=ssh)' },
        user: { type: 'string', description: 'SSH user (kind=ssh)' },
        port: { type: 'number', description: 'SSH port (kind=ssh)' },
        label: { type: 'string', description: 'Display name; defaults to the runner agent name' },
      },
      required: ['kind', 'path'],
      additionalProperties: false,
    },
    output: stringOutput('Runner Scope add'),
    execute: async (args) => {
      const s = await session();
      const transport = { kind: args.kind, path: args.path };
      if (args.distro) transport.distro = args.distro;
      if (args.host) transport.host = args.host;
      if (args.user) transport.user = args.user;
      if (args.port) transport.port = args.port;
      const { runner, created } = await s.addRunner({ transport, label: args.label });
      const id = runner.identity ?? {};
      return [
        created ? `Registered ${runner.id}` : `Updated ${runner.id} (same GitHub agent was already registered)`,
        `  label    ${runner.label}`,
        `  source   ${runner.transport.kind}:${runner.transport.distro ?? runner.transport.host ?? ''}${runner.transport.path}`,
        `  repo     ${id.githubUrl ?? '-'}`,
        `  agent    ${id.agentName ?? '-'}#${id.agentId ?? '-'}`,
        '',
        'Run runner_scope_collect to ingest its job history.',
      ].join('\n');
    },
  });

  ctx.tools.register({
    name: 'runner_scope_remove',
    description: 'Remove a runner from the registry by id, label, agent name or install path. Collected job history is kept.',
    parameters: {
      type: 'object',
      properties: { selector: { type: 'string', description: 'Runner id, label, agent name or install path' } },
      required: ['selector'],
      additionalProperties: false,
    },
    output: stringOutput('Runner Scope remove'),
    execute: async (args) => {
      const s = await session();
      const removed = await s.removeRunner(String(args.selector));
      if (!removed) return `No registered runner matches "${args.selector}".`;
      return `Removed ${removed.id} (${removed.label}). Stored job history was kept.`;
    },
  });

  ctx.tools.register({
    name: 'runner_scope_discover',
    description:
      'Scan hosts for runner installs and associate them with the registry. Matching is by GitHub agent identity, so an already-registered runner is updated in place instead of duplicated.',
    parameters: {
      type: 'object',
      properties: {
        transports: {
          type: 'array',
          items: { type: 'string' },
          description: 'Hosts to scan, e.g. "local", "wsl:Ubuntu", "ssh:ci@build-01". Default: this machine, every WSL distro and every host already in the registry.',
        },
        adopt: { type: 'boolean', description: 'Register found runners immediately (default: park them as pending)' },
        extraPaths: {
          type: 'array',
          items: { type: 'string' },
          description: 'Additional install directories to probe on every scanned host',
        },
      },
      additionalProperties: false,
    },
    output: stringOutput('Runner Scope discover'),
    execute: async (args) => {
      const s = await session();
      const result = await s.discover({
        transports: args?.transports,
        adopt: args?.adopt,
        extraPaths: args?.extraPaths ?? [],
      });
      const a = result.association;
      const lines = [
        `scanned hosts: ${(args?.transports?.length ? args.transports : ['(default sweep)']).join(', ')}`,
        `candidates: ${result.candidates.length}  linked=${a.linked.length}  adopted=${a.adopted.length}  pending=${a.pending.length}  missing=${a.missing.length}`,
      ];
      if (result.candidates.length) {
        lines.push('', 'found:');
        for (const c of result.candidates) {
          lines.push(
            `- ${c.identity?.agentName ?? '-'}#${c.identity?.agentId ?? '-'}  ${c.path}  via=${c.via}  repo=${c.identity?.githubUrl ?? '-'}`,
          );
        }
      }
      for (const link of a.linked) {
        lines.push(`linked  ${link.runner.label}${link.moved ? ' (install dir changed)' : ''}`);
      }
      for (const runner of a.adopted) lines.push(`adopted ${runner.label}`);
      for (const runner of a.missing) lines.push(`missing ${runner.label} (not seen this pass; kept in the registry)`);
      for (const conflict of a.conflicts) {
        lines.push(`WARNING duplicate agent ${conflict.key}: ${conflict.ids.join(', ')} — remove one with runner_scope_remove`);
      }
      for (const error of result.errors) lines.push(`error   ${error.transport}: ${error.message}`);
      if (a.pending.length && !result.adopted) {
        lines.push('', 'Call runner_scope_adopt to register the pending candidates.');
      }
      return lines.join('\n');
    },
  });

  ctx.tools.register({
    name: 'runner_scope_adopt',
    description: 'Register pending runners found by runner_scope_discover. Pass ids/labels to choose, or omit to adopt all.',
    parameters: {
      type: 'object',
      properties: {
        selectors: { type: 'array', items: { type: 'string' }, description: 'Pending ids, labels or paths; omit for all' },
      },
      additionalProperties: false,
    },
    output: stringOutput('Runner Scope adopt'),
    execute: async (args) => {
      const s = await session();
      const adopted = await s.adoptPending(args?.selectors ?? []);
      if (!adopted.length) return 'Nothing pending matches; run runner_scope_discover first.';
      return ['adopted:', ...adopted.map((r) => `- ${r.id}  ${r.label}  ${r.transport.path}`), '', 'Run runner_scope_collect to ingest job history.'].join('\n');
    },
  });

  ctx.tools.register({
    name: 'runner_scope_collect',
    description:
      'Collect a fresh snapshot of every registered runner and ingest the jobs found in their _diag logs, then report the analysis for the window.',
    parameters: {
      type: 'object',
      properties: {
        hours: { type: 'number', description: 'Analysis window in hours (default from config)' },
        autoDiscover: { type: 'boolean', description: 'Run discovery first (default from config)' },
        writeDashboard: { type: 'boolean', description: 'Also refresh dashboard.html (default false)' },
      },
      additionalProperties: false,
    },
    output: stringOutput('Runner Scope collect'),
    execute: async (args) => {
      const s = await session();
      const result = await s.collect({
        hours: args?.hours,
        autoDiscover: args?.autoDiscover,
        writeDashboardFile: args?.writeDashboard === true,
      });
      const lines = [
        `collected ${result.snapshot.collected} jobs from ${result.snapshot.runners.length} runner(s); store now holds ${result.stored.length}`,
      ];
      for (const runner of result.snapshot.runners) {
        lines.push(`  ${runner.label}: ${runner.state}${runner.error ? ` (${runner.error})` : ''}`);
      }
      lines.push('', fmtAnalysis(result.stats));
      if (result.dashboard) lines.push('', `dashboard: ${result.dashboard}`);
      return lines.join('\n');
    },
  });

  ctx.tools.register({
    name: 'runner_scope_analyze',
    description:
      'Analyse stored job history without collecting: RPS (reliability/speed/efficiency/stability), per-runner and per-job-name breakdown, slowest and hardest jobs.',
    parameters: {
      type: 'object',
      properties: { hours: { type: 'number', description: 'Window in hours (default from config)' } },
      additionalProperties: false,
    },
    output: stringOutput('Runner Scope analysis'),
    execute: async (args) => {
      const s = await session();
      const stats = await s.analyze({ hours: args?.hours });
      if (!stats.completed) {
        return `No completed jobs in the last ${stats.windowHours}h. Run runner_scope_collect first.`;
      }
      return fmtAnalysis(stats);
    },
  });

  ctx.tools.register({
    name: 'runner_scope_dashboard',
    description: 'Render the standalone HTML dashboard (interactive RPS trend, registry table, job tables) and return its path.',
    parameters: {
      type: 'object',
      properties: {
        hours: { type: 'number', description: 'Window in hours' },
        outFile: { type: 'string', description: 'Output path; defaults to <dataDir>/dashboard.html' },
        refreshSeconds: { type: 'number', description: 'Auto-refresh interval; 0 disables' },
      },
      additionalProperties: false,
    },
    output: stringOutput('Runner Scope dashboard'),
    execute: async (args) => {
      const s = await session();
      const file = await s.dashboard({
        hours: args?.hours,
        outFile: args?.outFile,
        refreshSeconds: args?.refreshSeconds,
      });
      return `dashboard written to ${file}\nserved at ${DASHBOARD_PATH} while DSH web is running`;
    },
  });

  // The dashboard needs a web server; headless profiles simply skip it.
  ctx.inject(['webServer'], (wctx) => {
    const handler = async (req, res) => {
      try {
        const url = new URL(req.url ?? '/', 'http://localhost');
        const route = url.pathname.slice(DASHBOARD_PATH.length).replace(/^\/+/, '');
        const s = await session();
        if (route.startsWith('api/')) {
          const hours = Number(url.searchParams.get('hours') ?? settings.windowHours);
          let body;
          if (route === 'api/status') body = await s.liveStatus();
          else if (route === 'api/analyze') body = await s.analyze({ hours });
          else if (route === 'api/registry') body = { runners: s.listRunners(), pending: s.registry.pending ?? [] };
          else if (route === 'api/jobs') body = { jobs: filterWindow(await s.jobs({ hours }), hours) };
          else {
            res.writeHead(404, { 'content-type': 'application/json; charset=utf-8' });
            res.end('{"error":"unknown route"}');
            return;
          }
          const text = JSON.stringify(body);
          res.writeHead(200, {
            'content-type': 'application/json; charset=utf-8',
            'cache-control': 'no-store',
          });
          res.end(text);
          return;
        }
        // The HTML view renders from the stored state, so a dashboard request
        // never triggers a runner sweep.
        const file = await s.dashboard({ hours: settings.windowHours, refreshSeconds: settings.refreshSeconds });
        const html = await fs.readFile(file, 'utf8');
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
        res.end(html);
      } catch (error) {
        res.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' });
        res.end(`runner-scope dashboard error: ${String(error?.message ?? error)}`);
      }
    };
    wctx.effect(
      () => wctx.webServer.register({ kind: 'prefix', path: DASHBOARD_PATH, handler }),
      'runner-scope: dashboard route',
    );
    ctx.logger?.info?.(`[runner-scope] dashboard at ${DASHBOARD_PATH}`);
  });
}

export default { name, inject, apply };
