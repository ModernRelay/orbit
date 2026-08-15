#!/usr/bin/env node

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { relative, resolve } from 'node:path';

const root = execFileSync('git', ['rev-parse', '--show-toplevel'], {
  encoding: 'utf8',
}).trim();

const trackedFiles = execFileSync('git', ['ls-files', '-z'], {
  cwd: root,
  encoding: 'utf8',
})
  .split('\0')
  .filter(Boolean);

// Include this script while it is still untracked during local development.
const self = relative(root, fileURLToPath(import.meta.url));
if (!trackedFiles.includes(self)) trackedFiles.push(self);

const dash = '-';
const dot = '.';
const slash = '/';
const markdownExtension = ['m', 'd'].join('');
const jsonExtension = ['j', 's', 'o', 'n'].join('');

const removedReferences = [
  `${['implementation', 'plan'].join(dash)}${dot}${markdownExtension}`,
  `${['invariants'].join('')}${dot}${markdownExtension}`,
  `${['orbit', 'spec'].join(dash)}${dot}${markdownExtension}`,
  `${['m0', 'conformance'].join(dash)}${dot}${markdownExtension}`,
  `${['m0', 'conformance'].join(dash)}${dot}${jsonExtension}`,
  `${['fixes', 'pr', '10', '11', '12'].join(dash)}${dot}${markdownExtension}`,
  ['docs', 'decisions'].join(slash),
  ['docs', 'evidence'].join(slash),
  ['docs', 'history'].join(slash),
];

const appendixPrefix = ['Appendix', 'B'].join(String.raw`\s+`);
const decisionPrefix = ['A', 'D', 'R'].join('');
const specificationPrefix = ['s', 'p', 'e', 'c'].join('');
const definitionPrefix = ['D', 'E', 'F'].join('');
const gatePrefix = ['G', 'N', 'G'].join('');
const registerPrefix = ['R', dash].join('');
const pullRequestPrefix = ['P', 'R'].join('');

const patterns = [
  ['appendix reference', new RegExp(`${appendixPrefix}(?:\\.\\d+(?:\\.\\d+)*)?`, 'iu')],
  [
    'numbered appendix anchor',
    new RegExp(String.raw`(?<![A-Za-z0-9_])${['B'].join('')}\.\d+(?:\.\d+)*(?![A-Za-z0-9_])`, 'u'),
  ],
  [
    'decision-record anchor',
    new RegExp(`(?<![A-Za-z0-9_])${decisionPrefix}(?:-\\d+)?(?![A-Za-z0-9_])`, 'iu'),
  ],
  [
    'numbered specification anchor',
    new RegExp(
      `(?<![A-Za-z0-9_])${specificationPrefix}(?:ification)?\\s+\\d+(?:\\.\\d+)*(?![A-Za-z0-9_])`,
      'iu',
    ),
  ],
  [
    'stage anchor',
    new RegExp(String.raw`(?<![A-Za-z0-9_])${['S'].join('')}\d+(?![A-Za-z0-9_])`, 'u'),
  ],
  [
    'task anchor',
    new RegExp(String.raw`(?<![A-Za-z0-9_])${['T'].join('')}\d+(?![A-Za-z0-9_])`, 'u'),
  ],
  [
    'definition anchor',
    new RegExp(`(?<![A-Za-z0-9_])${definitionPrefix}(?:\\d+)?(?![A-Za-z0-9_])`, 'u'),
  ],
  [
    'finding anchor',
    new RegExp(String.raw`(?<![A-Za-z0-9_])${['F'].join('')}\d+-\d+(?![A-Za-z0-9_])`, 'u'),
  ],
  [
    'register anchor',
    new RegExp(`(?<![A-Za-z0-9_])${registerPrefix}[A-Za-z0-9]+(?:-[A-Za-z0-9]+)*(?![A-Za-z0-9_])`, 'u'),
  ],
  [
    'gate anchor',
    new RegExp(`(?<![A-Za-z0-9_])${gatePrefix}(?:-\\d+)?(?![A-Za-z0-9_])`, 'u'),
  ],
  [
    'pull-request work-item anchor',
    new RegExp(
      `(?<![A-Za-z0-9_])${pullRequestPrefix}(?:\\d+-\\d+|-[A-Za-z0-9]+(?:-[A-Za-z0-9]+)*|\\s+#\\d+)(?![A-Za-z0-9_])`,
      'u',
    ),
  ],
];

const sectionMarker = String.fromCodePoint(0xa7);
const decoder = new TextDecoder('utf-8', { fatal: true });
const violations = [];
let textFileCount = 0;

function findViolation(value) {
  const lower = value.toLowerCase();
  const removed = removedReferences.find((reference) => lower.includes(reference));
  if (removed !== undefined) return ['removed internal-document reference', removed];
  if (value.includes(sectionMarker)) return ['section marker', sectionMarker];

  for (const [label, pattern] of patterns) {
    const match = pattern.exec(value);
    if (match !== null) return [label, match[0]];
  }
  return undefined;
}

for (const file of trackedFiles.sort()) {
  const pathViolation = findViolation(file);
  if (pathViolation !== undefined) {
    violations.push(`${file}: ${pathViolation[0]} (${JSON.stringify(pathViolation[1])})`);
  }

  let source;
  try {
    source = decoder.decode(readFileSync(resolve(root, file)));
  } catch {
    continue;
  }
  textFileCount += 1;

  for (const [index, line] of source.split(/\r?\n/u).entries()) {
    const violation = findViolation(line);
    if (violation !== undefined) {
      violations.push(
        `${file}:${index + 1}: ${violation[0]} (${JSON.stringify(violation[1])})`,
      );
    }
  }
}

if (violations.length > 0) {
  console.error(
    `Internal documentation anchors found:\n${violations.map((item) => `  ${item}`).join('\n')}`,
  );
  process.exit(1);
}

console.log(`internal anchors OK (${textFileCount} tracked text files checked)`);
