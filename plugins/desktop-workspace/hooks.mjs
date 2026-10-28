import { apply as applyHooks, inject as hookServices } from '@deepseek-ai/dsh-hooks-codex';

/** Reuse the native hook protocol while binding registrations to one Agent. */
export async function mountWorkspaceHooks(agentContext, configPath, creation) {
  await agentContext.plugin({
    name: 'dscode-workspace-hooks',
    // Match the loaded bridge: older Desktop runtimes have no workingDirectory.
    inject: hookServices,
    async apply(scope) {
      let sessionStart;
      // Hooks are mounted during agent/created, after that dispatch collected
      // its listeners. Invoke only the newly registered SessionStart callback;
      // re-emitting agent/created would repeat unrelated lifecycle handlers.
      applyHooks({
        shell: scope.shell,
        sessionProjections: scope.sessionProjections,
        workingDirectory: scope.workingDirectory,
        logger: scope.logger,
        effect: scope.effect.bind(scope),
        on(event, listener, ...options) {
          if (event === 'agent/created') {
            sessionStart = listener;
            return () => {};
          }
          return scope.on(event, listener, ...options);
        },
      }, { configPath, defaultTimeoutMs: 10000, stderrSummaryMaxChars: 500 });
      // A remount (/reload) is not a new session: SessionStart runs only at creation.
      if (creation !== undefined) await sessionStart?.(creation);
    },
  });
}
