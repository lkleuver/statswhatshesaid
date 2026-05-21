#!/usr/bin/env node

import { main } from './cli-main.js'

// Thin wrapper around the testable `main()`. Tests call `main()` directly
// with capture buffers; this script wires it to the real process streams
// and exit code.
main(process.argv.slice(2), { stdout: process.stdout, stderr: process.stderr }).then(
  (code) => process.exit(code),
  (err) => {
    process.stderr.write(`statswhatshesaid-collector: unexpected error: ${err?.stack || err}\n`)
    process.exit(3)
  },
)
