import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';

const xml = value => String(value).replace(/[<>&"']/gu, char => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;' }[char]));
export const schedulerLabel = home => `ai.dscode.scheduler.${createHash('sha256').update(home).digest('hex').slice(0, 12)}`;
export const schedulerPath = (home, directory = join(homedir(), 'Library', 'LaunchAgents')) => join(directory, `${schedulerLabel(home)}.plist`);

export function schedulerPlist(home, dscodePath) {
  const args = [process.execPath, dscodePath, 'trigger', 'scheduler', 'start'];
  const log = join(home, 'triggers', 'scheduler.log');
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>Label</key><string>${xml(schedulerLabel(home))}</string>
<key>ProgramArguments</key><array>${args.map(arg => `<string>${xml(arg)}</string>`).join('')}</array>
<key>WorkingDirectory</key><string>${xml(home)}</string>
<key>EnvironmentVariables</key><dict><key>DSH_HOME</key><string>${xml(home)}</string><key>DSCODE_HOME</key><string>${xml(home)}</string><key>PATH</key><string>${xml(`${dirname(process.execPath)}:/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin`)}</string></dict>
<key>RunAtLoad</key><true/><key>KeepAlive</key><true/>
<key>ThrottleInterval</key><integer>5</integer>
<key>StandardOutPath</key><string>${xml(log)}</string>
<key>StandardErrorPath</key><string>${xml(log)}</string>
</dict></plist>
`;
}

export async function schedulerService(action, { home, dscodePath, platform, launchctl, agentsDirectory, out }) {
  if (platform !== 'darwin' || !launchctl) {
    out(`Manage the scheduler with your service manager: ${JSON.stringify(process.execPath)} ${JSON.stringify(dscodePath)} trigger scheduler start (DSH_HOME=${JSON.stringify(home)}, DSCODE_HOME=${JSON.stringify(home)})`);
    return;
  }
  const path = schedulerPath(home, agentsDirectory);
  const label = `gui/${process.getuid()}/${schedulerLabel(home)}`;
  if (action === 'uninstall') {
    await launchctl(['bootout', label], { ignoreFailure: true });
    rmSync(path, { force: true });
    out(`removed scheduler service ${path}; pending jobs remain on disk`);
    return;
  }
  mkdirSync(dirname(path), { recursive: true });
  mkdirSync(join(home, 'triggers'), { recursive: true, mode: 0o700 });
  writeFileSync(path, schedulerPlist(home, dscodePath), { mode: 0o600 });
  if (await launchctl(['print', label], { ignoreFailure: true }) !== 0) await launchctl(['bootstrap', `gui/${process.getuid()}`, path]);
  out(`scheduler installed: ${path}`);
}
