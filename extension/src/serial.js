/**
 * A one-slot mutex for read-modify-write over chrome.storage.local.
 *
 * WHY THIS EXISTS: chrome dispatches extension listeners back-to-back without
 * awaiting them, so two handlers routinely run interleaved across their awaits.
 * Every storage mutation here is a read → decide → write, and interleaving two
 * of those means both read the SAME snapshot and the second write clobbers the
 * first. On the open interval that shows up as two closes of one span — two
 * distinct client_ids for the same attention, which the server cannot dedup
 * because the ids differ by construction, so the sensor OVERCOUNTS. On the
 * buffer it shows up as a silently dropped append. Both are exactly the lies
 * this extension is built to not tell.
 *
 * WHY A PROMISE CHAIN IS SAFE HERE: the queue orders work within one service
 * worker generation, and that is all it has to do. Every byte of real state
 * lives in chrome.storage.local, never in this module. An MV3 worker torn down
 * mid-queue simply restarts with a fresh empty chain and re-reads state from
 * storage — there is no lock held across the teardown, so there is nothing to
 * leak and nothing to deadlock on. A task that throws is absorbed by the tail
 * (the rejection still reaches its own caller), so one failed handler cannot
 * wedge every later one.
 *
 * Chrome-free on purpose so the ordering guarantee is unit-testable.
 */

const NOOP = () => {};

/**
 * Build an independent serializer. Calls run strictly in the order they were
 * made, each starting only after the previous has settled.
 *
 * @returns {<T>(fn: () => (T | Promise<T>)) => Promise<T>}
 */
export function createSerializer() {
  let tail = Promise.resolve();
  return function serial(fn) {
    const run = tail.then(() => fn());
    tail = run.then(NOOP, NOOP);
    return run;
  };
}
