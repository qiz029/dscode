/** Terminal image- and file-attachment adapter over the Harness durable attachment service. */

import { open, readFile, stat } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { basename, extname, isAbsolute, resolve } from 'node:path'
import type { AttachmentStore, ImageMediaType, SaveFileAttachment, SaveImageAttachment } from '@deepseek-ai/dsh-attachment'
import type { FileBlock, ImageBlock } from '@deepseek-ai/dsh-llm'

/** A validated path retained in the editor until submission persists it. */
export interface ImagePathInspection {
  readonly path: string
  readonly name: string
  readonly mediaType: ImageMediaType
  readonly bytes: number
}

/** A validated non-image file path retained the same way (0.1.5 file blocks). */
export interface FilePathInspection {
  readonly path: string
  readonly name: string
  readonly bytes: number
}

/**
 * Terminal-side file admission bounds. Upstream exposes image limits through
 * the attachment service but no file limits (files ride verbatim storage);
 * these keep a dragged file from silently ingesting a disk-sized blob and
 * bound one message the way the image batch is bounded.
 */
export const MAX_FILE_BYTES = 8 * 1024 * 1024
export const MAX_FILES_PER_MESSAGE = 8

const IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif'])

/** Detect the supported encoded raster formats from bytes, never from a path suffix. */
export function detectImageMediaType(data: Uint8Array): ImageMediaType | undefined {
  if (data.length >= 8 && data[0] === 0x89 && data[1] === 0x50 && data[2] === 0x4e && data[3] === 0x47
    && data[4] === 0x0d && data[5] === 0x0a && data[6] === 0x1a && data[7] === 0x0a) return 'image/png'
  if (data.length >= 3 && data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff) return 'image/jpeg'
  if (data.length >= 6) {
    const signature = String.fromCharCode(...data.subarray(0, 6))
    if (signature === 'GIF87a' || signature === 'GIF89a') return 'image/gif'
  }
  if (data.length >= 12
    && String.fromCharCode(...data.subarray(0, 4)) === 'RIFF'
    && String.fromCharCode(...data.subarray(8, 12)) === 'WEBP') return 'image/webp'
  return undefined
}

/** Whether a path-like token is worth probing as an image attachment. */
export function looksLikeImagePath(path: string): boolean {
  return IMAGE_EXTENSIONS.has(extname(path).toLowerCase())
}

/**
 * Parse a paste/drop into its image and file paths: image-suffixed tokens
 * stay images, other path-shaped tokens ride as file attachments (0.1.5
 * file blocks), and anything that is neither leaves both empty — the caller
 * then treats the paste as plain text.
 *
 * File tokens are held to an absolute-path-with-shape bar (drive/backslash
 * or a dot-suffixed leaf after a separator): a dropped terminal path always
 * carries one of those, while prose, slash commands, and option flags never
 * do. A POSIX absolute path without any dot-suffixed leaf falls through as
 * text — the @ mention route still attaches such files deliberately.
 */
export function parsePastedAttachmentPaths(input: string): { readonly images: readonly string[]; readonly files: readonly string[] } {
  const text = input.trim()
  if (text === '') return { images: [], files: [] }
  const images: string[] = []
  const files: string[] = []
  const looksLikeDroppedFile = (path: string): boolean =>
    /^[A-Za-z]:[\\/]/u.test(path)
    || /^\\\\/u.test(path)
    || (/^\/|^\.\.?\//u.test(path) && /\.[A-Za-z0-9]{1,16}$/u.test(path))
  const matcher = /"([^"]+)"|'([^']+)'|(\S+)/gu
  for (const match of text.matchAll(matcher)) {
    const token = match[1] ?? match[2] ?? match[3]
    if (token === undefined) continue
    let path = token
    if (path.startsWith('file://')) {
      try {
        path = fileURLToPath(path)
      } catch {
        return { images: [], files: [] }
      }
      if (looksLikeImagePath(path)) images.push(path)
      else files.push(path)
      continue
    }
    if (looksLikeImagePath(path)) {
      images.push(path)
      continue
    }
    if (!looksLikeDroppedFile(path)) return { images: [], files: [] }
    files.push(path)
  }
  return { images, files }
}

