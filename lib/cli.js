#!/usr/bin/env node
/**
 * dsh-runner-scope CLI.
 *
 * The same engine the DSH plugin exposes as tools, usable without DSH — handy
 * for cron, for a first look, and for troubleshooting a runner that the agent
 * cannot see.
 *
 *   dsh-runner-scope status
 *   dsh-runner-scope add --kind wsl --distro Ubuntu --path /opt/actions-runner
 *   dsh-runner-scope discover --transport wsl:Ubuntu --adopt
 *   dsh-runner-scope collect
 *   dsh-runner-scope analyze --hours 168
 *   dsh-runner-scope dashboard --open
 *   dsh-runner-scope serve --port 8790
 * @module dsh-runner-scope/cli
 */

import http from 'node:http';
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { resolveDataDir } from './core/paths.js';
import { openSession, parseTransportSpec } from './core/session.js';
import { formatBytes, formatDuration } from './core/util.js';

const USAGE = `dsh-runner-scope — self-hosted GitHub Actions runner observability

Usage: dsh-runner-scope <command> [options]

Commands
  status                     Live state of every registered runner
  list                       Show the registry (registered + pending)
  add                        Import one runner by hand
  remove <selector>          Drop a runner from the registry
  discover                   Scan hosts and associate what it finds
  adopt [selector...]        Register pending runners
  collect                    Snapshot runners + ingest jobs + analyze
  analyze                    Analyze stored jobs (no collection)
  dashboard                  Render the HTML dashboard
  serve                      Serve the dashboard over HTTP

Common options
  --data-dir <dir>           State directory (default: <dsh home>/runner-scope)
  --hours <n>                Analysis window in hours (default 168)
  --json                     Emit JSON instead of text
  -h, --help                 Show this help

discover options
  --transport <spec>         Host to scan, repeatable: local | wsl:Ubuntu | ssh:user@host
  --extra-path <dir>         Extra install dir to probe, repeatable
  --adopt                    Register what is found instead of parking it as pending

add options
  --kind <local|wsl|ssh>     How to reach the host (default local)
  --path <dir>               Runner install directory (required)
  --distro <name>            WSL distribution (kind=wsl)
  --host <host>              SSH host (kind=ssh)
  --user <user>              SSH user
  --port <n>                 SSH port
  --label <name>             Display name

collect options
  --no-discover              Skip the discovery pass
  --write-dashboard          Refresh dashboard.html as part of the run

dashboard options
  --out <file>               Output path (default <data-dir>/dashboard.html)
  --refresh <seconds>        Auto-refresh interval (0 = off)
  --open                     Open it in the default browser

serve options
  --port <n>                 Listen port (default 8790)
  --host <addr>              Listen address (default 127.0.0.1)
`;

function parseArgs(argv) {
  const flags = { _: [], transport: [], 'extra-path': [], selectors: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg.startsWith('-')) {
      flags._.push(arg);
      continue;
    }
    const [key, inline] = arg.replace(/^--?/, '').split(/=(.*)/s);
    const value = inline !== undefined ? inline : argv[i + 1];
    switch (key) {
      case 'transport':
      case 'extra-path':
        flags[key].push(value);
        if (inline === undefined) i += 1;
        break;
      case 'json':
      case 'adopt':
      case 'open':
      case 'write-dashboard':
      case 'no-discover':
        flags[key] = true;
        break;
      case 'h':
      case 'help':
        flags.help = true;
        break;
      default:
        flags[key] = value;
        if (inline === undefined) i += 1;
        break;
    }
  }
  return flags;
}

function openInBrowser(target) {
  const cmd =
    process.platform === 'win32' ? 'cmd' : process.platform === 'darwin' ? 'open' : 'xdg-open';
  const args = process.platform === 'win32' ? ['/c', 'start', '', target] : [target];
  try {
    spawn(cmd, args, { detached: true, stdio: 'ignore', windowsHide: true }).unref();
  } catch {
    /* opening a browser is best-effort */
  }
}

