import { analyzeDoctorEvidence, collectDoctorEvidence } from './doctor.mjs';

export const name = 'dscode-doctor-cli';
export const inject = ['sessionPersistence', 'llm'];

export function apply(ctx, config = {}) {
  void run(ctx, config).then(() => ctx.get('appExit')(0), error => {
    console.error(`DSCODE doctor failed: ${error.message}`);
    ctx.get('appExit')(1);
  });
}

async function run(ctx, config) {
  await ctx.get('loader').await();
  await new Promise(resolve => ctx.get('appReady').onReady(resolve));
  const signal = AbortSignal.timeout(60000);
  const evidence = await collectDoctorEvidence(ctx, { cwd: process.cwd(), signal });
  if (config.preview) { console.log(JSON.stringify(evidence, null, 2)); return; }
  const route = evidence.traces.find(trace => trace.route)?.route;
  console.log(`DSCODE doctor — ${evidence.cwd}\n${await analyzeDoctorEvidence(ctx, evidence, route, signal, { model: config.local !== true })}`);
  console.log('Deterministic integration check: npm run doctor (source checkout only).');
}
