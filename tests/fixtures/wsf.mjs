#!/usr/bin/env node
import {readFileSync} from 'node:fs';
import {setTimeout as delay} from 'node:timers/promises';

if (process.argv.slice(2).join(' ') !== 'status --json')
    throw new Error('Only the startup status command should be used.');
await delay(Number(process.env.SCROLL_TUNE_STATUS_DELAY) * 1000);
const config = process.env.SCROLL_TUNE_CONFIG_PATH;
const text = readFileSync(`${process.env.SCROLL_TUNE_TEST_DIR}/settings/config`, 'utf8');
const factors = Object.fromEntries(text.trim().split('\n').map(line => {
    const [key, value] = line.split('=');
    return [key, Number(value)];
}));
console.log(JSON.stringify({config, factors,
    gnome_shell_library_mapped: process.env.SCROLL_TUNE_ACTIVE !== '0'}));
