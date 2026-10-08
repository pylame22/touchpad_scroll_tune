#!/usr/bin/env node
import {appendFileSync, existsSync, readFileSync, writeFileSync} from 'node:fs';
import {setTimeout as delay} from 'node:timers/promises';

const directory = process.env.SCROLL_TUNE_TEST_DIR;
const check = process.env.SCROLL_TUNE_CHECK;
const args = process.argv.slice(2);
appendFileSync(`${directory}/commands`, `${JSON.stringify(args)}\n`);
const factors = JSON.parse(readFileSync(`${directory}/state.json`, 'utf8'));
if (args.join(' ') === 'status --json') {
    if (check === 'cancel' || check === 'timeout')
        await delay(60_000);
    if (check === 'invalid')
        factors.scroll_vertical_factor = null;
    console.log(JSON.stringify({factors, gnome_shell_library_mapped: check !== 'inactive'}));
} else {
    if (args.length !== 5 || args[0] !== 'set' || args[1] !== '--scroll-vertical' || args[3] !== '--scroll-horizontal')
        throw new Error(`Unexpected arguments: ${args}`);
    if (check === 'failure') {
        console.error('Fake WSF could not save the settings.');
        process.exit(7);
    }
    if (check === 'signal')
        process.kill(process.pid, 'SIGTERM');
    if ((check === 'restore' || check === 'waiting') && Number(args[2]) === 0.35) {
        writeFileSync(`${directory}/entered`, '');
        while (!existsSync(`${directory}/release`))
            await delay(10);
    }
    factors.scroll_vertical_factor = Number(args[2]);
    factors.scroll_horizontal_factor = Number(args[4]);
    writeFileSync(`${directory}/state.json`, JSON.stringify(factors));
}
