import assert from 'node:assert/strict';
import test from 'node:test';
import {
  parseUnitWorkingDirectory,
  parseWindowsServicePath,
  readRunnerConfig,
  windowsDirPatterns,
} from '../lib/core/discover.js';

test('parseUnitWorkingDirectory reads the systemd install dir', () => {
  const unit = [
    '[Service]',
    'ExecStart=/opt/actions-runner/runsvc.sh',
    'WorkingDirectory=/opt/actions-runner',
    'KillMode=process',
  ].join('\n');
  assert.equal(parseUnitWorkingDirectory(unit), '/opt/actions-runner');
  assert.equal(parseUnitWorkingDirectory('[Service]\n'), null);
  assert.equal(parseUnitWorkingDirectory(null), null);
});

test('parseWindowsServicePath strips the quoted exe and the bin folder', () => {
  assert.equal(
    parseWindowsServicePath('"C:\\actions-runner\\bin\\Runner.Listener.exe" run'),
    'C:\\actions-runner',
  );
  assert.equal(
    parseWindowsServicePath('"D:\\ci\\actions-runner\\bin\\RunnerService.exe"'),
    'D:\\ci\\actions-runner',
  );
  // A path without the bin level is taken as the install root itself.
  assert.equal(parseWindowsServicePath('C:\\tools\\runner.exe'), 'C:\\tools');
  assert.equal(parseWindowsServicePath(''), null);
});

test('windowsDirPatterns covers the conventional locations', () => {
  const patterns = windowsDirPatterns({ USERPROFILE: 'C:\\Users\\ci', ProgramData: 'C:\\ProgramData', ProgramFiles: 'C:\\Program Files' });
  assert.ok(patterns.some((p) => p.toLowerCase().startsWith('c:\\actions-runner')));
  assert.ok(patterns.some((p) => p.includes('Users\\ci')));
  assert.ok(patterns.some((p) => p.includes('ProgramData')));
});

test('readRunnerConfig normalizes a .runner file and rejects non-runners', async () => {
  const files = new Map([
    ['/opt/actions-runner/.runner', JSON.stringify({
      agentId: 27,
      agentName: 'wsl',
      gitHubUrl: 'https://github.com/acme/repo',
      poolName: 'Default',
      workFolder: '_work',
    })],
    ['/opt/empty/.runner', 'not json'],
  ]);
  const transport = {
    isLocal: true,
    readJson: async (p) => {
      const text = files.get(String(p).replace(/\\/g, '/'));
      if (text == null) return null;
      try {
        return JSON.parse(text);
      } catch {
        return null;
      }
    },
  };
  const identity = await readRunnerConfig(transport, '/opt/actions-runner');
  assert.equal(identity.agentId, 27);
  assert.equal(identity.agentName, 'wsl');
  assert.equal(identity.workFolder, '_work');
  assert.equal(await readRunnerConfig(transport, '/opt/missing'), null);
  assert.equal(await readRunnerConfig(transport, '/opt/empty'), null);
});
