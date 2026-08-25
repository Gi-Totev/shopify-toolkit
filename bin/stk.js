#!/usr/bin/env node
'use strict';
// stk — shopify toolkit dispatcher. Runs tools under ../tools/<name>/.
// Cross-platform (Windows/mac/linux). No args → picker.

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { pickOne } = require('../lib/pick');
const { installedVersion, checkForUpdate, runUpdate } = require('../lib/version');

const ROOT = path.join(__dirname, '..');
const TOOLS = path.join(ROOT, 'tools');

function listTools() {
  if (!fs.existsSync(TOOLS)) return [];
  return fs.readdirSync(TOOLS)
    .filter((n) => fs.statSync(path.join(TOOLS, n)).isDirectory())
    .sort();
}

function desc(name) {
  try { return fs.readFileSync(path.join(TOOLS, name, '.desc'), 'utf8').trim(); }
  catch { return ''; }
}

function runTool(name, args) {
  const js = path.join(TOOLS, name, `${name}.js`);
  const runExe = path.join(TOOLS, name, 'run');
  let r;
  if (fs.existsSync(js)) r = spawnSync(process.execPath, [js, ...args], { stdio: 'inherit' });
  else if (fs.existsSync(runExe)) r = spawnSync(runExe, args, { stdio: 'inherit' });
  else {
    console.error(`stk: unknown tool '${name}'`);
    console.error(`available: ${listTools().join(', ') || '(none)'}`);
    process.exit(1);
  }
  process.exit(r.status == null ? 1 : r.status);
}

function list() {
  console.log('stk — shopify toolkit\n');
  console.log('Usage:');
  console.log('  stk               pick a tool to run');
  console.log('  stk -l            list all tools + descriptions');
  console.log('  stk <tool>        run a tool directly');
  console.log('  stk <tool> -h     help for a specific tool\n');
  console.log('Tools:');
  for (const t of listTools()) console.log(`  ${t.padEnd(14)} ${desc(t)}`);
  console.log('\nCommands:');
  console.log(`  ${'update'.padEnd(14)} update stk to the latest version`);
  console.log(`  ${'--version'.padEnd(14)} show installed version`);
}

async function notifyUpdate() {
  try {
    const info = await checkForUpdate();
    if (info.updateAvailable) {
      console.error(`stk: update available (${info.installed} → ${info.latest}). Run: stk update`);
    }
  } catch { /* never block on the update check */ }
}

async function main() {
  const [cmd, ...rest] = process.argv.slice(2);

  if (cmd === '-v' || cmd === '--version') { console.log(installedVersion()); return; }
  if (cmd === 'update') { process.exit(runUpdate()); }

  await notifyUpdate();

  if (['-l', '--list', 'ls', 'list'].includes(cmd) || (cmd && cmd.startsWith('-'))) { list(); return; }

  if (cmd === undefined) {
    const tools = listTools();
    if (tools.length === 0) { console.error('stk: no tools installed'); process.exit(1); }
    if (!process.stdin.isTTY) { list(); return; } // no terminal → print instead of hang
    const sel = await pickOne(tools, 'stk > ');
    if (sel) runTool(sel, []);
    process.exit(0);
  }

  runTool(cmd, rest);
}

main();
