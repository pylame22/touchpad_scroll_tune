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
        let process;
        try {
            process = Gio.Subprocess.new([path, ...args],
                Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_PIPE);
        } catch (error) {
            reject(error);
            return;
        }
        let expired = false;
        const timeout = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, 5, () => {
            expired = true;
            process.force_exit();
            return GLib.SOURCE_REMOVE;
        });
        const cancelId = cancellable?.connect(() => process.force_exit());
        process.communicate_utf8_async(null, null, (source, result) => {
            if (!expired)
                GLib.source_remove(timeout);
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

export function applySpeed(path, speed) {
    if (!validSpeed(speed))
        return Promise.reject(new Error('Invalid scroll speed.'));
    return runWsf(path, ['set', '--scroll-vertical', String(speed.vertical),
        '--scroll-horizontal', String(speed.horizontal)]);
}
