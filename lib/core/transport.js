/**
 * Runner transports.
 *
 * A transport is "where a runner install directory lives, and how to read it".
 * Three kinds are supported:
 *
 *   local — a directory on the machine running DSH (any OS)
 *   wsl   — a directory inside a WSL distribution, reached over `wsl.exe`
 *   ssh   — a directory on a remote POSIX host, reached over `ssh`
 *
 * Every transport exposes the same tiny surface so the collector does not care
 * which one it is talking to. Local reads use `node:fs` directly (fast, no
 * shell); remote reads run POSIX commands through a single `bash -lc` script.
 * @module dsh-runner-scope/core/transport
 */

import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const DEFAULT_TIMEOUT_MS = 20_000;

/** POSIX single-quote escaping for values interpolated into a shell script. */
export function shq(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

/**
 * Spawn a process and capture its output. Never rejects: a failed spawn, a
 * non-zero exit and a timeout all resolve to a result object, because the
 * collector must keep going when one runner is unreachable.
 */
export function execCapture(command, args, { timeoutMs = DEFAULT_TIMEOUT_MS, cwd } = {}) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(command, args, { windowsHide: true, cwd });
    } catch (error) {
      resolve({ code: -1, stdout: '', stderr: String(error?.message ?? error), failed: true });
      return;
    }
    const outChunks = [];
    const errChunks = [];
    let settled = false;
    const decode = () => {
      const out = Buffer.concat(outChunks);
      return {
        stdout: out.toString('utf8'),
        stdoutBuffer: out,
        stderr: Buffer.concat(errChunks).toString('utf8'),
      };
    };
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ ...decode(), ...result });
    };
    const timer = setTimeout(() => {
      try {
        child.kill('SIGKILL');
      } catch {
        /* the process is already gone */
      }
      finish({ code: -1, timedOut: true, failed: true });
    }, timeoutMs);
    child.stdout?.on('data', (chunk) => {
      outChunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    });
    child.stderr?.on('data', (chunk) => {
      errChunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    });
    child.on('error', (error) => {
      finish({ code: -1, spawnError: String(error?.message ?? error), failed: true });
    });
    child.on('close', (code) => {
      finish({ code: code ?? -1, failed: code !== 0 });
    });
  });
}

