import { replaceOnce } from './patch-util.mjs';

// Auto-compaction prices its threshold from the routed model's cache discount
// (plugins/compaction/threshold.mjs) unless the deployment configured one.
export function patchCompactionBasic(text) {
  const marker = '// dscode-compaction-threshold-v1';
  if (text.includes(marker)) return text;
  text = replaceOnce(text, 'import z from "@deepseek-ai/schemastery";', 'import { pricedCompactionPolicy as dscodePricedCompactionPolicy } from "../../../../plugins/compaction/threshold.mjs";\nimport z from "@deepseek-ai/schemastery";');
  text = replaceOnce(text, '\treturn deepFreeze({\n\t\tthresholdRatio,\n', '\treturn deepFreeze({\n\t\tthresholdRatio,\n\t\tdscodePricedThreshold: config.thresholdRatio === void 0,\n');
  text = replaceOnce(text, 'const spec = resolveCompactSpec(policy, context.contextWindow);', 'const spec = resolveCompactSpec(await dscodePricedCompactionPolicy(this.config, policy), context.contextWindow);');
  return marker + '\n' + text;
}
