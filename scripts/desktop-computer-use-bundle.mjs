import { cpSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, resolve } from 'node:path';
import { replaceOnce } from './patch-util.mjs';

export function bundleDesktopComputerUse(destination, source = resolve(import.meta.dirname, '../node_modules/dscode-desktop-computer-use')) {
  const manifest = JSON.parse(readFileSync(join(source, 'package.json'), 'utf8'));
  if (manifest.version !== '0.3.3') throw Error('Desktop Computer Use requires reviewed upstream version 0.3.3');
  const native = JSON.parse(readFileSync(join(source, 'native/macos/manifest.json'), 'utf8'));
  const binaryHash = createHash('sha256').update(readFileSync(join(source, 'native/macos', native.binary.path))).digest('hex');
  if (binaryHash !== native.binary.sha256) throw Error('Computer Use helper integrity mismatch');
  const target = join(destination, 'vendor/computer-use'); mkdirSync(target, { recursive: true });
  for (const path of ['lib', 'native/macos', 'LICENSE']) cpSync(join(source, path), join(target, path), { recursive: true });
  const toolsPath = join(target, 'lib/tools.js'), original = readFileSync(toolsPath, 'utf8');
  let tools = replaceOnce(original,
    "'If the task now needs OCR, visual grounding, or pixel inspection and vision_glance is not visible, call the skill tool with {\"name\":\"vision-tools\"}; then pass this exact Artifact path to vision_glance, vision_ground, vision_detect, vision_crop, or vision_long_screenshot_ocr.',",
    "'For visual inspection, pass this exact artifact path to read_image with an image-capable model. If the selected model cannot read images, report the limitation and use Accessibility evidence where adequate.',");
  tools = replaceOnce(tools, "'Do not inspect OCR executables or use bash, tesseract, screencapture, or an ad hoc Swift/Python OCR implementation.',",
    "'Do not guess screenshot contents or install an OCR stack. Observe again before acting if the UI has changed.',");
  tools = replaceOnce(tools, 'When a screenshot needs OCR, visual grounding, or pixel inspection, load the vision-tools Skill and pass the returned Artifact path to its native tools instead of using bash, tesseract, screencapture, or an ad hoc OCR script.',
    'For pixel inspection, pass the returned artifact path to read_image with an image-capable model. Report unavailable image support; do not guess pixels or install an OCR stack.');
  writeFileSync(toolsPath, tools);
  writeFileSync(join(destination, 'plugins/computer-use/desktop-upstream.mjs'), [
    "export { MacOSComputerUseProvider } from '../../vendor/computer-use/lib/providers/macos.js';",
    "export { Config } from '../../vendor/computer-use/lib/config.js';",
    "export { createComputerUseTools } from '../../vendor/computer-use/lib/tools.js';",
    '',
  ].join('\n'));
  return { package: manifest.name, version: manifest.version, license: manifest.license,
    helperSha256: binaryHash, architectures: native.binary.architectures, minimumMacOS: native.binary.minimumMacOS,
    toolsEntrySha256: createHash('sha256').update(original).digest('hex') };
}
