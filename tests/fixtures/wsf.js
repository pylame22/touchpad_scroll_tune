import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import {applySpeed} from '../../wsf.js';

Gio._promisify(Gio.File.prototype, 'load_contents_async');
Gio._promisify(Gio.File.prototype, 'replace_contents_bytes_async', 'replace_contents_finish');
Gio._promisify(Gio.File.prototype, 'delete_async');

const directory = GLib.getenv('SCROLL_TUNE_TEST_DIR');
const path = `${directory}/settings/config`;
const file = Gio.File.new_for_path(path);
const read = async () => new TextDecoder().decode((await file.load_contents_async(null))[0]);
const write = text => file.replace_contents_bytes_async(new GLib.Bytes(text), null, false,
    Gio.FileCreateFlags.REPLACE_DESTINATION, null);
const speed = {vertical: 0.35, horizontal: 0.45};
const original = {vertical: 1, horizontal: 0.8};
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

function holdWrite() {
    const entered = deferred();
    const replace = Gio.File.prototype.replace_contents_bytes_async;
    let release;
    Gio.File.prototype.replace_contents_bytes_async = function (...args) {
        Gio.File.prototype.replace_contents_bytes_async = replace;
        release = () => replace.call(this, ...args);
        entered.resolve();
    };
    return {entered: entered.promise, release: () => release()};
}

const check = ARGV[0];
if (check === 'preserve') {
    const retained = '# My settings\r\nfactor=0.9\r\npinch_zoom_factor=1.25\r\npinch_rotate_factor=0.75\r\nfuture_key=keep\r\n';
    await write(`${retained} scroll_vertical_factor = 2\nscroll_vertical_factor=3\nscroll_horizontal_factor=4`);
    Gio.Subprocess.new = () => { throw new Error('Unexpected subprocess'); };
    Gio.File.prototype.load_contents = () => { throw new Error('Synchronous read'); };
    Gio.File.prototype.replace_contents = () => { throw new Error('Synchronous write'); };
    await applySpeed(path, speed);
    const expected = `${retained}scroll_vertical_factor=0.3500\nscroll_horizontal_factor=0.4500\n`;
    assert(await read() === expected, 'Unrelated settings changed or duplicate factors remain');
    await write((await read()).replace('pinch_zoom_factor=1.25', 'pinch_zoom_factor=1.50'));
    await applySpeed(path, original);
    assert((await read()).includes('pinch_zoom_factor=1.50'), 'Restoration overwrote a later pinch setting');
} else if (check === 'missing') {
    await file.delete_async(GLib.PRIORITY_DEFAULT, null);
    await file.get_parent().delete_async(GLib.PRIORITY_DEFAULT, null);
    await applySpeed(path, speed);
    assert(await read() === 'scroll_vertical_factor=0.3500\nscroll_horizontal_factor=0.4500\n', 'Config was not created');
} else if (check === 'conflict') {
    const held = holdWrite();
    const result = applySpeed(path, speed);
    await held.entered;
    const external = '# External edit\npinch_zoom_factor=2\n';
    await write(external);
    held.release();
    await rejects(() => result, error => error.matches(Gio.IOErrorEnum, Gio.IOErrorEnum.WRONG_ETAG));
    assert(await read() === external, 'An external edit was overwritten');
} else if (check === 'errors') {
    const before = await read();
    await rejects(() => applySpeed(path, {vertical: NaN, horizontal: 1}), error => /Invalid/.test(error.message));
    await rejects(() => applySpeed(`${path}/child`, speed), error => error.matches(Gio.IOErrorEnum, Gio.IOErrorEnum.NOT_DIRECTORY));
    await rejects(() => applySpeed(`${directory}/settings`, speed), error => error.matches(Gio.IOErrorEnum, Gio.IOErrorEnum.IS_DIRECTORY));
    assert(await read() === before, 'A failed write changed the config');
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
    } else if (check === 'inactive' || check === 'path') {
        const errors = [];
        extension._report = error => errors.push(error);
        const before = await read();
        extension.enable();
        await rejects(() => extension.started, error => new RegExp(check === 'inactive' ? 'wsf enable' : 'configuration path').test(error.message));
        assert(errors.length === 1 && !extension._writer, 'Startup failure was not reported');
        extension.disable();
        assert(await read() === before, 'Failed startup changed the file');
    } else {
        extension.enable();
        await extension.started;
        const writer = extension._writer;
        const held = holdWrite();
        writer.request(speed);
        await held.entered;
        extension.disable();
        const finished = writer._pending;
        assert(extension._writer === null && handlers.size === 0, 'Shell resources survived disable');
        extension.enable();
        const started = extension.started;
        if (check === 'waiting')
            extension.disable();
        // An I/O round trip gives startup a chance to run, without a timing guess.
        await read();
        assert(!extension._writer, 'Re-enable did not wait for restoration');
        held.release();
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
        const restored = await read();
        assert(restored.includes('scroll_vertical_factor=1.0000') && restored.includes('scroll_horizontal_factor=0.8000'),
            'Original factors were not restored');
        const lastWriter = extension._writer;
        extension.disable();
        await lastWriter._pending;
    }
}
print('Check passed');