function stripBom(text) {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

/** Normalize a transport spec (unknown keys are dropped). */
export function normalizeTransportSpec(spec) {
  const input = spec && typeof spec === 'object' ? spec : {};
  const kind = String(input.kind || 'local').toLowerCase();
  if (kind === 'wsl') {
    if (!input.distro) throw new TypeError('wsl transport requires "distro"');
    return {
      kind: 'wsl',
      distro: String(input.distro),
      path: String(input.path || ''),
      user: input.user ? String(input.user) : undefined,
    };
  }
  if (kind === 'ssh') {
    if (!input.host) throw new TypeError('ssh transport requires "host"');
    return {
      kind: 'ssh',
      host: String(input.host),
      user: input.user ? String(input.user) : undefined,
      port: input.port ? Number(input.port) : undefined,
      identityFile: input.identityFile ? String(input.identityFile) : undefined,
      path: String(input.path || ''),
    };
  }
  if (kind !== 'local') throw new TypeError(`unsupported transport kind: ${kind}`);
  return { kind: 'local', path: input.path ? String(input.path) : '' };
}

/** Human-readable one-liner for a transport spec. */
export function describeTransport(spec) {
  const s = normalizeTransportSpec(spec);
  if (s.kind === 'local') return `local:${s.path || '.'}`;
  if (s.kind === 'wsl') return `wsl:${s.distro}${s.path ? `:${s.path}` : ''}`;
  return `ssh:${s.user ? `${s.user}@` : ''}${s.host}${s.path ? `:${s.path}` : ''}`;
}

function createLocalTransport(spec) {
  return {
    kind: 'local',
    spec,
    describe: () => describeTransport(spec),
    isLocal: true,
    async runScript(script) {
      // Local reads never need a shell; this exists for symmetry only.
      return execCapture(process.platform === 'win32' ? 'cmd.exe' : '/bin/sh', [
        process.platform === 'win32' ? '/c' : '-c',
        script,
      ]);
    },
    async readText(target) {
      try {
        return stripBom(await fs.readFile(target, 'utf8'));
      } catch {
        return null;
      }
    },
    async readJson(target) {
      const text = await this.readText(target);
      if (text == null) return null;
      try {
        return JSON.parse(text);
      } catch {
        return null;
      }
    },
    async exists(target) {
      try {
        await fs.stat(target);
        return true;
      } catch {
        return false;
      }
    },
    async listDirs(patterns) {
      const out = new Set();
      for (const pattern of patterns) {
        // Only literal trailing-* globs are supported for local scans.
        const star = pattern.lastIndexOf('*');
        if (star < 0) {
          if (await this.exists(pattern)) out.add(pattern);
          continue;
        }
        const dir = pattern.slice(0, star) || '.';
        const prefix = path.basename(pattern.slice(0, star));
        let entries = [];
        try {
          entries = await fs.readdir(dir.startsWith('~') ? expandHome(dir) : dir, { withFileTypes: true });
        } catch {
          continue;
        }
        for (const entry of entries) {
          if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
          if (prefix && !entry.name.startsWith(prefix.replace(/[\\/]+$/, ''))) continue;
          out.add(path.join(dir.startsWith('~') ? expandHome(dir) : dir, entry.name));
        }
      }
      return [...out];
    },
    async readDir(target) {
      try {
        return await fs.readdir(target);
      } catch {
        return [];
      }
    },
    async dirSize(target) {
      const result = await execCapture(
        process.platform === 'win32' ? 'cmd.exe' : 'du',
        process.platform === 'win32' ? ['/c', `dir /s /-c "${target}"`] : ['-sb', target],
        { timeoutMs: 30_000 },
      );
      if (process.platform === 'win32') {
        const m = /(\d+)\s+File\(s\)/.exec(result.stdout.replace(/,/g, ''));
        return m ? Number(m[1]) : 0;
      }
      const first = result.stdout.trim().split(/\s+/)[0];
      const n = Number(first);
      return Number.isFinite(n) ? n : 0;
    },
  };
}

function expandHome(p) {
  return p.startsWith('~') ? path.join(os.homedir(), p.slice(1)) : p;
}

function createPosixShellTransport(kind, spec, buildArgs) {
  return {
    kind,
    spec,
    describe: () => describeTransport(spec),
    isLocal: false,
    async runScript(script) {
      const [command, args] = buildArgs(script);
      return execCapture(command, args);
    },
    async readText(target) {
      const r = await this.runScript(`cat -- ${shq(target)} 2>/dev/null`);
      return r.code === 0 ? stripBom(r.stdout) : null;
    },
    async readJson(target) {
      const text = await this.readText(target);
      if (text == null) return null;
      try {
        return JSON.parse(text);
      } catch {
        return null;
      }
    },
    async exists(target) {
      const r = await this.runScript(`test -e ${shq(target)} && echo yes || echo no`);
      return r.stdout.trim() === 'yes';
    },
    async listDirs(patterns) {
      if (!patterns.length) return [];
      const script = patterns.map((p) => `ls -d ${p} 2>/dev/null`).join('\n');
      const r = await this.runScript(script);
      return [
        ...new Set(
          r.stdout
            .split('\n')
            .map((line) => line.trim())
            .filter((line) => line && !line.includes('*') && !line.includes('No such')),
        ),
      ];
    },
    async readDir(target) {
      const r = await this.runScript(`ls -1 ${shq(target)} 2>/dev/null`);
      return r.stdout
        .split('\n')
        .map((line) => line.trim())
        .filter(Boolean);
    },
    async dirSize(target) {
      const r = await this.runScript(`du -sb ${shq(target)} 2>/dev/null | cut -f1`);
      const n = Number(r.stdout.trim().split('\n')[0]);
      return Number.isFinite(n) ? n : 0;
    },
    /** Run a small POSIX script and return its stdout (used by discovery). */
    async script(body) {
      const r = await this.runScript(body);
      return r.stdout;
    },
  };
}

function createWslTransport(spec) {
  const args = (script) => {
    const base = ['-d', spec.distro];
    if (spec.user) base.push('-u', spec.user);
    base.push('--', 'bash', '-lc', script);
    return ['wsl.exe', base];
  };
  return createPosixShellTransport('wsl', spec, args);
}

function createSshTransport(spec) {
  const target = spec.user ? `${spec.user}@${spec.host}` : spec.host;
  const args = (script) => {
    const base = ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=8'];
    if (spec.port) base.push('-p', String(spec.port));
    if (spec.identityFile) base.push('-i', spec.identityFile);
    base.push(target, script);
    return ['ssh', base];
  };
  return createPosixShellTransport('ssh', spec, args);
}

/** Build a transport from a spec. Throws on an unsupported kind. */
export function createTransport(spec) {
  const normalized = normalizeTransportSpec(spec);
  if (normalized.kind === 'local') return createLocalTransport(normalized);
  if (normalized.kind === 'wsl') return createWslTransport(normalized);
  return createSshTransport(normalized);
}

/** Cache so one collect run reuses the same transport per spec. */
export function createTransportPool() {
  const cache = new Map();
  return {
    get(spec) {
      const key = describeTransport(spec);
      if (!cache.has(key)) cache.set(key, createTransport(spec));
      return cache.get(key);
    },
  };
}

/**
 * List WSL distributions available on this Windows host. Returns [] anywhere
 * else (or when `wsl.exe` is missing).
 */
export async function listWslDistros() {
  if (process.platform !== 'win32') return [];
  const r = await execCapture('wsl.exe', ['-l', '-q'], { timeoutMs: 8000 });
  const raw = r.stdoutBuffer ?? Buffer.from(r.stdout, 'utf8');
  // `wsl.exe -l -q` emits UTF-16LE on every Windows build we care about; a
  // UTF-8 host would show NUL bytes between characters.
  const looksUtf16 = raw.length > 1 && raw[1] === 0;
  const text = looksUtf16 ? raw.toString('utf16le') : raw.toString('utf8');
  return [
    ...new Set(
      text
        .split(/\r?\n/)
        .map((line) => line.replace(/\u0000/g, '').replace(/^\uFEFF/, '').trim())
        .filter(Boolean),
    ),
  ];
}
