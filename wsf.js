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

export function runWsf(path, args, cancellable = null, timeoutSeconds = 5) {
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
        let timeout = timeoutSeconds ? GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, timeoutSeconds, () => {
            timeout = 0;
            expired = true;
            process.force_exit();
            return GLib.SOURCE_REMOVE;
        }) : 0;
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
    return {speed, active: status.gnome_shell_library_mapped === true};
}

export async function applySpeed(path, speed) {
    if (!validSpeed(speed))
        throw new Error('Invalid scroll speed.');
    // Let each set finish before restoration; no timeout source survives disable().
    await runWsf(path, ['set', '--scroll-vertical', speed.vertical.toFixed(4),
        '--scroll-horizontal', speed.horizontal.toFixed(4)], null, 0);
}
