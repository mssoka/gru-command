import { readFileSync } from 'node:fs';
import process from 'node:process';
import { pathToFileURL } from 'node:url';

const adapterNames = [
  'npm aliases refuse independently before producer start',
  'conventional option positions refuse independently',
  'exact declared script words refuse independently',
  'root-relative web bin paths refuse independently',
  'bounded control prefixes refuse entire calls',
  'plain unquoted source heredocs and diagnostic reads execute normally',
];
const policyNames = [
  'advertised shell-safe status action authenticates literal dollar/backtick host config paths',
  'conventional aliases/options/control/path forms classify without data-position inference',
  'exact declared npm script words survive normalization',
  'plain unquoted heredoc bodies are data, actual expansions and executable neighbors still refuse',
  'independent raw native corpus refuses producers and allows meaningful reads without hooks',
];
const review1Names = [
  'standalone lint refuses before any producer', 'standalone typecheck refuses before any producer',
  'standalone build refuses before any producer', 'standalone build:web refuses before any producer',
  'backend script refuses before any producer', 'heavy backend script refuses before any producer',
  'web script refuses in a minimal lane', 'npm prefix normalization refuses before any producer',
  'npx option normalization refuses before any producer', 'assignment-prefixed declared custom script refuses',
  'wrapper nesting and options refuse before any producer', 'adjacent redirects refuse before any producer',
  'known direct local-bin paths refuse before any producer', 'executable producers outside literal heredocs refuse whole calls',
  'each conventional direct tool independently refuses', 'literal source heredocs and development/setup actions remain normal Bash',
  'second and disposed/reopened turns preserve native guards with zero producer starts',
  'native fallback independently covers conventional flags and local-bin paths',
  'verification files survive unknown deadline until identity-bound late close',
  'verification files survive child error until identity-bound actual close',
  'verification files survive disposal rejection until identity-bound actual close',
  'independently recognizes every standalone npm check script', 'normalizes conventional wrappers and package-manager flags',
  'shares normalization for assignment-prefixed custom declarations', 'recognizes only known local producer paths including native prefixes',
  'delimits redirections without changing producer classification', 'quoted literal heredoc bodies are data but executable neighbors still refuse',
  'development servers and browser installation are not producers', 'config authority is required and never inferred from dataDir or environment',
  'production registry binder carries loaded instance config independently of relocated data',
  'owned fallback resource resolution retains config authority on declared-scope lanes',
];

/** RED is a named behavioral assertion, never an arbitrary nonzero runner exit.
 * Both legs are checked; exact reports remain immutable custody artifacts. */
export function classifyReviewedRed(report, generation, phase) {
  if (![1, 2].includes(generation) || !['fast', 'heavy'].includes(phase)) throw new Error('unknown reviewed candidate or phase');
  if (!report || !Array.isArray(report.testResults) || report.testResults.length === 0) throw new Error('missing collected suites');
  if (!report.testResults.every((suite) => Array.isArray(suite.assertionResults) && suite.assertionResults.length > 0)) throw new Error('setup/import/collection failure is not behavioral RED');
  const assertions = report.testResults.flatMap((suite) => suite.assertionResults);
  const failed = assertions.filter((entry) => entry.status === 'failed');
  if (!failed.length || report.numFailedTests !== failed.length || report.numFailedTestSuites > report.testResults.filter((suite) => suite.assertionResults.some((entry) => entry.status === 'failed')).length) throw new Error('missing behavioral failures or inconsistent runner report');
  const names = generation === 1 ? review1Names : phase === 'fast' ? [...adapterNames, ...policyNames] : [...adapterNames,
    'independent raw corpus exercises native refusal and allow with hook unavailable',
    'actual prompt registration retains pre-disposal errored original until delayed close',
    'actual compaction registration retains pre-disposal errored original until delayed close'];
  for (const entry of failed) {
    if (!names.includes(entry.title?.replace(`review-${generation} `, '')) || !entry.title?.startsWith(`review-${generation} `)) throw new Error(`unlisted failure: ${entry.title}`);
    if (!Array.isArray(entry.failureMessages) || !entry.failureMessages.some((text) => /^AssertionError:|^Error: promise rejected .* instead of resolving/su.test(text))) throw new Error(`non-behavioral failure: ${entry.title}`);
  }
  return failed.map((entry) => entry.title);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const [generation, fast, heavy] = process.argv.slice(2);
    for (const [phase, file] of [['fast', fast], ['heavy', heavy]]) {
      const names = classifyReviewedRed(JSON.parse(readFileSync(file, 'utf8')), Number(generation), phase);
      process.stdout.write(JSON.stringify({ file, generation: Number(generation), phase, behavioralFailures: names }) + '\n');
    }
  } catch (error) { process.stderr.write(`NOT BEHAVIORAL RED: ${String(error)}\n`); process.exitCode = 2; }
}
