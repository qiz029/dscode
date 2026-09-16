import { replaceOnce } from './patch-util.mjs';

/** Route the native /review TUI entrypoint through DSCODE's shared review service. */
export function patchReview(text) {
  if (text.includes('// dscode-review-command-v1')) return text;
  // 1.2.0 grew a native review picker inside this handler; DSCODE still owns /review,
  // so the whole upstream block is claimed rather than a single statement.
  const before = String.raw`if (text === "/review" || text.startsWith("/review ")) {
				const argument = text.slice(7).trim();
				if (argument === "") {
					openReviewPicker();
					return;
				}
				try {
					reviewChanges(parseReviewArgument(argument));
				} catch (error) {
					notify(error instanceof Error ? error.message : String(error), "warning");
				}
				return;
			}`;
  const after = `if (text === "/review" || text.startsWith("/review ")) {
				// dscode-review-command-v1
				dispatch(text);
				return;
			}`;
  // Keep the actionable message for an unknown upstream shape; replaceOnce would report a
  // truncated anchor instead.
  if (text.split(before).length !== 2) throw Error('Unsupported DSH-Code /review handler; refusing an ambiguous patch');
  return replaceOnce(text, before, after);
}
