/**
 * ADR-76 诊断工具集 — 行为验证自动化。
 *
 * 从现有 DB 数据计算行为指标，验证理论预测。
 *
 * @see docs/adr/76-naturalness-validation-methodology.md
 */

export {
  type ActionClosureLegacyClass,
  type ActionClosureLegacyRow,
  type ActionClosureOptions,
  type ActionClosureReport,
  type ActionClosureStructuredClass,
  type ActionClosureStructuredRow,
  analyzeActionClosure,
  renderActionClosureDiagnostic,
} from "./action-closure.js";
export { type CounterfactualD5Report, counterfactualD5 } from "./counterfactual.js";
export { type DcpPromptCompareOptions, renderDcpPromptCompare } from "./dcp-prompt-compare.js";
export { type DcpReplayDiagnosticOptions, renderDcpReplayDiagnostic } from "./dcp-replay.js";
export {
  type DecisionTraceDiagnosticOptions,
  renderDecisionTraceDiagnostic,
} from "./decision-trace.js";
export { analyzeVoiceDiversity, type VoiceDiversityReport } from "./diversity.js";
export {
  analyzeExecutionConversion,
  type ExecutionConversionReport,
  renderExecutionConversionReport,
} from "./execution-conversion.js";
export {
  analyzeP4ThreadLifecycle,
  type P4ThreadLifecycleItem,
  type P4ThreadLifecycleReport,
  renderP4ThreadLifecycleReport,
} from "./p4-thread-lifecycle.js";
export { analyzeRhythm, type RhythmReport } from "./rhythm.js";
export { analyzeSilenceQuality, type SilenceQualityReport } from "./silence-quality.js";
export {
  analyzeSocialCaseCandidates,
  analyzeSocialCases,
  buildSocialCasePressureShadows,
  renderSocialCaseDiagnosticReport,
  type SocialCaseCandidateDiagnostic,
  type SocialCaseCandidateDiagnosticReport,
  type SocialCaseDiagnosticRenderOptions,
  type SocialCaseDiagnosticReport,
  type SocialCasePressureShadow,
} from "./social-case.js";
export {
  analyzeSocialCaseThreadContrast,
  renderSocialCaseThreadContrastDiagnostic,
  type SocialCaseThreadContrastClass,
  type SocialCaseThreadContrastItem,
  type SocialCaseThreadContrastOptions,
  type SocialCaseThreadContrastReport,
  type SocialCaseThreadRow,
} from "./social-case-thread-contrast.js";
export {
  buildTargetReceptionProjections,
  renderTargetControlProjectionDiagnostic,
  type TargetControlProjectionOptions,
  type TargetReceptionProjection,
} from "./target-control-projection.js";
