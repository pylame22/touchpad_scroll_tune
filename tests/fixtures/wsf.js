import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import {applySpeed} from '../../wsf.js';

Gio._promisify(Gio.File.prototype, 'load_contents_async');
Gio._promisify(Gio.File.prototype, 'replace_contents_bytes_async', 'replace_contents_finish');

const directory = GLib.getenv('SCROLL_TUNE_TEST_DIR');
const path = `${directory}/wsf`;
const read = async name => new TextDecoder().decode(
    (await Gio.File.new_for_path(`${directory}/${name}`).load_contents_async(null))[0]);
const state = async () => JSON.parse(await read('state.json'));
const commands = async () => (await read('commands')).trim().split('\n').map(line => JSON.parse(line));
const speed = {vertical: 0.35, horizontal: 0.45};
const assert = (condition, message) => { if (!condition) throw new Error(message); };
const deferred = () => {
    let resolve;
    const promise = new Promise(done => resolve = done);
    return {promise, resolve};
};
async function rejects(operation, matches) {
    let failure;
    try { await operation(); } catch (error) { failure = error; }
    assert(failure && matches(failure), `Unexpected error: ${failure}`);
}

// The fake command stays alive until released, so restoration cannot overtake it.
async function waitForCommand() {
    const entered = Gio.File.new_for_path(`${directory}/entered`);
    const monitor = entered.monitor_file(Gio.FileMonitorFlags.NONE, null);
    try {
        await new Promise(resolve => {
            monitor.connect('changed', () => { if (entered.query_exists(null)) resolve(); });
            if (entered.query_exists(null)) resolve();
        });
    } finally {
        monitor.cancel();
    }
}

const check = ARGV[0];
if (check === 'command') {
    const newFile = Gio.File.new_for_path;
    Gio.File.new_for_path = () => { throw new Error('Direct configuration access'); };
    GLib.timeout_add_seconds = () => { throw new Error('Unexpected set timeout'); };
    for (const name of ['communicate_utf8', 'wait', 'wait_check'])
        Gio.Subprocess.prototype[name] = () => { throw new Error(`Synchronous ${name}`); };
    await applySpeed(path, speed);
    Gio.File.new_for_path = newFile;
    assert(JSON.stringify(await commands()) === JSON.stringify([
        ['set', '--scroll-vertical', '0.3500', '--scroll-horizontal', '0.4500'],
    ]), 'Wrong command arguments');
    const applied = await state();
    assert(applied.scroll_vertical_factor === 0.35 && applied.scroll_horizontal_factor === 0.45,
        'Command did not finish before applySpeed resolved');
} else if (check === 'errors' || check === 'failure' || check === 'signal') {
    const before = await read('state.json');
    if (check === 'errors') {
        await rejects(() => applySpeed(path, {vertical: NaN, horizontal: 1}), error => /Invalid/.test(error.message));
        await rejects(() => applySpeed(`${directory}/missing`, speed), error => error.matches(GLib.SpawnError, GLib.SpawnError.NOENT));
    } else {
        await rejects(() => applySpeed(path, speed), error => error.message === (check === 'failure'
            ? 'Fake WSF could not save the settings.' : 'Wayland Scroll Factor could not apply the setting.'));
    }
    assert(await read('state.json') === before, 'A rejected command changed the settings');
} else {
    const {default: Extension} = await import(`file://${directory}/extension.js`);
    const handlers = new Map();
    let configuration = '';
    const settings = {
        get_string: () => configuration,
        set_string: (_key, value) => { configuration = value; return true; },
        connect: (_signal, callback) => { handlers.set(callback, callback); return callback; },
        disconnect: id => handlers.delete(id),
    };
    class TestExtension extends Extension {
        getSettings() { return settings; }
        _report(error) { throw error; }
        _start(cancellable) {
            this.started = super._start(cancellable);
            return this.started;
        }
    }
    const extension = new TestExtension();
    if (check === 'cancel') {
        const entered = deferred();
        const addTimeout = GLib.timeout_add_seconds;
        let timeoutId;
        GLib.timeout_add_seconds = (...args) => {
            timeoutId = addTimeout(...args);
            entered.resolve();
            return timeoutId;
        };
        extension.enable();
        await entered.promise;
        extension.disable();
        assert(!GLib.MainContext.default().find_source_by_id(timeoutId), 'Status timer survived disable');
        await rejects(() => extension.started, error => error.message === 'Operation cancelled.');
        GLib.timeout_add_seconds = addTimeout;
    } else if (check === 'inactive' || check === 'invalid' || check === 'timeout') {
        const errors = [];
        extension._report = error => errors.push(error);
        const before = await read('state.json');
        extension.enable();
        const message = {inactive: 'wsf enable', invalid: 'valid scroll speeds', timeout: 'five seconds'}[check];
        await rejects(() => extension.started, error => error.message.includes(message));
        assert(errors.length === 1 && !extension._writer, 'Startup failure was not reported');
        extension.disable();
        assert(await read('state.json') === before, 'Failed startup changed the settings');
    } else {
        extension.enable();
        await extension.started;
        const writer = extension._writer;
        const addTimeout = GLib.timeout_add_seconds;
        GLib.timeout_add_seconds = () => { throw new Error('Unexpected set timeout'); };
        writer.request(speed);
        await waitForCommand();
        assert((await state()).scroll_vertical_factor === 1, 'Held command already applied its factors');
        extension.disable();
        const finished = writer._pending;
        // Startup may create a status timer only after restoration has completed.
        finished.then(() => { GLib.timeout_add_seconds = addTimeout; });
        assert(extension._writer === null && handlers.size === 0, 'Shell resources survived disable');
        extension.enable();
        const started = extension.started;
        if (check === 'waiting')
            extension.disable();
        const beforeRelease = await commands();
        assert(!extension._writer && beforeRelease.length === 2, 'Re-enable or restoration overtook the running command');
        await Gio.File.new_for_path(`${directory}/release`).replace_contents_bytes_async(
            new GLib.Bytes('release\n'), null, false, Gio.FileCreateFlags.NONE, null);
        await finished;
        await started;
        if (check === 'waiting') {
            assert(extension._writer === null && handlers.size === 0, 'Cancelled startup continued');
            extension.enable();
            await extension.started;
        }
        assert(extension._originalSpeed.vertical === 1 && extension._originalSpeed.horizontal === 0.8,
            'Re-enable captured an application override');
        await extension._writer._pending;
        const restored = await state();
        assert(restored.scroll_vertical_factor === 1 && restored.scroll_horizontal_factor === 0.8,
            'Original factors were not restored');
        assert(JSON.stringify(await commands()) === JSON.stringify([
            ['status', '--json'], ['set', '--scroll-vertical', '0.3500', '--scroll-horizontal', '0.4500'],
            ['set', '--scroll-vertical', '1.0000', '--scroll-horizontal', '0.8000'], ['status', '--json'],
        ]), 'Unexpected command order or redundant commands');
        const lastWriter = extension._writer;
        extension.disable();
        await lastWriter._pending;
    }
}
print('Check passed');
