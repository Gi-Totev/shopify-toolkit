#!/usr/bin/env node
'use strict';
// stk — shopify toolkit dispatcher. Runs tools under ../tools/<name>/.
// Cross-platform (Windows/mac/linux). No args → picker.

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { pickOne } = require('../lib/pick');

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

function help() {
  console.log('stk — shopify toolkit');
  console.log('Usage: stk [tool] [args...]    (no tool → picker)\n');
  console.log('Tools:');
  for (const t of listTools()) console.log(`  ${t.padEnd(14)} ${desc(t)}`);
}

async function main() {
  const [cmd, ...rest] = process.argv.slice(2);

  if (cmd === undefined) {
    const tools = listTools();
    if (tools.length === 0) { console.error('stk: no tools installed'); process.exit(1); }
    const sel = await pickOne(tools.map((t) => ({ label: t, desc: desc(t) })), 'stk > ');
    if (sel) runTool(sel, []);
    process.exit(0);
  }
  if (['ls', 'list', '-h', '--help', 'help'].includes(cmd)) { help(); return; }
  runTool(cmd, rest);
}

main();
