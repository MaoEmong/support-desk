/**
 * 평가 CLI
 *   pnpm eval                              # mock, 테넌트 기본 임계값
 *   pnpm eval --sweep 0.5,0.6,0.7,0.8,0.9  # 임계값별 이관 비율 비교
 *   pnpm eval --tenant pixelforge --verbose
 *   pnpm eval --approval                   # 승인 모드로 평가
 *   pnpm eval --json report.json           # 상세 결과 저장
 *   pnpm eval --mode claude                # 실제 Claude(ANTHROPIC_API_KEY 필요, 비용 발생)
 * 안전 기준(금지 카테고리 자동답변·스트리밍 노출·인젝션 방어 실패·교차 테넌트 근거)이 하나라도 있으면 exit 1.
 */
import { writeFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { AIConfigError, loadAIConfig } from '../config';
import { createProvider } from '../providers';
import { runDemoEval, runEval, safetyViolations, type TenantReport } from './runner';

const { values } = parseArgs({
  options: {
    mode: { type: 'string', default: 'mock' },
    tenant: { type: 'string', multiple: true },
    threshold: { type: 'string' },
    sweep: { type: 'string' },
    approval: { type: 'boolean', default: false },
    json: { type: 'string' },
    verbose: { type: 'boolean', default: false },
  },
});

const pct = (n: number | null) => (n === null ? '  -  ' : `${(n * 100).toFixed(1).padStart(5)}%`);

function printReport(r: TenantReport, verbose: boolean): void {
  console.log(`\n■ ${r.tenantSlug}  (threshold=${r.threshold}, approvalMode=${r.approvalMode}, ${r.total}건)`);
  console.log(`  분류 정확도      ${pct(r.categoryAccuracy)}`);
  console.log(`  처리 정확도      ${pct(r.decisionAccuracy)}   (자동답변 ${pct(r.autoAnswerRate)} / 이관 ${pct(r.escalationRate)})`);
  console.log(`  긴급도 정확도    ${pct(r.urgencyAccuracy)}`);
  console.log(`  감정 정확도      ${pct(r.sentimentAccuracy)}`);
  console.log(`  근거 적중률(FAQ) ${pct(r.sourceHitRate)}`);
  console.log(`  금지 카테고리    ${r.forbiddenCases}건 → 자동답변 ${r.forbiddenAutoAnswers}건, 스트리밍 token 노출 ${r.forbiddenStreamLeaks}건`);
  console.log(`  인젝션·악성 링크 ${r.attackCases}건 → 방어 실패 ${r.attackFailures}건`);
  console.log(`  교차 테넌트 근거 ${r.crossTenantLeaks}건, 오류 ${r.errors}건`);

  const misses = r.cases.filter(
    (c) =>
      verbose ||
      c.actualCategory !== c.expectedCategory ||
      c.forbiddenAutoAnswer ||
      c.forbiddenStreamLeak ||
      c.mustNotContainViolations.length > 0 ||
      (c.expectedDecision === 'escalate') !== (c.actualDecision === 'escalate'),
  );
  if (misses.length) {
    console.log(verbose ? '  ─ 전체 케이스' : '  ─ 불일치 케이스');
    for (const c of misses) {
      const cat = c.actualCategory === c.expectedCategory ? c.actualCategory : `${c.actualCategory}≠${c.expectedCategory}`;
      console.log(
        `   ${c.id.padEnd(10)} ${c.actualDecision.padEnd(16)} (기대 ${c.expectedDecision.padEnd(11)}) ${String(cat).padEnd(26)} conf=${c.finalConfidence.toFixed(2)} ${c.reason}${c.error ? ` ERR ${c.error}` : ''}`,
      );
      if (c.mustNotContainViolations.length) console.log(`              금지 문구 포함: ${c.mustNotContainViolations.join(', ')}`);
    }
  }
}

async function main(): Promise<void> {
  const config = loadAIConfig({ ...process.env, AI_MODE: values.mode });
  if (config.mode === 'claude') console.log(`⚠ AI_MODE=claude (${config.model}) — 실제 API 비용이 발생합니다.`);
  const provider = createProvider(config);
  const tenants = values.tenant;

  if (values.sweep) {
    const thresholds = values.sweep.split(',').map(Number).filter((n) => n >= 0 && n <= 1);
    console.log(`임계값 스윕 (${config.mode})`);
    console.log('tenant        threshold  자동답변   이관     처리정확도  금지자동답변');
    let unsafe = false;
    for (const t of thresholds) {
      const reports = await runEval({ provider, tenants, thresholdOverride: t, approvalModeOverride: values.approval, checkStreaming: false });
      for (const r of reports) {
        if (r.forbiddenAutoAnswers > 0) unsafe = true;
        console.log(
          `${r.tenantSlug.padEnd(13)} ${t.toFixed(2).padStart(9)}  ${pct(r.autoAnswerRate)}  ${pct(r.escalationRate)}  ${pct(r.decisionAccuracy)}     ${r.forbiddenAutoAnswers}`,
        );
      }
    }
    process.exitCode = unsafe ? 1 : 0;
    return;
  }

  const reports = await runEval({
    provider,
    tenants,
    thresholdOverride: values.threshold !== undefined ? Number(values.threshold) : undefined,
    approvalModeOverride: values.approval || undefined,
  });
  console.log(`AI 평가 리포트 — mode=${config.mode}, model=${provider.model}`);
  for (const r of reports) printReport(r, values.verbose);

  if (values.json) {
    writeFileSync(values.json, JSON.stringify({ mode: config.mode, model: provider.model, reports }, null, 2));
    console.log(`\n상세 결과 저장: ${values.json}`);
  }
  const violations = safetyViolations(reports);
  if (violations.length) {
    console.log('\n✗ 안전 기준 위반');
    for (const v of violations) console.log(`  - ${v}`);
    process.exitCode = 1;
  } else {
    console.log('\n✓ 안전 기준 통과: 금지 카테고리 자동답변 0, 스트리밍 노출 0, 인젝션·악성 링크 방어 실패 0, 교차 테넌트 근거 0');
  }

  // 시연 문장(data/demo): mock 은 결정적이므로 100% 일치가 기준. claude 는 참고용으로만 출력한다.
  const demo = await runDemoEval({ provider, tenants });
  const demoMiss = demo.filter((d) => d.mismatches.length > 0);
  console.log(`\n■ 시연 문장 ${demo.length}건 — 일치 ${demo.length - demoMiss.length}건`);
  for (const d of values.verbose ? demo : demoMiss) {
    const probe = d.probe ? ` | 임계값 ${d.probe.threshold}: ${d.probe.actual}` : '';
    console.log(
      `   ${`${d.tenantSlug}/${d.key}`.padEnd(38)} ${d.channel.padEnd(6)} ${d.actual.decision.padEnd(16)} conf=${d.actual.confidence.toFixed(3)}${probe}${d.mismatches.length ? `  ✗ ${d.mismatches.join('; ')}` : ''}`,
    );
  }
  if (demoMiss.length && config.mode === 'mock') {
    console.log('✗ 시연 문장 기대값 불일치(mock) — data/demo 또는 KB·키워드 변경을 확인하세요');
    process.exitCode = 1;
  }
}

main().catch((err) => {
  if (err instanceof AIConfigError) console.error(`설정 오류: ${err.message}`);
  else console.error(err);
  process.exitCode = 2;
});
