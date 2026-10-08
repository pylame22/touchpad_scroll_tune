import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import {validSpeed} from './config.js';

export function findWsf() {
    const path = GLib.find_program_in_path('wsf');
    if (path)
        return path;
    const local = GLib.build_filenamev([GLib.get_home_dir(), '.local', 'bin', 'wsf']);
    if (GLib.file_test(local, GLib.FileTest.IS_EXECUTABLE))
        return local;
    throw new Error('Install Wayland Scroll Factor 1.0 or later to get started.');
}

export function runWsf(path, args, cancellable = null) {
    return new Promise((resolve, reject) => {
        if (cancellable?.is_cancelled()) {
            reject(new Error('Operation cancelled.'));
            return;
        }
        let process;
        try {
            process = Gio.Subprocess.new([path, ...args],
                Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_PIPE);
        } catch (error) {
            reject(error);
            return;
        }
        let expired = false;
        let timeout = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, 5, () => {
            timeout = 0;
            expired = true;
            process.force_exit();
            return GLib.SOURCE_REMOVE;
        });
        const clearTimeout = () => {
            if (timeout)
                GLib.source_remove(timeout);
            timeout = 0;
        };
        const cancelId = cancellable?.connect(() => {
            clearTimeout();
            process.force_exit();
        });
        process.communicate_utf8_async(null, null, (source, result) => {
            clearTimeout();
            if (cancelId)
                cancellable.disconnect(cancelId);
            try {
                const [, stdout, stderr] = source.communicate_utf8_finish(result);
                if (cancellable?.is_cancelled())
                    throw new Error('Operation cancelled.');
                if (expired)
                    throw new Error('Wayland Scroll Factor did not respond within five seconds.');
                if (!source.get_successful())
                    throw new Error(stderr.trim() || 'Wayland Scroll Factor could not apply the setting.');
                resolve(stdout);
            } catch (error) {
                reject(error);
            }
        });
    });
}

export async function readWsf(path, cancellable = null) {
    const status = JSON.parse(await runWsf(path, ['status', '--json'], cancellable));
    const speed = {
        vertical: status.factors?.scroll_vertical_factor,
        horizontal: status.factors?.scroll_horizontal_factor,
    };
    if (!validSpeed(speed))
        throw new Error('WSF did not return valid scroll speeds. Version 1.0 or later is required.');
    if (typeof status.config !== 'string' || !GLib.path_is_absolute(status.config))
        throw new Error('WSF did not return a valid configuration path. Version 1.0 or later is required.');
    return {speed, active: status.gnome_shell_library_mapped === true, configPath: status.config};
}

function loadConfig(file) {
    return new Promise((resolve, reject) => {
        file.load_contents_async(null, (source, result) => {
            try {
                const [, contents, etag] = source.load_contents_finish(result);
                resolve([new TextDecoder('utf-8', {fatal: true}).decode(contents), etag]);
            } catch (error) {
                if (error.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.NOT_FOUND))
                    resolve(['', null]);
                else
                    reject(error);
            }
        });
    });
}

export async function applySpeed(path, speed) {
    if (!validSpeed(speed))
        throw new Error('Invalid scroll speed.');
    const file = Gio.File.new_for_path(path);
    const [contents, etag] = await loadConfig(file);
    if (etag === null) {
        await new Promise((resolve, reject) => {
            file.get_parent().make_directory_async(GLib.PRIORITY_DEFAULT, null, (source, result) => {
                try {
                    source.make_directory_finish(result);
                    resolve();
                } catch (error) {
                    if (error.matches(Gio.IOErrorEnum, Gio.IOErrorEnum.EXISTS))
                        resolve();
                    else
                        reject(error);
                }
            });
        });
    }
    // Keep comments, legacy factors, pinch settings and unknown keys intact.
    let text = contents.split('\n').filter(line =>
        !/^\s*scroll_(vertical|horizontal)_factor\s*=/.test(line)).join('\n');
    if (text && !text.endsWith('\n'))
        text += '\n';
    text += `scroll_vertical_factor=${speed.vertical.toFixed(4)}\nscroll_horizontal_factor=${speed.horizontal.toFixed(4)}\n`;
    const bytes = new GLib.Bytes(text);
    await new Promise((resolve, reject) => {
        // GBytes keeps the buffer alive until GIO finishes the atomic replacement.
        file.replace_contents_bytes_async(bytes, etag, false, Gio.FileCreateFlags.REPLACE_DESTINATION,
            null, (source, result) => {
                try {
                    source.replace_contents_finish(result);
                    resolve();
                } catch (error) {
                    reject(error);
                }
            });
    });
}