/** Validate path, byte size and encoded signature without writing an attachment object. */
export async function inspectImagePaths(
  paths: readonly string[],
  attachments: AttachmentStore | undefined,
  cwd = process.cwd(),
): Promise<readonly ImagePathInspection[]> {
  if (paths.length === 0) return []
  if (attachments === undefined) throw new Error('image attachments are unavailable in this profile')
  if (paths.length > attachments.imageLimits.maxImagesPerMessage) {
    throw new Error(`too many images (${paths.length}; limit ${attachments.imageLimits.maxImagesPerMessage})`)
  }
  const inspected: ImagePathInspection[] = []
  let totalBytes = 0
  for (const raw of paths) {
    const path = isAbsolute(raw) ? resolve(raw) : resolve(cwd, raw)
    let facts: Awaited<ReturnType<typeof stat>>
    try {
      facts = await stat(path)
    } catch (error: unknown) {
      throw new Error(`cannot read image "${raw}": ${error instanceof Error ? error.message : String(error)}`)
    }
    if (!facts.isFile()) throw new Error(`image path is not a file: "${raw}"`)
    if (facts.size > attachments.imageLimits.maxImageBytes) {
      throw new Error(`image "${basename(path)}" is ${facts.size} bytes; limit ${attachments.imageLimits.maxImageBytes}`)
    }
    totalBytes += facts.size
    if (totalBytes > attachments.imageLimits.maxMessageImageBytes) {
      throw new Error(`image batch is ${totalBytes} bytes; limit ${attachments.imageLimits.maxMessageImageBytes}`)
    }
    const handle = await open(path, 'r')
    try {
      const signature = new Uint8Array(16)
      const { bytesRead } = await handle.read(signature, 0, signature.length, 0)
      const mediaType = detectImageMediaType(signature.subarray(0, bytesRead))
      if (mediaType === undefined || !attachments.imageLimits.mediaTypes.includes(mediaType)) {
        throw new Error(`unsupported image file "${raw}" (expected PNG, JPEG, WebP, or GIF)`)
      }
      inspected.push({ path, name: basename(path), mediaType, bytes: facts.size })
    } finally {
      await handle.close()
    }
  }
  return inspected
}

/** Read, validate, and persist an ordered image path list as model content blocks. */
export async function saveImagePaths(
  paths: readonly string[],
  attachments: AttachmentStore | undefined,
  signal?: AbortSignal,
): Promise<readonly ImageBlock[]> {
  if (paths.length === 0) return []
  if (attachments === undefined) throw new Error('image attachments are unavailable in this profile')
  const checkCancelled = (): void => {
    if (signal?.aborted === true) throw new Error('image submission cancelled')
  }
  const inputs: SaveImageAttachment[] = []
  for (const path of paths) {
    checkCancelled()
    let data: Uint8Array
    try {
      data = await readFile(path)
    } catch (error: unknown) {
      throw new Error(`cannot read image "${path}": ${error instanceof Error ? error.message : String(error)}`)
    }
    const mediaType = detectImageMediaType(data)
    if (mediaType === undefined) throw new Error(`unsupported image file "${path}" (expected PNG, JPEG, WebP, or GIF)`)
    inputs.push({ data, mediaType, name: basename(path) })
  }
  checkCancelled()
  const refs = await attachments.saveImages(inputs)
  checkCancelled()
  return refs.map(attachment => ({ type: 'image', attachment }))
}

/** Validate path and byte size for non-image file attachments without writing. */
export async function inspectFilePaths(
  paths: readonly string[],
  attachments: AttachmentStore | undefined,
  cwd = process.cwd(),
): Promise<readonly FilePathInspection[]> {
  if (paths.length === 0) return []
  if (attachments === undefined) throw new Error('file attachments are unavailable in this profile')
  if (paths.length > MAX_FILES_PER_MESSAGE) {
    throw new Error(`too many files (${paths.length}; limit ${MAX_FILES_PER_MESSAGE})`)
  }
  const inspected: FilePathInspection[] = []
  for (const raw of paths) {
    const path = isAbsolute(raw) ? resolve(raw) : resolve(cwd, raw)
    let facts: Awaited<ReturnType<typeof stat>>
    try {
      facts = await stat(path)
    } catch (error: unknown) {
      throw new Error(`cannot read file "${raw}": ${error instanceof Error ? error.message : String(error)}`)
    }
    if (!facts.isFile()) throw new Error(`file path is not a file: "${raw}"`)
    if (facts.size > MAX_FILE_BYTES) {
      throw new Error(`file "${basename(path)}" is ${facts.size} bytes; limit ${MAX_FILE_BYTES}`)
    }
    inspected.push({ path, name: basename(path), bytes: facts.size })
  }
  return inspected
}

/** Read and persist an ordered non-image file path list as model file blocks. */
export async function saveFilePaths(
  paths: readonly string[],
  attachments: AttachmentStore | undefined,
  signal?: AbortSignal,
): Promise<readonly FileBlock[]> {
  if (paths.length === 0) return []
  if (attachments === undefined) throw new Error('file attachments are unavailable in this profile')
  // The bounds are re-checked here so a draft inspected earlier still guards
  // the actual read at submission time.
  await inspectFilePaths(paths, attachments)
  const checkCancelled = (): void => {
    if (signal?.aborted === true) throw new Error('file submission cancelled')
  }
  const inputs: SaveFileAttachment[] = []
  for (const path of paths) {
    checkCancelled()
    let data: Uint8Array
    try {
      data = await readFile(path)
    } catch (error: unknown) {
      throw new Error(`cannot read file "${path}": ${error instanceof Error ? error.message : String(error)}`)
    }
    inputs.push({ data, name: basename(path) })
  }
  checkCancelled()
  const refs = await Promise.all(inputs.map(input => attachments.saveFile(input)))
  checkCancelled()
  return refs.map(attachment => ({ type: 'file', attachment }))
}
