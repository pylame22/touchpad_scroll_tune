import assert from 'node:assert/strict';
import test from 'node:test';
import {SpeedWriter} from '../writer.js';

const speed = n => ({vertical: n, horizontal: n});
const tick = () => new Promise(resolve => setImmediate(resolve));

test('same-speed events do not write the configuration', async () => {
    let calls = 0;
    const writer = new SpeedWriter(async () => calls++, speed(1));
    for (let i = 0; i < 10000; i++)
        writer.request(speed(1));
    await tick();
    assert.equal(calls, 0);
});

test('only the newest target follows an in-flight write, including a return to the original', async () => {
    const calls = [];
    const finishes = [];
    const writer = new SpeedWriter(value => new Promise(resolve => {
        calls.push(value.vertical);
        finishes.push(resolve);
    }), speed(1));
    writer.request(speed(0.3));
    await tick();
    writer.request(speed(0.5));
    writer.request(speed(0.7));
    writer.request(speed(1));
    assert.deepEqual(calls, [0.3]);
    finishes.shift()();
    await tick();
    assert.deepEqual(calls, [0.3, 1]);
    finishes.shift()();
    await tick();
    assert.equal(writer._pending, null);
});

test('close serializes restoration after a running write and ignores later requests', async () => {
    const calls = [];
    let finish;
    const writer = new SpeedWriter(value => {
        calls.push(value.vertical);
        return calls.length === 1 ? new Promise(resolve => finish = resolve) : Promise.resolve();
    }, speed(0.25));
    writer.request(speed(0.3));
    await tick();
    const stopped = writer.close(speed(0.25));
    writer.request(speed(2));
    finish();
    await stopped;
    assert.deepEqual(calls, [0.3, 0.25]);
});

test('failed writes are not cached as applied or retried on every event', async () => {
    let calls = 0;
    let errors = 0;
    const writer = new SpeedWriter(async () => { calls++; throw Error('failure'); }, speed(1), () => errors++);
    await writer.request(speed(0.3));
    for (let i = 0; i < 100; i++)
        writer.request(speed(0.3));
    await tick();
    assert.equal(calls, 1);
    assert.equal(errors, 1);
    assert.equal(writer._applied, null);
});

test('disable restores the baseline after a write with an uncertain outcome', async () => {
    const calls = [];
    const writer = new SpeedWriter(async value => {
        calls.push(value.vertical);
        if (value.vertical === 0.3)
            throw Error('failed after writing');
    }, speed(1), () => {});
    await writer.request(speed(0.3));
    await writer.close(speed(1));
    assert.deepEqual(calls, [0.3, 1]);
});

test('a request immediately after a no-op is not lost', async () => {
    const calls = [];
    const writer = new SpeedWriter(async value => calls.push(value.vertical), speed(1));
    writer.request(speed(1));
    await Promise.resolve();
    await writer.request(speed(0.3));
    await tick();
    assert.deepEqual(calls, [0.3]);
});
