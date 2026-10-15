import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

interface R2ShellAnalysis {
  readonly codeLines: readonly string[];
  readonly issues: readonly string[];
}

function analyzeR2ShellSource(source: string): R2ShellAnalysis {
  let quote: '"' | "'" | undefined;
  let lineContinuation = false;
  let multilineQuote = false;
  let doubleQuotedCommandSubstitution = false;
  let backtickCommandSubstitution = false;
  const codeLines = source.split(/\r?\n/u).map((line) => {
    const code = line.split('');
    let atWordStart = true;
    for (let index = 0; index < line.length; index += 1) {
      const character = line[index] ?? '';
      if (quote === "'") {
        code[index] = ' ';
        if (character === "'") quote = undefined;
        continue;
      }
      if (quote === '"') {
        code[index] = ' ';
        if (character === '\\') {
          if (index + 1 < line.length) {
            code[index + 1] = ' ';
            index += 1;
          } else {
            lineContinuation = true;
          }
        } else if (character === '$' && line[index + 1] === '(') {
          doubleQuotedCommandSubstitution = true;
        } else if (character === '`') {
          backtickCommandSubstitution = true;
        } else if (character === '"') {
          quote = undefined;
        }
        continue;
      }
      if (character === '\\') {
        code[index] = ' ';
        if (index + 1 < line.length) {
          code[index + 1] = ' ';
          index += 1;
          atWordStart = false;
        } else {
          lineContinuation = true;
        }
        continue;
      }
      if (character === "'" || character === '"') {
        quote = character;
        code[index] = ' ';
        atWordStart = false;
        continue;
      }
      if (character === '#' && atWordStart) {
        code.fill(' ', index);
        break;
      }
      if (character === '`') backtickCommandSubstitution = true;
      if (/\s/u.test(character) || /[;&|(){}<>]/u.test(character)) {
        atWordStart = true;
        continue;
      }
      atWordStart = false;
    }
    if (quote !== undefined) multilineQuote = true;
    return code.join('');
  });
  const issues: string[] = [];
  if (hasShellHereDocument(codeLines)) issues.push('heredoc');
  if (codeLines.some((line) => /[;&|]\s*(?:if|for|while|until|select|case)\b/u.test(line))) issues.push('inline control flow');
  if (codeLines.some((line) => /(?:^|[;&|])\s*[({]|\b(?:if|then|else|elif|do|while|until)\s*[({]|!\s*[({]/u.test(line))) {
    issues.push('shell group');
  }
  if (codeLines.some((line) => /(?:^|[;&|({])\s*(?:function\b|[A-Za-z_][A-Za-z0-9_]*\s*\(\s*\)\s*(?:\{|$))/u.test(line))) {
    issues.push('function definition');
  }
  if (lineContinuation) issues.push('line continuation');
  if (multilineQuote) issues.push('multiline quoted text');
  if (doubleQuotedCommandSubstitution) issues.push('double-quoted command substitution');
  if (backtickCommandSubstitution) issues.push('backtick command substitution');
  return { codeLines, issues };
}

function hasShellHereDocument(codeLines: readonly string[]): boolean {
  let arithmeticDepth = 0;
  for (const line of codeLines) {
    for (let index = 0; index < line.length; index += 1) {
      if (arithmeticDepth > 0) {
        if (line.startsWith('$((', index)) {
          arithmeticDepth += 1;
          index += 2;
        } else if (line.startsWith('))', index)) {
          arithmeticDepth -= 1;
          index += 1;
        }
        continue;
      }
      if (line.startsWith('$((', index)) {
        arithmeticDepth = 1;
        index += 2;
      } else if (line[index] === '<' && line[index + 1] === '<' && line[index - 1] !== '<' && line[index + 2] !== '<') {
        return true;
      }
    }
  }
  return false;
}

function r2ShellSyntaxIssues(source: string): readonly string[] {
  return analyzeR2ShellSource(source).issues;
}

function shellControlDepthAt(codeLines: readonly string[], lineIndex: number): number {
  return codeLines.slice(0, lineIndex).reduce((depth, line) => {
    const command = line.trim();
    if (command === '') return depth;
    if (/^(?:if|for|while|until|select|case)\b/u.test(command)) return depth + 1;
    if (/^(?:fi|done|esac)\b/u.test(command)) return depth - 1;
    return depth;
  }, 0);
}

function shellCommandSubstitutionDepthAt(codeLines: readonly string[], lineIndex: number): number {
  return codeLines.slice(0, lineIndex).reduce((depth, line) => {
    let current = depth;
    for (let index = 0; index < line.length; index += 1) {
      if (line[index] === '$' && line[index + 1] === '(') {
        current += 1;
        index += 1;
      } else if (line[index] === ')' && current > 0) {
        current -= 1;
      }
    }
    return current;
  }, 0);
}

/**
 * Phantom-check guard: every test file must register exactly its pinned
 * number of tests. A file that silently collects zero tests (or loses some
 * to an aborted module) fails here instead of passing vacuously.
 * Adding a test? Bump this pin — that is the point.
 */
const PINS: Record<string, number> = {
  'classify-scheduled-verification-red.test.ts': 9,
  'assert-binned-baseline.test.ts': 3,
  'classify-baseline.test.ts': 32,
  'assert-merge-authority-baseline.test.ts': 8,
  'assert-notification-card-baseline.test.ts': 8,
  'assert-perkins-integration-review-baseline.test.ts': 5,
  'assert-repo-overview-baseline.test.ts': 4,
  'assert-restart-recovery-baseline.test.ts': 7,
  'assert-verify-keepalive-baseline.test.ts': 7,
  'assert-verification-history-baseline.test.ts': 5,
  'rate-limit-retry.test.ts': 6,
  'owner-actions.test.ts': 28,
  'property-dist-catalog.test.ts': 3,
  'property-report-cli.test.ts': 6,
  'property-resolve.test.ts': 22,
  'property-config.test.ts': 18,
  'property-metrics.test.ts': 15,
  'property-executor.test.ts': 26,
  'property-replay.test.ts': 8,
  'property-real-tool-campaign.test.ts': 9,
  'property-repair-ci.test.ts': 18,
  'property-perkins-integration.test.ts': 15,
  'property-owner-actions.test.ts': 9,
  'property-review-regressions.test.ts': 13,
  'property-qualification.test.ts': 33,
  'property-stateful-pilot.test.ts': 6,
  'property-vitest-adapter.test.ts': 26,
  'prune-stale-dist.test.ts': 7,
  'unshare-review-hardlinks.test.ts': 5,
  'admission-retry-service.test.ts': 1,
  'artifact-context.test.ts': 34,
  'attachments.test.ts': 28,

  'awareness.test.ts': 134,
  'awareness-adversarial.test.ts': 2,


  'blind-input-dispatch.test.ts': 13,
  'blind-input.test.ts': 16,
  'blind-observer-service.test.ts': 2,
  'blind-review.test.ts': 3,
  'bmad-legacy-retirement.test.ts': 5,
  'bmad-onboarding.test.ts': 13,
  'gc-bootstrap-retirement.test.ts': 6,
  'bmad-runtime-packaged.test.ts': 1,
  'bmad-runtime.test.ts': 15,
  'workflow-runtime.test.ts': 17,
  'workflow-runtime-packaged.test.ts': 2,
  'workflow-session.test.ts': 21,
  'worker-verification-policy.test.ts': 57,
  'board-engine-v4.test.ts': 9,
  'board-engine.test.ts': 47,
  'board-frames.test.ts': 4,
  'board-pipeline-view.test.ts': 2,
  'board-server.test.ts': 59,
  'bob-scheduler.test.ts': 5,
  'branch-idle-guard.test.ts': 47,
  'build-info.test.ts': 5,
  'chat-frame-log.test.ts': 20,
  'chat-frames.test.ts': 4,
  'chat-server.test.ts': 90,
  'chat-session-state.test.ts': 6,
  'claude-adapter.test.ts': 164,
  'config-generate.test.ts': 18,
  'config.test.ts': 82,
  'decisions-backtest.test.ts': 20,
  'decisions-cli.test.ts': 8,
  'decisions-deadline.test.ts': 28,
  'decisions-service-integration.test.ts': 2,
  'decisions-shadow.test.ts': 23,
  'decisions.test.ts': 89,
  'deploy-drift.test.ts': 10,
  'dispatch-e2e.test.ts': 6,
  'dispatch-joins.test.ts': 2,
  'dispatch-server.test.ts': 71,
  'docs-contracts.test.ts': 3,
  'directive-retirement.test.ts': 82,
  'fix-directive.test.ts': 41,
  'github-poll.test.ts': 40,
  'gru-mailbox.test.ts': 39,
  'report-handback-mailbox.test.ts': 31,
  'health.test.ts': 19,
  'incident.test.ts': 9,
  'identity.test.ts': 3,
  'install-one-line.test.ts': 48,
  'install.test.ts': 19,
  'intake-approval-packaged.test.ts': 2,
  'intake-approval.test.ts': 31,
  'intake-server.test.ts': 17,
  'intake.test.ts': 72,
  'job-amendments.test.ts': 11,
  'lan-phone-raw-client.test.ts': 6,
  'ledger-api.test.ts': 99,
  'ledger-pipeline.test.ts': 22,
  'ledger-db.test.ts': 10,
  'ledger-job-parent.test.ts': 5,
  'lessons-bible.test.ts': 109,
  'lessons-bible-lock.test.ts': 5,
  'lessons-capture.test.ts': 14,
  'lessons-dream.test.ts': 65,
  'lessons-dream-service.test.ts': 8,
  'lessons-e2e.test.ts': 2,
  'lessons-injection.test.ts': 8,
  'lessons-journal.test.ts': 6,
  'lessons-references.test.ts': 5,
  'lessons-server.test.ts': 12,
  'listener-probe.test.ts': 5,
  'logger.test.ts': 3,
  'managed-repositories-runtime.test.ts': 3,
  'native-tools-parity.test.ts': 2,
  'notification-decisions.test.ts': 28,
  'notifications.test.ts': 20,
  'pacing-admission.test.ts': 14,
  'pacing.test.ts': 33,
  'patch-vitest-rpc-timeout.test.ts': 11,
  'perkins-admission-preflight.test.ts': 83,
  'perkins-admission-sysctl.test.ts': 1,
  'perkins-builtin-wave.test.ts': 268,
  'perkins-checkpoint-enumeration.test.ts': 1,
  'perkins-crash-child.test.ts': 1, // skipped unless PERKINS_CRASH_CHILD is set; the parent crash test spawns it
  'perkins-findings-dedupe.test.ts': 11,
  'perkins-freeze-freshhead.test.ts': 25,
  'perkins-integration-recovery.test.ts': 14,
  'perkins-integration-review.test.ts': 13,
  'perkins-lead-schema-compat.test.ts': 6,
  'perkins-whole-review.test.ts': 141,
  'perkins-review-convergence.test.ts': 51,
  'phase-handoffs.test.ts': 13,
  'pipeline-server.test.ts': 12,
  'report-jobs-backfill.test.ts': 17,
  'pipeline-service.test.ts': 30,
  'pi-adapter.test.ts': 201,
  'pr-creation-policy.test.ts': 5,
  'provider-recovery-admission.test.ts': 4,
  'provider-recovery-classify.test.ts': 25,
  'provider-recovery-composition.test.ts': 9,
  'provider-recovery-ledger.test.ts': 18,
  'provider-recovery-metadata.test.ts': 24,
  'provider-recovery-resume.test.ts': 26,
  'provider-recovery-seam.test.ts': 17,
  'provider-recovery-sensor.test.ts': 79,
  'restart-recovery-progress.test.ts': 165,
  'restart-recovery-schema.test.ts': 3,
  'rebrief-recovery.test.ts': 93,
  'repo-overview.test.ts': 88,
  'rehearsal.test.ts': 4,
  'resident-budget.test.ts': 7,
  'resident-saturation.test.ts': 2,
  'runtime-disposal-aggregation.test.ts': 12,
  'review-build-identity.test.ts': 9,
  'review-model-identity.test.ts': 2,
  'review-git-environment.test.ts': 87,
  'review-ci-evidence.test.ts': 13,
  'review-directory-entries.test.ts': 3,
  'review-evidence-intake.test.ts': 11,
  'review-inputs-handoff.test.ts': 10,
  'review-inputs-wave.test.ts': 1,
  'review-mcp-transport.test.ts': 11,
  'stage1-baseline-scope.test.ts': 10,
  'review-runtime-swap.test.ts': 19,
  'review-source-preflight.test.ts': 13,
  'review-supersession.test.ts': 65,
  'review-path.test.ts': 26,
  'roles-definitions.test.ts': 18,
  'roles-installed-playbook.test.ts': 7,
  'roles-gru.test.ts': 6,
  'roll-cli.test.ts': 15,
  'roll-controller.test.ts': 11,
  'roll-e2e.test.ts': 1,
  'roll-server.test.ts': 7,
  'roll-state.test.ts': 7,
  'runtime-cessation-evidence.test.ts': 14,
  'runtime-probe.test.ts': 8,
  'runtime-resident-registry.test.ts': 25,
  'runtime-claude-cessation-ownership.test.ts': 6,
  'runtime-positive-cessation-ownership.test.ts': 6,
  'runtime-spawn-registration.test.ts': 17,
  'service-port-guard.test.ts': 14,
  'service-shutdown.test.ts': 6,
  'silas-deterministic-seam.test.ts': 2,
  'session-store.test.ts': 27,
  'shutdown.test.ts': 8,
  'silas-driver.test.ts': 174,
  'silas-verification-debt.test.ts': 20,
  'silas-followthrough.test.ts': 2,
  'silas-h4-checkpoint.test.ts': 3,
  'silas-model-action.test.ts': 4,
  'silas-rules.test.ts': 10,
  'silas-autopilot.test.ts': 102,
  'silas-preservation-reference.test.ts': 12,
  'smoke-claude.test.ts': 1,
  'smoke-real-model.test.ts': 1,
  'spawn-backoff.test.ts': 5,
  'spec-rulings-drift.test.ts': 5,
  'specialist-dispose-bounded.test.ts': 2,
  'static.test.ts': 10,
  'stub-runtime.test.ts': 14,
  'suite-shape.test.ts': 5,
  'supervisor.test.ts': 218,
  'tool-heartbeat.test.ts': 2,
  'transcripts.test.ts': 16,
  'uploads-dir.test.ts': 3,
  'verification-evidence.test.ts': 13,
  'verification-build-reuse.test.ts': 29,
  'verification-scheduler.test.ts': 54,
  'verification-server.test.ts': 45,
  'verify-perkins-resource.test.ts': 3,
  'wake-e2e.test.ts': 4,
  'wake-policy.test.ts': 20,
  'wizard-interactive.test.ts': 18,
  'wizard-register.test.ts': 2,
  'wizard.test.ts': 36,
  'worktree-manager.test.ts': 73,
  'worktree-manifest.test.ts': 11,
  'worktree-port.test.ts': 4,
  'worktrees-server.test.ts': 8,
  'yield-report.test.ts': 55,
  'assert-formal-verdicts-baseline.test.ts': 5,
  'publication-evidence.test.ts': 13,
  'board-runtime-truth.test.ts': 14,
  'child-workers.test.ts': 32,
  'directive-markers.test.ts': 14,
  'escalation-identity.test.ts': 7,
  'dispatch-review-inputs.test.ts': 4,
  'durable-reconcile.test.ts': 13,
  'fixture-repo-origin.test.ts': 1,
  'harness-diagnostics.test.ts': 18,
  'harness-routing.test.ts': 3,
  'ledger-obligations.test.ts': 30,
  'obligations-handback.test.ts': 9,
  'perkins-github-app.test.ts': 175,
  'prompt-verdict.test.ts': 6,
  'test-budgets.test.ts': 10,
  'tool-call-policy.test.ts': 12,
  'verification-capture.test.ts': 36,

};

describe('suite shape', () => {
  it('runs the full PR gate on the default merge-result checkout', () => {
    const workflow = readFileSync(join(import.meta.dirname, '..', '.github', 'workflows', 'ci.yml'), 'utf-8');
    // The gate still runs on the default merge-result checkout — checkout@v6
    // with the full history as its ONLY option (so no `ref:`/head-sha
    // override), immediately followed by setup-node@v6. The history is
    // required: the App contract baseline scope (#190) archives the
    // immutable pre-repair commit fe6a774 through a shared clone of this
    // checkout, which a shallow fetch leaves absent.
    expect(workflow).toMatch(/- uses: actions\/checkout@v6\n\s+with:\n\s+fetch-depth: 0\n\s*- uses: actions\/setup-node@v6/);
    expect(workflow).not.toContain('github.event.pull_request.head.sha');
    expect(workflow).toContain('run: npm test');
  });

  it('the SLIM baseline scope names every independently measured instrument surface', () => {
    const worktree = readFileSync(join(import.meta.dirname, '..', '.gru-command', 'worktree.toml'), 'utf-8');
    const line = worktree.split('\n').find((candidate) => candidate.startsWith('dashboard-slim-strip-baseline = '));
    const allowlist = /--require-file-substr "([^"]+)"/u.exec(line ?? '')?.[1]?.split(',') ?? [];
    expect(allowlist).toEqual([
      'slim strip labelled status pairs',
      'slim strip Heists/PRs/Crew count groups',
      'reserved numeric slot for strip KPIs',
    ]);
  });

  it('distinguishes unsupported R2 shell wrappers from inert shell text', () => {
    expect(r2ShellSyntaxIssues('read value <<< "$input"\nprintf "%s" "<<EOF" # << comment')).toEqual([]);
    expect(r2ShellSyntaxIssues("printf '%s' '<<EOF' # << comment")).toEqual([]);
    expect(r2ShellSyntaxIssues('cat <<EOF\nfalse\nEOF')).toContain('heredoc');
    expect(r2ShellSyntaxIssues('value=$((1 << 2))')).not.toContain('heredoc');
    expect(r2ShellSyntaxIssues('printf "\u{1F680}" <<EOF')).toContain('heredoc');
    expect(r2ShellSyntaxIssues(String.raw`printf '%s' "$(false; if false; then :; fi)"`)).toContain('double-quoted command substitution');
    expect(r2ShellSyntaxIssues(String.raw`printf '%s' "$(cat <<EOF)"`)).toContain('double-quoted command substitution');
    expect(r2ShellSyntaxIssues('( if false; then')).toContain('shell group');
    expect(r2ShellSyntaxIssues('false; if false; then')).toContain('inline control flow');
    expect(r2ShellSyntaxIssues(String.raw`echo foo\ #; if false; then :; fi`)).toContain('inline control flow');
    const continuedLine = ['false; \\', 'if false; then :; fi'].join('\n');
    expect(r2ShellSyntaxIssues(continuedLine)).toContain('line continuation');
    const continuedComment = ['echo foo\\', '#; if false; then :; fi'].join('\n');
    expect(r2ShellSyntaxIssues(continuedComment)).toContain('line continuation');
    expect(r2ShellSyntaxIssues('{ function helper() {')).toContain('function definition');
    expect(r2ShellSyntaxIssues('if test; then ( cd snapshot ); fi')).toContain('shell group');
    const substitutionLines = analyzeR2ShellSource('setup=$(\n  git show target:file\n)').codeLines;
    expect(shellCommandSubstitutionDepthAt(substitutionLines, 1)).toBe(1);
  });

  it('keeps formal fail-before registration guards aligned with suite pins', () => {
    const tools = join(import.meta.dirname, '..', 'tools');
    const wavePin = PINS['perkins-builtin-wave.test.ts'];
    const dispatchPin = PINS['dispatch-server.test.ts'];
    const silasPin = PINS['silas-driver.test.ts'];
    for (const script of ['formal-verdicts-r2-baseline.sh', 'formal-verdicts-r3-baseline.sh']) {
      const source = readFileSync(join(tools, script), 'utf-8');
      expect(source, `${script}: wave registration guard is stale`).toContain(`perkins-builtin-wave.test.ts:${wavePin}`);
      expect(source, `${script}: Silas registration guard is stale`).toContain(`silas-driver.test.ts:${silasPin}`);
      if (script === 'formal-verdicts-r2-baseline.sh') {
        expect(source, 'R2 baseline filter omits the receipt-only consumer regression')
          .toContain('test/silas-driver.test.ts -t "native R2|uncredited receipt without its publication attempt"');
        expect(source, 'R2 baseline classifier omits the receipt-only consumer regression')
          .toContain('silas digest (the four actionable states) does not offer a clean-abort re-arm for an uncredited receipt without its publication attempt');
        expect(source, 'R2 baseline must retain the historical helper implementation')
          .toContain('git show "$base:src/dispatch/publication-evidence.ts"');
        const baselineOverlayMatches = [...source.matchAll(/^for f in ([\s\S]+?); do$/gmu)];
        expect(baselineOverlayMatches, 'R2 baseline overlay loop is missing or ambiguous').toHaveLength(1);
        const baselineOverlayList = baselineOverlayMatches[0]?.[1];
        expect(baselineOverlayList, 'R2 baseline overlay file list is missing').toBeDefined();
        if (baselineOverlayList === undefined) throw new Error('R2 baseline overlay file list is missing');
        const baselineOverlayFiles = baselineOverlayList.split(/\s+/u);
        expect(baselineOverlayFiles, 'R2 baseline overlays the current helper and masks the fail-before behavior')
          .not.toContain('src/dispatch/publication-evidence.ts');
        expect(source, 'R2 baseline directly copies the current helper into the snapshot')
          .not.toContain('git show "$headrev:src/dispatch/publication-evidence.ts" > "$d/src/dispatch/publication-evidence.ts"');
        expect(source, 'R2 baseline does not derive the compatibility marker from the pinned source')
          .toContain('git show "$headrev:src/dispatch/publication-evidence.ts"');
        expect(source, 'R2 baseline hardcodes rather than emits the derived identity event')
          .toContain("export const PUBLICATION_IDENTITY_EVENT = '%s';");
        expect(source, 'R2 baseline does not append the derived identity event')
          .toContain('"$identity_event" >> "$d/src/dispatch/publication-evidence.ts"');
        const baselineLines = source.split(/\r?\n/u);
        const baselineAnalysis = analyzeR2ShellSource(source);
        const baselineCodeLines = baselineAnalysis.codeLines;
        expect(baselineAnalysis.issues, 'R2 baseline must keep a simple, top-level shell setup contract').toEqual([]);
        const uniqueExecutableLine = (command: string, label: string): number => {
          const matches = baselineLines.flatMap((line, index) => line.trim() === command ? [index] : []);
          expect(matches, `R2 baseline ${label} command must occur exactly once as a whole line`).toHaveLength(1);
          const line = matches[0];
          if (line === undefined) throw new Error(`R2 baseline ${label} command is missing or ambiguous`);
          return line;
        };
        const historicalHelperCopy = uniqueExecutableLine(
          'git show "$base:src/dispatch/publication-evidence.ts" > "$d/src/dispatch/publication-evidence.ts"',
          'historical helper copy',
        );
        const changeToSnapshot = uniqueExecutableLine('cd "$d"', 'change to archived snapshot');
        const identityEventAppend = uniqueExecutableLine(
          String.raw`printf "\\n/** Test-fixture compatibility marker; keep base helper behavior. */\\nexport const PUBLICATION_IDENTITY_EVENT = '%s';\\n" "$identity_event" >> "$d/src/dispatch/publication-evidence.ts"`,
          'identity event append',
        );
        expect(shellControlDepthAt(baselineCodeLines, historicalHelperCopy), 'R2 baseline historical helper copy is in a shell control-flow block').toBe(0);
        expect(shellControlDepthAt(baselineCodeLines, changeToSnapshot), 'R2 baseline snapshot change is in a shell control-flow block').toBe(0);
        expect(shellCommandSubstitutionDepthAt(baselineCodeLines, changeToSnapshot), 'R2 baseline snapshot change is inside a command substitution').toBe(0);
        expect(shellCommandSubstitutionDepthAt(baselineCodeLines, historicalHelperCopy), 'R2 baseline historical helper copy is inside a command substitution').toBe(0);
        expect(identityEventAppend, 'R2 baseline appends the identity event before the historical helper copy')
          .toBeGreaterThan(historicalHelperCopy);
        expect(shellControlDepthAt(baselineCodeLines, identityEventAppend), 'R2 baseline identity append is in a shell control-flow block').toBe(0);
        expect(shellCommandSubstitutionDepthAt(baselineCodeLines, identityEventAppend), 'R2 baseline identity append is inside a command substitution').toBe(0);
      }
    }
    const r5 = readFileSync(join(tools, 'formal-verdicts-r5-baseline.sh'), 'utf-8');
    expect(r5, 'formal-verdicts-r5-baseline.sh: wave registration guard is stale').toContain(`perkins-builtin-wave.test.ts:${wavePin}`);
    const r6 = readFileSync(join(tools, 'formal-verdicts-r6-baseline.sh'), 'utf-8');
    expect(r6, 'formal-verdicts-r6-baseline.sh: dispatch registration guard is stale').toContain(`registered" != ${dispatchPin}`);
    const rev3 = readFileSync(join(tools, 'formal-verdicts-rev3-baseline.sh'), 'utf-8');
    expect(rev3, 'formal-verdicts-rev3-baseline.sh: dispatch registration guard is stale').toContain(`dispatch-server.test.ts:${dispatchPin}`);
    expect(rev3, 'formal-verdicts-rev3-baseline.sh: Silas registration guard is stale').toContain(`silas-driver.test.ts:${silasPin}`);
  });

  it('every test file is pinned and registers exactly its expected test count', () => {
    const dir = import.meta.dirname;
    const files = readdirSync(dir)
      .filter((name) => name.endsWith('.test.ts'))
      .sort();
    expect(files).toEqual(Object.keys(PINS).sort());
    for (const file of files) {
      const source = readFileSync(join(dir, file), 'utf-8');
      expect(source, `${file}: parameterized cases evade the static suite pin; register explicit cases`).not.toMatch(
        /\b(?:it|test|describe)\.each\(/,
      );
      const registered = (source.match(/\bit\(|\bit\.skipIf\(/g) ?? []).length;
      const pinned = PINS[file] ?? -1;
      expect(
        registered,
        `${file}: registered ${registered} tests, pin says ${pinned === -1 ? 'UNPINNED' : pinned}`,
      ).toBe(pinned);
    }
  });
});
