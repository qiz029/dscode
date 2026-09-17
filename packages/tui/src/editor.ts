/** Host editor and clipboard adapters used by the terminal surface. */

import { spawn } from 'node:child_process'
import type { TranscriptView } from './render/projection.ts'

function waitForProcess(command: string, args: readonly string[], input?: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, [...args], {
      stdio: input === undefined ? 'inherit' : ['pipe', 'ignore', 'pipe'],
      windowsHide: true,
    })
    let stderr = ''
    child.stderr?.on('data', chunk => { stderr += String(chunk) })
    child.once('error', reject)
    child.once('exit', code => {
      if (code === 0) resolve()
      else reject(new Error(`${command} exited with code ${String(code)}${stderr.trim() === '' ? '' : `: ${stderr.trim()}`}`))
    })
    if (input !== undefined) child.stdin?.end(input)
  })
}

/** Copy UTF-8 text through the platform clipboard command. */
export async function copyText(text: string): Promise<void> {
  if (process.platform === 'win32') {
    // Windows PowerShell 5 reads redirected stdin using the active console
    // code page by default. Node writes UTF-8, so CJK copied through `$input`
    // became mojibake. Set the pipe encoding before reading it.
    await waitForProcess('powershell.exe', [
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      '[Console]::InputEncoding = [System.Text.UTF8Encoding]::new($false); Set-Clipboard -Value ([Console]::In.ReadToEnd())',
    ], text)
    return
  }
  if (process.platform === 'darwin') {
    await waitForProcess('pbcopy', [], text)
    return
  }
  await waitForProcess('xclip', ['-selection', 'clipboard'], text)
}

/** Latest complete assistant text, excluding streaming and reasoning. */
export function latestAssistantText(view: TranscriptView): string | undefined {
  for (let index = view.entries.length - 1; index >= 0; index -= 1) {
    const entry = view.entries[index]
    if (entry?.kind === 'assistant' && entry.text !== '') return entry.text
  }
  return undefined
}
