/**
 * Re-exports the shared stack harness.
 *
 * WHY this indirection: `scripts/lib/stack.mjs` owns the process lifecycle because the integration
 * tests, the load harness and the perf harness all need the same three processes. Duplicating that
 * logic in the test folder would mean a port fix lands in one copy and not the others -- which is
 * exactly what happened when this file held its own copy.
 *
 * WHY keep a named seam rather than importing the lib path directly in the test: the relative import
 * reads better here, and it makes the single-implementation boundary obvious to a reviewer.
 */
export {
  ROOT, PORTS, startStack, waitForHealth, pythonBin, percentile,
} from '../../scripts/lib/stack.mjs';