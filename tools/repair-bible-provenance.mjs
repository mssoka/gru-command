#!/usr/bin/env node
/**
 * Owner-run repair of the Book of Lessons' provenance, from the journal:
 *
 *   GRU_COMMAND_HOME=<instance> node tools/repair-bible-provenance.mjs [dataDir]           dry run
 *   GRU_COMMAND_HOME=<instance> node tools/repair-bible-provenance.mjs [dataDir] --write   apply
 *
 * Why: the dream parser accepts provenance only as `<journal-id>@<iso-date>`.
 * Hand-edited chapters (`…; earlier: j-869, j-878`, `j-907,<ts>`) made every
 * dream pass fail from 2026-10-02 on (owner incident 2026-10-07). The
 * journal is the ground truth, so each cited `j-<seq>` is resolved to its
 * exact timestamp — nothing is guessed: an id missing from the journal
 * aborts before any write. The chapter cap is then re-applied (oldest
 * provenance handles go first; see PROVENANCE_FLOOR in the bible).
 *
 * Running with --write IS the owner's approval: originals are saved under
 * <bible>/.repair-backup-<stamp>-<nonce>/chapters/ first, and — still under
 * the write lock — every chapter is re-read with the strict parser and its
 * stored bytes checked against the cap; any failure exits 1. The
 * instance is selected by GRU_COMMAND_HOME (its config supplies the data
 * dir and the chapter cap); a dataDir argument must name that same data
 * dir. A write holds the book's write lock, so it never interleaves with a
 * dream; a failed write names the replaced chapters and the backup.
 */
import { statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import process from 'node:process';
import { URL, fileURLToPath, pathToFileURL } from 'node:url';

const packageRoot = resolve(fileURLToPath(new URL('..', import.meta.url)));
const fromDist = (path) => import(pathToFileURL(join(packageRoot, 'dist', path)).href);

const fail = (message) => {
  process.stderr.write(`repair-bible-provenance: ${message}\n`);
  process.exit(1);
};

const args = process.argv.slice(2);
const write = args.includes('--write');
const positional = args.filter((arg) => arg !== '--write');
if (positional.length > 1 || positional.some((arg) => arg.startsWith('--'))) {
  fail('usage: repair-bible-provenance.mjs [dataDir] [--write]');
}

let modules;
try {
  modules = await Promise.all([
    fromDist('config.js'),
    fromDist('lessons/bible.js'),
    fromDist('lessons/journal.js'),
  ]);
} catch (error) {
  fail(`cannot load the built service (${String(error)}) — run npm run build first`);
}
const [{ loadConfig }, { BibleStore, parseIsoInstant }, { JournalStore }] = modules;

const config = loadConfig(process.env, homedir());
const dataDir = resolve(config.dataDir);
// The cap and every other setting come from ONE instance's config: a data
// dir belonging to another instance would be repaired under the wrong cap.
if (positional[0] !== undefined && resolve(positional[0]) !== dataDir) {
  fail(
    `${resolve(positional[0])} is not this instance's data dir (${dataDir}); ` +
      'select the instance with GRU_COMMAND_HOME=<its instance dir> instead — nothing was written',
  );
}

const journal = new JournalStore(join(dataDir, 'journal'));
// The journal is the ground truth only if it is consistent. Every physical
// record is checked from ONE complete read — no paging, so a duplicate
// can't hide past a page boundary — before any chapter is planned: each id
// must be its own sequence, each timestamp a valid instant the provenance
// format can hold, and no id may carry two different timestamps.
let records;
try {
  records = journal.entries();
} catch (error) {
  fail(`the journal is unreadable (${error instanceof Error ? error.message : String(error)}) — nothing was written`);
}
/** A record's content with its keys in a fixed order, so two physical
 * copies compare by what they say, not by how they were spelled. */
const canonical = (value) =>
  Array.isArray(value)
    ? `[${value.map(canonical).join(',')}]`
    : value !== null && typeof value === 'object'
      ? `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`
      : JSON.stringify(value);
const journalTs = new Map();
const journalRecords = new Map();
for (const entry of records) {
  if (entry.id !== `j-${entry.seq}`) {
    fail(`journal entry seq ${entry.seq} is recorded as ${entry.id} — fix the journal first; nothing was written`);
  }
  // A real calendar instant (Date.parse would silently turn 2026-02-30 into
  // March 2nd); any offset or fraction precision is fine.
  if (parseIsoInstant(entry.ts) === null) {
    fail(`journal entry ${entry.id} has an invalid timestamp ${JSON.stringify(entry.ts)} — fix the journal first; nothing was written`);
  }
  const seen = journalTs.get(entry.id);
  if (seen !== undefined && seen !== entry.ts) {
    fail(`journal id ${entry.id} appears twice with different timestamps (${seen}, ${entry.ts}) — fix the journal first; nothing was written`);
  }
  // Only an identical copy is tolerated (R5-A6): two records that share an
  // id but say different things leave that handle's ground truth ambiguous.
  const content = canonical(entry);
  if (journalRecords.has(entry.id) && journalRecords.get(entry.id) !== content) {
    fail(`journal id ${entry.id} appears twice with different contents — fix the journal first; nothing was written`);
  }
  journalRecords.set(entry.id, content);
  journalTs.set(entry.id, entry.ts);
}

// The selected instance's book must exist: a mistyped instance must never
// "repair" an empty, newly created book and report success.
const chaptersDir = join(dataDir, 'bible', 'chapters');
let chaptersStat;
try {
  chaptersStat = statSync(chaptersDir);
} catch (error) {
  // Only a missing path means a missing book (R5-A8); anything else is
  // reported as itself, never as "the wrong instance".
  if (error?.code === 'ENOENT') {
    fail(`${chaptersDir} does not exist — is GRU_COMMAND_HOME (${process.env.GRU_COMMAND_HOME ?? 'unset'}) the right instance? nothing was written`);
  }
  fail(`${chaptersDir} cannot be read (${error?.code ?? String(error)}: ${error instanceof Error ? error.message : String(error)}) — nothing was written`);
}
if (!chaptersStat.isDirectory()) {
  fail(`${chaptersDir} exists but is not a directory — nothing was written`);
}

const bible = new BibleStore(join(dataDir, 'bible'), {
  chapterCapBytes: config.lessons.chapterCapBytes,
  indexCapBytes: config.lessons.indexCapBytes,
});

let report;
try {
  report = bible.repairProvenance(journalTs, { write });
} catch (error) {
  // A write-phase failure names what was replaced and where the originals
  // are; every earlier failure happens before the first write.
  if (error instanceof Error && error.name === 'RepairWriteError') fail(error.message);
  fail(`${error instanceof Error ? error.message : String(error)} — nothing was written`);
}

const out = (line) => process.stdout.write(`${line}\n`);
out(`${write ? 'repair' : 'dry run'}: ${join(dataDir, 'bible')} (journal ${journalTs.size} entries, cap ${config.lessons.chapterCapBytes} B)`);
for (const chapter of report.chapters) {
  out(
    `  ${chapter.changed ? 'CHANGE' : 'ok    '} ${chapter.slug}: lessons ${chapter.lessonsBefore}→${chapter.lessonsAfter}, ` +
      `provenance lines rewritten ${chapter.linesRewritten}, oldest handles released ${chapter.provenanceTrimmed}, ` +
      `bodies trimmed ${chapter.bodiesTrimmed}, lessons dropped ${chapter.lessonsDropped}, ${chapter.bytes} B`,
  );
}
const changed = report.chapters.filter((chapter) => chapter.changed).length;
if (!write) {
  out(changed === 0 ? 'nothing to repair' : `${changed} chapter(s) would change — re-run with --write to apply`);
  process.exit(0);
}
if (report.backupDir !== null) out(`originals saved under ${report.backupDir}`);
// The write was proven inside the lock: every chapter parses and fits.
out(changed === 0 ? 'nothing to repair' : `repaired ${changed} chapter(s); every chapter parses and fits the cap`);
