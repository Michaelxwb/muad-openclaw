'use strict';

function parseArgs(argv) {
  const args = [...argv];
  const command = args[0] && !args[0].startsWith('--') ? args.shift() : null;
  const options = {};

  for (let i = 0; i < args.length; i += 1) {
    const token = args[i];
    if (!token.startsWith('--')) {
      throw new Error(`Unexpected positional argument: ${token}`);
    }

    const key = token.slice(2);
    const next = args[i + 1];
    if (!next || next.startsWith('--')) {
      options[key] = true;
    } else {
      options[key] = next;
      i += 1;
    }
  }

  return { command, options };
}

function requireArgs(options, names) {
  const missing = names.filter((name) => !options[name]);
  if (missing.length) {
    throw new Error(`Missing required option(s): ${missing.map((name) => `--${name}`).join(', ')}`);
  }
}

module.exports = {
  parseArgs,
  requireArgs
};
