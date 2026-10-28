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
  'classify-scheduled-verification-red.test.ts': 21,
  'assert-binned-baseline.test.ts': 3,
  'classify-baseline.test.ts': 32,
  'assert-merge-authority-baseline.test.ts': 8,
  'assert-notification-card-baseline.test.ts': 8,
  'assert-perkins-integration-review-baseline.test.ts': 11,
  'assert-repo-overview-baseline.test.ts': 4,
  'assert-restart-recovery-baseline.test.ts': 11,
  'assert-verify-keepalive-baseline.test.ts': 7,
  'assert-verification-history-baseline.test.ts': 5,
  'rate-limit-retry.test.ts': 6,
  'onboarding-origin.test.ts': 7,
  'onboarding-service.test.ts': 29,
  'onboarding-real-service.test.ts': 1,
  'onboarding-proof.test.ts': 147,
  'redaction.test.ts': 14,
  'owner-actions.test.ts': 28,
  'property-dist-catalog.test.ts': 3,
  'property-report-cli.test.ts': 6,
  'property-resolve.test.ts': 22,
  'property-config.test.ts': 19,
  'property-metrics.test.ts': 15,
  'property-executor.test.ts': 43,
  'property-replay.test.ts': 8,
  'property-real-tool-campaign.test.ts': 10,
  'property-repair-ci.test.ts': 21,
  'property-perkins-integration.test.ts': 15,
  'property-overlay-restore.test.ts': 7,
  'property-error-text.test.ts': 2,
  'property-owner-actions.test.ts': 17,
  'property-review-regressions.test.ts': 13,
  'property-qualification.test.ts': 33,
  'property-stateful-pilot.test.ts': 6,
  'property-vitest-adapter.test.ts': 27,
  'prune-stale-dist.test.ts': 7,
  'unshare-review-hardlinks.test.ts': 5,
  'admission-retry-service.test.ts': 1,
  'artifact-context.test.ts': 34,
  'attachments.test.ts': 28,

  'awareness.test.ts': 151,
  'awareness-adversarial.test.ts': 2,


  'briefing-review.test.ts': 26,
  'briefing-review-board.test.ts': 4,
  'briefing-review-server.test.ts': 6,
  'blind-input-dispatch.test.ts': 27,
  'blind-input.test.ts': 34,
  'blind-observer-service.test.ts': 2,
  'blind-review.test.ts': 18,
  'bmad-legacy-retirement.test.ts': 5,
  'bmad-onboarding.test.ts': 13,
  'gc-bootstrap-retirement.test.ts': 6,
  'bmad-runtime-packaged.test.ts': 1,
  'bmad-runtime.test.ts': 15,
  'workflow-runtime.test.ts': 20,
  'workflow-runtime-packaged.test.ts': 2,
  'workflow-session.test.ts': 21,
  'worker-verification-policy.test.ts': 57,
  'board-engine-v4.test.ts': 9,
  'board-engine.test.ts': 49,
  'board-frames.test.ts': 5,
  'board-pipeline-view.test.ts': 2,
  'board-server.test.ts': 62,
  'bob-state-service.test.ts': 1,
  'bob-scheduler.test.ts': 19,
  'branch-idle-guard.test.ts': 48,
  'build-info.test.ts': 6,
  'chat-frame-log.test.ts': 20,
  'chat-frames.test.ts': 4,
  'chat-server.test.ts': 94,
  'chat-session-state.test.ts': 6,
  'claude-adapter.test.ts': 296,
  'claude-directive.test.ts': 27,
  'claude-review-isolation.test.ts': 4,
  'config-env-service.test.ts': 2,
  'config-env.test.ts': 25,
  'config-generate.test.ts': 27,
  'config.test.ts': 88,
  'creation-continuation-custody.test.ts': 40,
  'creation-continuation.test.ts': 16,
  'decisions-backtest.test.ts': 20,
  'decisions-cli.test.ts': 8,
  'decisions-deadline.test.ts': 28,
  'decisions-service-integration.test.ts': 2,
  'decisions-shadow.test.ts': 29,
  'decisions.test.ts': 101,
  'default-branch-ci.test.ts': 39,
  'deploy-drift.test.ts': 22,
  'dispatch-e2e.test.ts': 6,
  'dispatch-joins.test.ts': 2,
  'dispatch-server.test.ts': 80,
  'docs-contracts.test.ts': 6,
  'directive-producer-inspection.test.ts': 2,
  'directive-retirement.test.ts': 108,
  'directive-retry-history.test.ts': 41,
  'directive-transcript-bounds.test.ts': 32,
  'fix-directive.test.ts': 60,
  'github-poll.test.ts': 45,
  'gru-cli.test.ts': 12,
  'gru-mailbox.test.ts': 39,
  'report-artifact-handback.test.ts': 9,
  'report-handback-mailbox.test.ts': 31,
  'health.test.ts': 19,
  'incident.test.ts': 12,
  'identity.test.ts': 3,
  'install-one-line.test.ts': 53,
  'install.test.ts': 28,
  'intake-approval-packaged.test.ts': 2,
  'intake-approval.test.ts': 31,
  'intake-breakdown.test.ts': 42,
  'intake-server.test.ts': 19,
  'intake-slicing.test.ts': 18,
  'intake.test.ts': 73,
  'job-amendments.test.ts': 11,
  'job-stop.test.ts': 16,
  'lan-phone-raw-client.test.ts': 6,
  'lane-lifecycle.test.ts': 111,
  'lane-provenance.test.ts': 22,
  'cleanup-repair.test.ts': 41,
  'disk-budget.test.ts': 39,
  'ledger-api.test.ts': 102,
  'ledger-pipeline.test.ts': 22,
  'ledger-db.test.ts': 12,
  'ledger-job-parent.test.ts': 5,
  'lessons-bible.test.ts': 109,
  'line-safe.test.ts': 2,
  'lessons-bible-lock.test.ts': 5,
  'lessons-capture.test.ts': 14,
  'lessons-dream.test.ts': 65,
  'lessons-dream-service.test.ts': 8,
  'lessons-e2e.test.ts': 2,
  'lessons-injection.test.ts': 9,
  'lessons-journal.test.ts': 6,
  'lessons-references.test.ts': 5,
  'lessons-server.test.ts': 12,
  'listener-probe.test.ts': 5,
  'logger.test.ts': 8,
  'managed-repositories-runtime.test.ts': 4,
  'native-tools-parity.test.ts': 2,
  'notification-decisions.test.ts': 28,
  'notifications.test.ts': 20,
  'pacing-admission.test.ts': 14,
  'pacing.test.ts': 40,
  'patch-vitest-rpc-timeout.test.ts': 11,
  'perkins-admission-preflight.test.ts': 86,
  'perkins-admission-sysctl.test.ts': 1,
  'perkins-builtin-wave.test.ts': 292,
  'perkins-checkpoint-enumeration.test.ts': 1,
  'perkins-crash-child.test.ts': 1, // skipped unless PERKINS_CRASH_CHILD is set; the parent crash test spawns it
  'perkins-findings-dedupe.test.ts': 11,
  'perkins-freeze-freshhead.test.ts': 25,
  'perkins-group-liveness-ps.test.ts': 3,
  'perkins-integration-recovery.test.ts': 14,
  'perkins-integration-review.test.ts': 15,
  'perkins-lead-schema-compat.test.ts': 6,
  'perkins-whole-review.test.ts': 149,
  'perkins-review-convergence.test.ts': 59,
  'perkins-review-symlinks.test.ts': 16,
  'phase-handoffs.test.ts': 14,
  'pipeline-server.test.ts': 12,
  'report-jobs-backfill.test.ts': 17,
  'pipeline-service.test.ts': 31,
  'pi-adapter.test.ts': 284,
  'pi-gemini-thinking-level.test.ts': 1,
  'pr-creation-policy.test.ts': 5,
  'prebootstrap-patch.test.ts': 46,
  'provider-recovery-admission.test.ts': 4,
  'provider-recovery-classify.test.ts': 25,
  'provider-recovery-composition.test.ts': 9,
  'provider-recovery-ledger.test.ts': 18,
  'provider-recovery-metadata.test.ts': 24,
  'provider-recovery-resume.test.ts': 30,
  'provider-recovery-seam.test.ts': 17,
  'provider-recovery-sensor.test.ts': 92,
  'restart-recovery-progress.test.ts': 235,
  'restart-recovery-schema.test.ts': 4,
  'rebrief-recovery.test.ts': 100,
  'repo-overview.test.ts': 97,
  'repo-overview-gitlab.test.ts': 29,
  'repo-overview-glab-runner.test.ts': 1,
  'rehearsal.test.ts': 4,
  'release-version.test.ts': 10,
  'resident-budget.test.ts': 7,
  'resident-saturation.test.ts': 2,
  'runtime-disposal-aggregation.test.ts': 12,
  'review-build-identity.test.ts': 9,
  'review-model-identity.test.ts': 2,
  'review-git-environment.test.ts': 98,
  'review-ci-evidence.test.ts': 13,
  'review-directory-entries.test.ts': 3,
  'review-evidence-intake.test.ts': 11,
  'review-inputs-handoff.test.ts': 10,
  'review-inputs-wave.test.ts': 1,
  'review-mcp-transport.test.ts': 18,
  'stage1-baseline-scope.test.ts': 11,
  'review-runtime-swap.test.ts': 22,
  'review-source-preflight.test.ts': 13,
  'review-supersession.test.ts': 68,
  'review-owner-cessation.test.ts': 27,
  'review-path.test.ts': 26,
  'roles-definitions.test.ts': 18,
  'roles-installed-playbook.test.ts': 7,
  'roles-gru.test.ts': 7,
  'roll-cli.test.ts': 28,
  'roll-controller.test.ts': 14,
  'roll-e2e.test.ts': 1,
  'roll-server.test.ts': 8,
  'roll-state.test.ts': 7,
  'runtime-cessation-evidence.test.ts': 19,
  'runtime-parity.test.ts': 10,
  'runtime-probe.test.ts': 8,
  'runtime-resident-registry.test.ts': 28,
  'runtime-claude-cessation-ownership.test.ts': 9,
  'runtime-positive-cessation-ownership.test.ts': 6,
  'runtime-spawn-registration.test.ts': 17,
  'service-port-guard.test.ts': 14,
  'service-shutdown.test.ts': 15,
  'silas-deterministic-seam.test.ts': 2,
  'session-store.test.ts': 85,
  'shutdown.test.ts': 8,
  'silas-driver.test.ts': 176,
  'silas-verification-debt.test.ts': 27,
  'silas-followthrough.test.ts': 2,
  'silas-h4-checkpoint.test.ts': 3,
  'silas-model-action.test.ts': 10,
  'silas-rules.test.ts': 11,
  'silas-autopilot.test.ts': 112,
  'silas-preservation-reference.test.ts': 31,
  'silas-preservation-swap.test.ts': 10,
  'smoke-claude.test.ts': 3,
  'smoke-real-model.test.ts': 1,
  'spawn-backoff.test.ts': 5,
  'spec-rulings-drift.test.ts': 5,
  'specialist-dispose-bounded.test.ts': 2,
  'static.test.ts': 10,
  'stub-runtime.test.ts': 14,
  'suite-shape.test.ts': 6,
  'supervisor.test.ts': 243,
  'tool-heartbeat.test.ts': 2,
  'transcripts.test.ts': 18,
  'uploads-dir.test.ts': 6,
  'vector-attack.test.ts': 7,
  'vector-raid-runner.test.ts': 37,
  'vector-raids.test.ts': 37,
  'verdict-publication-identity.test.ts': 18,
  'verification-build-reuse.test.ts': 32,
  'verification-evidence.test.ts': 13,
  'verification-scheduler.test.ts': 58,
  'verification-server.test.ts': 50,
  'verify-perkins-resource.test.ts': 3,
  'wake-e2e.test.ts': 4,
  'wake-policy.test.ts': 24,
  'wizard-interactive.test.ts': 22,
  'wizard-register.test.ts': 2,
  'wizard.test.ts': 37,
  'worktree-handoff-layouts.test.ts': 20,
  'worktree-manager.test.ts': 94,
  'worktree-manifest.test.ts': 16,
  'worktree-port.test.ts': 4,
  'worktrees-server.test.ts': 9,
  'yield-report.test.ts': 55,
  'assert-formal-verdicts-baseline.test.ts': 5,
  'publication-evidence.test.ts': 13,
  'board-runtime-truth.test.ts': 14,
  'child-workers.test.ts': 36,
  'creation-intent.test.ts': 5,
  'directive-markers.test.ts': 15,
  'escalation-identity.test.ts': 7,
  'dispatch-review-inputs.test.ts': 4,
  'durable-reconcile.test.ts': 15,
  'fixture-repo-origin.test.ts': 1,
  'harness-diagnostics.test.ts': 18,
  'harness-routing.test.ts': 3,
  'ledger-obligations.test.ts': 30,
  'obligations-handback.test.ts': 9,
  'perkins-github-app.test.ts': 177,
  'prompt-verdict.test.ts': 6,
  'test-budgets.test.ts': 10,
  'tool-call-policy.test.ts': 12,
  'verification-capture.test.ts': 47,

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

  it('the cockpit scopes replace the retired slim-strip ones', () => {
    // The slim strip and its fail-before instrument were retired by the
    // cockpit rework: no scope, script, Playwright project or workflow may
    // still run them, and the cockpit's own unit and browser scopes exist.
    const root = join(import.meta.dirname, '..');
    const workflows = join(root, '.github', 'workflows');
    const runners = [
      join(root, '.gru-command', 'worktree.toml'),
      join(root, 'package.json'),
      join(root, 'web', 'package.json'),
      join(root, 'web', 'playwright.config.ts'),
      ...readdirSync(workflows).map((name) => join(workflows, name)),
    ];
    // Any spelling of the retired project or scopes: `--project=strip`,
    // `--project strip`, quoted values, a `name: "strip"` project, or a
    // bare or quoted `strip-*` scope key.
    const retired = /slim-strip\.baseline\.test\.ts|dashboard-strip\.spec\.ts|board-rail\.test\.ts|--project[= ]['"]?strip(?![\w-])|name: ['"]strip['"]|^['"]?strip-[\w-]+['"]? =/mu;
    for (const file of runners) expect(readFileSync(file, 'utf-8'), file).not.toMatch(retired);
    for (const spelling of ['--project=strip', '--project strip', '--project="strip"', "name: 'strip'", 'name: "strip"', 'strip-smoke = "x"', '"strip-themes" = "x"']) {
      expect(spelling, spelling).toMatch(retired);
    }
    for (const kept of ['--project=strip-free', '--project=cockpit', "name: 'stripes'", 'cockpit-themes = "x"']) expect(kept, kept).not.toMatch(retired);
    const worktree = readFileSync(runners[0]!, 'utf-8');
    expect(worktree).toMatch(/^cockpit-unit = .*src\/lib\/cockpit\.test\.ts/mu);
    expect(worktree).toMatch(/^cockpit-browser = .*--project=cockpit e2e\/cockpit\.spec\.ts/mu);
  });

  it('every web e2e spec runs in some Playwright project (a moved spec never silently stops running)', () => {
    const web = join(import.meta.dirname, '..', 'web');
    const config = readFileSync(join(web, 'playwright.config.ts'), 'utf-8');
    const matched = new Set([...config.matchAll(/'([\w.-]+\.spec\.ts)'/gu)].map((match) => match[1]));
    const specs = readdirSync(join(web, 'e2e')).filter((name) => name.endsWith('.spec.ts'));
    expect(specs.length).toBeGreaterThan(0);
    for (const spec of specs) expect(matched, spec).toContain(spec);
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
