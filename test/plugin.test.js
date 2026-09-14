import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { apply, name as pluginName, inject as pluginInject, DASHBOARD_PATH } from '../lib/index.js';

/** Minimal cordis context: enough to capture registrations. */
function createMockCtx() {
  const tools = new Map();
  const routes = [];
  const effects = [];
  const injections = [];
  const ctx = {
    logger: { info: () => {}, warn: () => {}, error: () => {} },
    tools: {
      register(definition) {
        if (tools.has(definition.name)) throw new Error(`duplicate tool ${definition.name}`);
        tools.set(definition.name, definition);
        return () => tools.delete(definition.name);
      },
    },
    effect(fn, label) {
      effects.push({ label, dispose: fn() });
      return () => {};
    },
    inject(deps, callback) {
      injections.push(deps);
      const webCtx = {
        logger: ctx.logger,
        effect: ctx.effect,
        webServer: {
          register(route) {
            routes.push(route);
            return () => {};
          },
        },
      };
      callback(webCtx);
      return {};
    },
  };
  return { ctx, tools, routes, effects, injections };
}

async function withRunnerInstall(fn) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'runner-watcher-plugin-'));
  const install = path.join(root, 'actions-runner');
  await fs.mkdir(path.join(install, '_diag'), { recursive: true });
  await fs.writeFile(
    path.join(install, '.runner'),
    JSON.stringify({ agentId: 7, agentName: 'plugin-runner', gitHubUrl: 'https://github.com/a/b' }),
    'utf8',
  );
  try {
    return await fn({ root, install, dataDir: path.join(root, 'data') });
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
}

test('plugin metadata is well formed', () => {
  assert.equal(pluginName, 'dsh-runner-watcher');
  assert.deepEqual(pluginInject, ['tools']);
  assert.equal(DASHBOARD_PATH, '/dsh-runner-watcher');
});

test('apply registers the documented tools and the dashboard route', async () => {
  await withRunnerInstall(async ({ dataDir }) => {
    const { ctx, tools, routes, injections } = createMockCtx();
    apply(ctx, { dataDir });

    const expected = [
      'runner_watcher_status',
      'runner_watcher_list',
      'runner_watcher_add',
      'runner_watcher_remove',
      'runner_watcher_discover',
      'runner_watcher_adopt',
      'runner_watcher_collect',
      'runner_watcher_analyze',
      'runner_watcher_dashboard',
    ];
    for (const tool of expected) assert.ok(tools.has(tool), `missing tool ${tool}`);

    for (const definition of tools.values()) {
      assert.equal(typeof definition.execute, 'function', `${definition.name} needs execute`);
      assert.equal(typeof definition.description, 'string');
      assert.ok(definition.parameters && definition.parameters.type === 'object');
      assert.ok(definition.output, `${definition.name} needs an output contract`);
      assert.equal(definition.output.schema.type, 'string');
      const rendered = definition.output.render({}, 'x');
      assert.deepEqual(rendered, [{ type: 'text', text: 'x' }]);
      assert.ok(definition.output.presentationMeta({}, 'x').title);
    }

    // The web server is an optional dependency: requested via ctx.inject.
    assert.deepEqual(injections, [['webServer']]);
    assert.equal(routes.length, 1);
    assert.equal(routes[0].kind, 'prefix');
    assert.equal(routes[0].path, DASHBOARD_PATH);
  });
});

test('empty registry produces guidance instead of a crash', async () => {
  await withRunnerInstall(async ({ dataDir }) => {
    const { ctx, tools } = createMockCtx();
    apply(ctx, { dataDir });
    const status = await tools.get('runner_watcher_status').execute({}, {});
    assert.match(status, /No runners registered/);
    assert.match(status, /runner_watcher_add/);
    const list = await tools.get('runner_watcher_list').execute({}, {});
    assert.match(list, /registered: 0/);
  });
});

test('add -> collect -> analyze round trip through the tools', async () => {
  await withRunnerInstall(async ({ dataDir, install }) => {
    const { ctx, tools } = createMockCtx();
    apply(ctx, { dataDir });

    const added = await tools.get('runner_watcher_add').execute(
      { kind: 'local', path: install },
      {},
    );
    assert.match(added, /Registered rn_/);
    assert.match(added, /plugin-runner/);

    const listed = await tools.get('runner_watcher_list').execute({}, {});
    assert.match(listed, /plugin-runner/);
    assert.match(listed, /addedBy=manual/);

    const collected = await tools.get('runner_watcher_collect').execute({ autoDiscover: false }, {});
    assert.match(collected, /store now holds 0/, 'no jobs exist in the fixture');

    const analyzed = await tools.get('runner_watcher_analyze').execute({ hours: 168 }, {});
    assert.match(analyzed, /No completed jobs/);

    const removed = await tools.get('runner_watcher_remove').execute({ selector: 'plugin-runner' }, {});
    assert.match(removed, /Removed rn_/);
    assert.match(await tools.get('runner_watcher_list').execute({}, {}), /registered: 0/);
  });
});

test('the dashboard route serves HTML and JSON without a DSH host', async () => {
  await withRunnerInstall(async ({ dataDir, install }) => {
    const { ctx, tools, routes } = createMockCtx();
    apply(ctx, { dataDir });
    await tools.get('runner_watcher_add').execute({ kind: 'local', path: install }, {});

    const handler = routes[0].handler;
    const call = (url) =>
      new Promise((resolve, reject) => {
        const res = {
          statusCode: 0,
          headers: null,
          body: '',
          writeHead(code, headers) {
            this.statusCode = code;
            this.headers = headers;
          },
          end(body) {
            this.body = body ?? '';
            resolve(this);
          },
          on() {},
        };
        Promise.resolve(handler({ url, method: 'GET' }, res)).catch(reject);
      });

    const html = await call(DASHBOARD_PATH);
    assert.equal(html.statusCode, 200);
    assert.match(html.headers['content-type'], /text\/html/);
    assert.match(html.body, /Runner Watcher/);

    const registry = await call(`${DASHBOARD_PATH}/api/registry`);
    assert.equal(registry.statusCode, 200);
    assert.match(registry.headers['content-type'], /application\/json/);
    const parsed = JSON.parse(registry.body);
    assert.equal(parsed.runners.length, 1);
    assert.equal(parsed.runners[0].identity.agentName, 'plugin-runner');

    const analyze = await call(`${DASHBOARD_PATH}/api/analyze?hours=24`);
    assert.equal(analyze.statusCode, 200);
    assert.equal(JSON.parse(analyze.body).windowHours, 24);

    const missing = await call(`${DASHBOARD_PATH}/api/nope`);
    assert.equal(missing.statusCode, 404);
  });
});
