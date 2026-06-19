// Package state aggregates daemon-wide runtime and persistent state
// management primitives previously scattered across runpool, acppool,
// acpsessionmap, agentsessions, runcontext and memorysync.
//
// File layout:
//   - store.go         : package documentation + small generic helpers.
//   - runtime_state.go : in-flight run pool (run id -> cmd/cancel/status).
//   - session_map.go   : on-disk ACP session map (key -> sessionId).
//   - acp_processes.go : pool of live ACP child processes plus the
//                        acpsdk.Client bridge that forwards session
//                        updates to the daemon.
//   - locks.go         : small sync helpers used across the package.
//   - cache.go         : run-context helpers and memory-sync poller.
//
// Naming conventions:
//   - The plain `Pool` / `New` symbols belong to the run pool (formerly
//     internal/runpool) since that pool is the most heavily used concept.
//   - ACP process pool symbols are prefixed with ACP (ACPPool, ACPProcess,
//     NewACPPool) to disambiguate from the run pool.
package state
