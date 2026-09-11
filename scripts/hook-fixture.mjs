// Only mounted by the deterministic doctor overlay.
let input = '';
for await (const chunk of process.stdin) input += chunk;
const event = JSON.parse(input);
if (event.tool_input?.command === 'printf HARNESS_HOOK_BLOCK') {
  process.stderr.write('HARNESS_HOOK_DENIED');
  process.exitCode = 2;
}
