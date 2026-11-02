// Run the whole offline test suite in one Node process. `node --test` spawns
// piped child processes, which some confined environments block; importing the
// test files directly runs the same node:test assertions.
import './arxiv.test.mjs'
import './prompt.test.mjs'
import './host.test.mjs'