function printRunnerHealth(runner) {
  const id = runner.identity ?? {};
  const lines = [
    `${runner.label}  [${runner.state}]`,
    `  source       ${runner.source}`,
    `  repo         ${id.githubUrl ?? '-'}`,
    `  agent        ${id.agentName ?? '-'} #${id.agentId ?? '-'}  pool=${id.poolName ?? '-'}`,
    `  unit         ${runner.unit ?? '-'}  ${runner.unit_state ?? '-'}/${runner.unit_enabled ?? '-'}  restarts=${runner.n_restarts ?? 0}`,
    `  memory       current ${formatBytes(runner.memory_current_bytes)} / peak ${formatBytes(runner.memory_peak_bytes)}`,
    `  cpu          ${((runner.cpu_usage_sec ?? 0) / 60).toFixed(1)} min  rss ${formatBytes(runner.process_rss_bytes)}`,
    `  disk (_work) ${formatBytes(runner.work_bytes)}`,
    `  processes    listener=${runner.listener_running ? 'up' : 'down'} worker=${runner.worker_running ? 'up' : 'down'}`,
    `  current job  ${runner.current_job ? `${runner.current_job.name} (since ${runner.current_job.started})` : 'idle'}`,
  ];
  if (runner.error) lines.push(`  error        ${runner.error}`);
  return lines.join('\n');
}

function printAnalysis(stats) {
  const pct = (v) => `${(Number(v ?? 0) * 100).toFixed(1)}%`;
  const lines = [
    `=== analysis (window ${stats.windowHours}h) ===`,
    `jobs=${stats.completed}  success=${stats.success}  failed=${stats.failed}  rate=${pct(stats.success_rate)}`,
    `duration p50=${formatDuration(stats.duration_p50)}  p95=${formatDuration(stats.duration_p95)}  max=${formatDuration(stats.duration_max)}`,
    `workload avg=${stats.difficulty_avg} (not part of RPS)`,
    `RPS ${stats.rps?.score ?? '-'} (${stats.rps?.grade ?? '-'})  reliability=${stats.rps?.reliability ?? '-'}  speed=${stats.rps?.speed ?? '-'}  efficiency=${stats.rps?.efficiency ?? '-'}  stability=${stats.rps?.stability ?? '-'}`,
    '',
    'per runner:',
  ];
  for (const [name, g] of Object.entries(stats.by_runner ?? {})) {
    lines.push(
      `  ${name.padEnd(28)} RPS ${String(g.rps ?? '-').padStart(5)} (${g.grade ?? '-'})  jobs=${String(g.count).padStart(3)}  rate=${pct(g.success_rate).padStart(6)}  p50=${formatDuration(g.duration_p50)}`,
    );
  }
  if (stats.by_job_name?.length) {
    lines.push('', 'per job name:');
    for (const g of stats.by_job_name.slice(0, 15)) {
      lines.push(
        `  ${String(g.name).padEnd(34).slice(0, 34)} RPS ${String(g.rps ?? '-').padStart(5)} (${g.grade ?? '-'})  jobs=${String(g.count).padStart(3)}  rate=${pct(g.success_rate).padStart(6)}  p50=${formatDuration(g.duration_p50)}`,
      );
    }
  }
  if (stats.weakest?.length) {
    lines.push('', 'weakest jobs:');
    for (const j of stats.weakest.slice(0, 5)) {
      lines.push(`  ${j.started}  ${j.runner}  ${j.name}  ${j.result}  score=${j.job_score}`);
    }
  }
  return lines.join('\n');
}

