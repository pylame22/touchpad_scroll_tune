import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {chmod, copyFile, mkdir, mkdtemp, readFile, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {dirname, join} from 'node:path';
import test from 'node:test';
import {fileURLToPath, pathToFileURL} from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const checks = {
    preserve: 'asynchronous writes preserve unrelated settings and use no subprocess',
    missing: 'a missing WSF config and its directory are created',
    conflict: 'a detected external edit is preserved instead of overwritten',
    errors: 'invalid factors and file errors leave existing content intact',
    restore: 'disable during a write restores both axes before re-enable',
    waiting: 'disable while waiting for restoration does not restart the extension',
    cancel: 'disable cancels the status command and removes its timeout',
    inactive: 'inactive WSF stops startup without writing the configuration',
    path: 'unsupported status output cannot select a relative configuration path',
};

for (const [check, title] of Object.entries(checks)) {
    test(title, async () => {
        const directory = await mkdtemp(join(tmpdir(), 'scroll-tune-test-'));
        let child;
        try {
            await mkdir(join(directory, 'settings'));
            await writeFile(join(directory, 'settings/config'),
                'scroll_vertical_factor=1.0000\nscroll_horizontal_factor=0.8000\npinch_zoom_factor=1.2000\n');
            await copyFile(new URL('./fixtures/wsf.mjs', import.meta.url), join(directory, 'wsf'));
            await chmod(join(directory, 'wsf'), 0o755);
            // Exercise the real extension lifecycle with only Shell imports stubbed.
            const source = (await readFile(join(root, 'extension.js'), 'utf8'))
                .replace(/^import .* from '(?:gi:\/\/(?:Clutter|Shell)|resource:.*?)';\n/gm, '')
                .replaceAll("from './", `from '${pathToFileURL(root).href}/`);
            await writeFile(join(directory, 'extension.js'),
                'const Clutter = {}; const Shell = {WindowTracker: {get_default: () => ({})}};\n' +
                'class Extension {} const Main = {};\n' + source);
            child = spawn('gjs', ['-m', join(root, 'tests/fixtures/wsf.js'), check], {
                detached: true, timeout: 15_000,
                env: {...process.env, GIO_USE_VFS: 'local', SCROLL_TUNE_TEST_DIR: directory,
                    PATH: `${directory}:${dirname(process.execPath)}:${process.env.PATH}`,
                    SCROLL_TUNE_STATUS_DELAY: check === 'cancel' ? '60' : '0',
                    SCROLL_TUNE_ACTIVE: check === 'inactive' ? '0' : '1',
                    SCROLL_TUNE_CONFIG_PATH: check === 'path' ? 'relative/path' : join(directory, 'settings/config')},
                stdio: ['ignore', 'pipe', 'pipe'],
            });
            let output = '';
            child.stdout.on('data', chunk => output += chunk);
            child.stderr.on('data', chunk => output += chunk);
            const [code, signal] = await once(child, 'close');
            assert.equal(signal, null, output);
            assert.equal(code, 0, output);
            assert.equal(output.trim(), 'Check passed');
        } finally {
            if (child?.pid) {
                try { process.kill(-child.pid, 'SIGKILL'); } catch (error) {
                    if (error.code !== 'ESRCH') throw error;
                }
            }
            await rm(directory, {recursive: true, force: true});
        }
    });
}
