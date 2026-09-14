/**
 * Where dsh-runner-watcher keeps its state.
 *
 * One directory holds everything: the runner registry, the job store, the
 * snapshot log and the generated dashboard. It defaults to
 * `<dsh home>/runner-watcher`, which keeps runner data next to the rest of the
 * harness state instead of scattering it across AppData.
 * @module dsh-runner-watcher/core/paths
 */

import os from 'node:os';
import path from 'node:path';

/** The DSH home directory (honours `DSH_HOME`). */
export function dshHome(env = process.env) {
  return env.DSH_HOME || path.join(os.homedir(), '.dsh');
}

/**
 * Resolve the data directory.
 * Precedence: explicit config/flag > `DSH_RUNNER_WATCHER_DIR` > `<dsh home>/runner-watcher`.
 */
export function resolveDataDir(config = {}, env = process.env) {
  if (config.dataDir) return path.resolve(String(config.dataDir));
  if (env.DSH_RUNNER_WATCHER_DIR) return path.resolve(String(env.DSH_RUNNER_WATCHER_DIR));
  return path.join(dshHome(env), 'runner-watcher');
}
