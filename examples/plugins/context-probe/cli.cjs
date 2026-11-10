const fs = require('node:fs');

if (process.argv.slice(2).includes('--help')) {
  console.log('Usage: offckb context-probe [arguments...]\nPrints the invocation context and unmodified arguments.');
} else {
  const context = JSON.parse(fs.readFileSync(process.env.OFFCKB_PLUGIN_CONTEXT, 'utf8'));
  // Print only the fields this protocol probe needs.
  const result = {
    ok: true,
    command: 'context-probe',
    argv: process.argv.slice(2),
    cwd: context.cwd,
    output: context.output,
    kind: context.devnet.kind,
    diagnosticCode: context.devnet.diagnostic?.code,
    cliEntry: context.cli.entry,
  };
  console.log(JSON.stringify(result));
}