async function main(argv) {
  const flags = parseArgs(argv);
  const command = flags._[0] ?? (flags.help ? 'help' : 'status');
  if (flags.help || command === 'help') {
    process.stdout.write(USAGE);
    return 0;
  }

  const dataDir = resolveDataDir({ dataDir: flags['data-dir'] });
  const session = await openSession({
    dataDir,
    settings: {
      windowHours: flags.hours ? Number(flags.hours) : undefined,
      refreshSeconds: flags.refresh ? Number(flags.refresh) : undefined,
    },
  });
  const asJson = flags.json === true;
  const dump = (obj) => process.stdout.write(`${JSON.stringify(obj, null, 2)}\n`);

  switch (command) {
    case 'status': {
      const status = await session.liveStatus();
      if (asJson) {
        dump(status);
        break;
      }
      if (!status.runners.length) {
        process.stdout.write(
          `No runners registered (data dir: ${dataDir}).\n` +
            '  add one:   dsh-runner-scope add --kind wsl --distro Ubuntu --path /opt/actions-runner\n' +
            '  find one:  dsh-runner-scope discover --adopt\n',
        );
        break;
      }
      process.stdout.write(
        `host ${status.host?.hostname ?? '-'}  cpus ${status.host?.cpus ?? '-'}  load ${(status.host?.loadavg ?? []).join('/') || '-'}\n\n`,
      );
      process.stdout.write(`${status.runners.map(printRunnerHealth).join('\n\n')}\n`);
      break;
    }
    case 'list': {
      const runners = session.listRunners();
      const pending = session.registry.pending ?? [];
      if (asJson) {
        dump({ dataDir, runners, pending });
        break;
      }
      process.stdout.write(`data dir: ${dataDir}\nregistered: ${runners.length}  pending: ${pending.length}\n`);
      for (const r of runners) {
        const t = r.transport ?? {};
        const where = t.kind === 'wsl' ? `wsl:${t.distro}` : t.kind === 'ssh' ? `ssh:${t.user ? `${t.user}@` : ''}${t.host}` : 'local';
        process.stdout.write(
          `  ${r.id}  ${r.label}  [${where}] ${t.path}  addedBy=${r.addedBy ?? '-'}  state=${r.state ?? '-'}\n`,
        );
      }
      for (const p of pending) {
        process.stdout.write(`  (pending) ${p.id}  ${p.label ?? '-'}  ${p.path}  via=${p.via ?? '-'}\n`);
      }
      if (pending.length) process.stdout.write('\nRegister them with: dsh-runner-scope adopt\n');
      break;
    }
    case 'add': {
      const kind = String(flags.kind ?? 'local');
      const transport = { kind, path: flags.path };
      if (flags.distro) transport.distro = flags.distro;
      if (flags.host) transport.host = flags.host;
      if (flags.user) transport.user = flags.user;
      if (flags.port) transport.port = Number(flags.port);
      if (!flags.path) throw new Error('add requires --path');
      const { runner, created } = await session.addRunner({ transport, label: flags.label });
      if (asJson) {
        dump({ created, runner });
        break;
      }
      process.stdout.write(
        `${created ? 'registered' : 'updated'} ${runner.id}  ${runner.label}\n` +
          `  source ${runner.transport.kind}${runner.transport.distro ? `:${runner.transport.distro}` : ''}${runner.transport.host ? `:${runner.transport.host}` : ''} ${runner.transport.path}\n` +
          `  repo   ${runner.identity?.githubUrl ?? '-'}\n` +
          `  agent  ${runner.identity?.agentName ?? '-'} #${runner.identity?.agentId ?? '-'}\n\n` +
          'Run: dsh-runner-scope collect\n',
      );
      break;
    }
    case 'remove': {
      const selector = flags._[1];
      if (!selector) throw new Error('remove requires a selector (id, label, agent name or path)');
      const removed = await session.removeRunner(selector);
      if (asJson) {
        dump({ removed });
        break;
      }
      process.stdout.write(removed ? `removed ${removed.id} (${removed.label})\n` : `no runner matches "${selector}"\n`);
      break;
    }
    case 'discover': {
      const transports = flags.transport.length ? flags.transport : undefined;
      const result = await session.discover({
        transports,
        adopt: flags.adopt === true ? true : undefined,
        extraPaths: flags['extra-path'] ?? [],
      });
      if (asJson) {
        dump(result);
        break;
      }
      const a = result.association;
      process.stdout.write(
        `candidates ${result.candidates.length}  linked ${a.linked.length}  adopted ${a.adopted.length}  pending ${a.pending.length}  missing ${a.missing.length}\n`,
      );
      for (const c of result.candidates) {
        process.stdout.write(`  found   ${c.path}  via=${c.via}  agent=${c.identity?.agentName ?? '-'}\n`);
      }
      for (const l of a.linked) process.stdout.write(`  linked  ${l.runner.label}${l.moved ? ' (moved)' : ''}\n`);
      for (const r of a.adopted) process.stdout.write(`  adopted ${r.label}\n`);
      for (const r of a.missing) process.stdout.write(`  missing ${r.label}\n`);
      for (const c of a.conflicts) process.stdout.write(`  WARNING duplicate agent ${c.key}: ${c.ids.join(', ')}\n`);
      for (const e of result.errors) process.stdout.write(`  error   ${e.transport}: ${e.message}\n`);
      if (a.pending.length && !flags.adopt) process.stdout.write('\nRegister them with: dsh-runner-scope adopt\n');
      break;
    }
    case 'adopt': {
      const adopted = await session.adoptPending(flags._.slice(1));
      if (asJson) {
        dump({ adopted });
        break;
      }
      if (!adopted.length) {
        process.stdout.write('nothing pending; run discover first\n');
        break;
      }
      for (const r of adopted) process.stdout.write(`adopted ${r.id}  ${r.label}  ${r.transport.path}\n`);
      process.stdout.write('\nRun: dsh-runner-scope collect\n');
      break;
    }
    case 'collect': {
      const result = await session.collect({
        hours: flags.hours ? Number(flags.hours) : undefined,
        autoDiscover: flags['no-discover'] ? false : undefined,
        writeDashboardFile: flags['write-dashboard'] === true,
      });
      if (asJson) {
        dump({ snapshot: result.snapshot, stats: result.stats, dashboard: result.dashboard ?? null });
        break;
      }
      process.stdout.write(
        `collected ${result.snapshot.collected} jobs from ${result.snapshot.runners.length} runner(s); store holds ${result.stored.length}\n`,
      );
      for (const r of result.snapshot.runners) {
        process.stdout.write(`  ${r.label}: ${r.state}${r.error ? ` (${r.error})` : ''}\n`);
      }
      process.stdout.write(`\n${printAnalysis(result.stats)}\n`);
      if (result.dashboard) process.stdout.write(`\ndashboard: ${result.dashboard}\n`);
      break;
    }
    case 'analyze': {
      const stats = await session.analyze({ hours: flags.hours ? Number(flags.hours) : undefined });
      if (asJson) {
        dump(stats);
        break;
      }
      if (!stats.completed) {
        process.stdout.write(`no completed jobs in the last ${stats.windowHours}h — run collect first\n`);
        break;
      }
      process.stdout.write(`${printAnalysis(stats)}\n`);
      break;
    }
    case 'dashboard': {
      const file = await session.dashboard({
        hours: flags.hours ? Number(flags.hours) : undefined,
        outFile: flags.out ? path.resolve(flags.out) : undefined,
        refreshSeconds: flags.refresh ? Number(flags.refresh) : undefined,
      });
      if (asJson) {
        dump({ dashboard: file });
        break;
      }
      process.stdout.write(`dashboard: ${file}\n`);
      if (flags.open) openInBrowser(file);
      break;
    }
    case 'serve': {
      const port = flags.port ? Number(flags.port) : 8790;
      const host = flags.host ?? '127.0.0.1';
      const server = http.createServer(async (req, res) => {
        try {
          const url = new URL(req.url ?? '/', `http://${host}`);
          const route = url.pathname.replace(/^\/+/, '');
          if (route.startsWith('api/')) {
            const hours = Number(url.searchParams.get('hours') ?? session.settings.windowHours);
            const body =
              route === 'api/status'
                ? await session.liveStatus()
                : route === 'api/analyze'
                  ? await session.analyze({ hours })
                  : route === 'api/registry'
                    ? { runners: session.listRunners(), pending: session.registry.pending ?? [] }
                    : null;
            if (!body) {
              res.writeHead(404, { 'content-type': 'application/json' });
              res.end('{"error":"unknown route"}');
              return;
            }
            res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
            res.end(JSON.stringify(body));
            return;
          }
          const file = await session.dashboard({
            hours: session.settings.windowHours,
            refreshSeconds: flags.refresh ? Number(flags.refresh) : 0,
          });
          const html = await fs.readFile(file, 'utf8');
          res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
          res.end(html);
        } catch (error) {
          res.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' });
          res.end(String(error?.message ?? error));
        }
      });
      await new Promise((resolve) => server.listen(port, host, resolve));
      process.stdout.write(`serving http://${host}:${port}/ (Ctrl+C to stop)\n`);
      if (flags.open) openInBrowser(`http://${host}:${port}/`);
      return 0;
    }
    default:
      process.stderr.write(`unknown command: ${command}\n\n${USAGE}`);
      return 2;
  }
  return 0;
}

main(process.argv.slice(2))
  .then((code) => {
    process.exitCode = code ?? 0;
  })
  .catch((error) => {
    process.stderr.write(`error: ${String(error?.message ?? error)}\n`);
    process.exitCode = 1;
  });
