/**
 * Where a question's diagram lives.
 *
 * Images are held outside the quiz record and referenced by id. That is not
 * tidiness: a quiz is loaded whole into memory and sent whole to every taker,
 * so an image inlined into the questions would ride along in each of those
 * payloads. At the concurrency this has already been load tested to, that
 * would be the thing that runs the process out of memory.
 *
 * Two backends, chosen the same way the record stores choose: Supabase Storage
 * when Supabase is configured, otherwise files on disk. Both hand back a URL,
 * so the browser fetches and caches the image itself either way.
 */

import fsp from 'node:fs/promises';
import path from 'node:path';

import { config } from '../config.js';
import { createId } from '../lib/ids.js';
import { detectImageType } from '../lib/imageType.js';
import { badRequest } from '../lib/errors.js';

const BUCKET = 'quiz-media';

/** Files on disk, served back by this process. Used when there is no Supabase. */
class DiskMediaStore {
  #directory = path.join(config.dataDir, 'media');

  async put(buffer, { extension }) {
    const id = `${createId()}.${extension}`;
    await fsp.mkdir(this.#directory, { recursive: true });
    await fsp.writeFile(path.join(this.#directory, id), buffer);
    return { id, url: `/media/${id}` };
  }

  async get(id) {
    // The id becomes a path segment, so anything that could climb out of the
    // directory is refused rather than sanitised into something plausible.
    if (id !== path.basename(id)) return null;

    try {
      const buffer = await fsp.readFile(path.join(this.#directory, id));
      return { buffer, type: detectImageType(buffer)?.type ?? 'application/octet-stream' };
    } catch (error) {
      if (error.code === 'ENOENT') return null;
      throw error;
    }
  }

  describe() {
    return { backend: 'disk', durable: false, directory: this.#directory };
  }
}

/** Supabase Storage, which survives a redeploy and serves the file itself. */
class SupabaseMediaStore {
  #url;
  #key;
  #bucketReady = null;

  constructor({ url, serviceRoleKey }) {
    this.#url = url.replace(/\/+$/, '');
    this.#key = serviceRoleKey;
  }

  #headers(extra = {}) {
    return { apikey: this.#key, Authorization: `Bearer ${this.#key}`, ...extra };
  }

  /**
   * Create the bucket once per process. Public, because the images are part of
   * a quiz that anyone holding the link can already open, and a signed URL per
   * image per taker would be a round trip that buys nothing.
   */
  async #ensureBucket() {
    this.#bucketReady ??= (async () => {
      const response = await fetch(`${this.#url}/storage/v1/bucket`, {
        method: 'POST',
        headers: this.#headers({ 'Content-Type': 'application/json' }),
        body: JSON.stringify({ id: BUCKET, name: BUCKET, public: true }),
      });

      // 409 is the bucket already existing, which is the normal case.
      if (!response.ok && response.status !== 409) {
        this.#bucketReady = null; // let the next upload try again
        throw new Error(`Could not prepare image storage (${response.status}).`);
      }
    })();

    return this.#bucketReady;
  }

  async put(buffer, { extension, type }) {
    await this.#ensureBucket();

    const id = `${createId()}.${extension}`;
    const response = await fetch(`${this.#url}/storage/v1/object/${BUCKET}/${id}`, {
      method: 'POST',
      headers: this.#headers({ 'Content-Type': type, 'Cache-Control': 'public, max-age=31536000' }),
      body: buffer,
    });

    if (!response.ok) {
      const detail = await response.text().catch(() => '');
      throw new Error(`Could not store the image (${response.status}). ${detail.slice(0, 200)}`);
    }

    return { id, url: `${this.#url}/storage/v1/object/public/${BUCKET}/${id}` };
  }

  /** Nothing asks this process for the bytes: the URL points straight at Supabase. */
  async get() {
    return null;
  }

  describe() {
    return { backend: 'supabase', durable: true, bucket: BUCKET };
  }
}

export const mediaStore = config.supabase.enabled
  ? new SupabaseMediaStore(config.supabase)
  : new DiskMediaStore();

/**
 * Read one uploaded image out of a JSON request body.
 *
 * Base64 in JSON rather than a multipart form: parsing multipart correctly is
 * a job for a library, and this project has no dependencies. The cost is a
 * third more bytes on the wire, which for a diagram is not worth a parser.
 */
export async function storeUploadedImage(payload = {}) {
  const encoded = typeof payload.data === 'string' ? payload.data : '';
  if (encoded === '') throw badRequest('No image was sent.');

  // Accept a data: URL as well as bare base64, since that is what FileReader
  // hands a browser and stripping it client-side is a step that gets forgotten.
  const base64 = encoded.startsWith('data:') ? (encoded.split(',')[1] ?? '') : encoded;

  const buffer = Buffer.from(base64, 'base64');
  if (buffer.length === 0) throw badRequest('That image could not be read.');

  if (buffer.length > config.limits.imageMaxBytes) {
    const megabytes = (config.limits.imageMaxBytes / (1024 * 1024)).toFixed(1);
    throw badRequest(`Images must be under ${megabytes} MB. Scale it down and try again.`);
  }

  const detected = detectImageType(buffer);
  if (!detected) {
    throw badRequest('That file is not a PNG, JPEG, GIF or WebP image.');
  }

  const { id, url } = await mediaStore.put(buffer, detected);
  return { id, url, type: detected.type, bytes: buffer.length };
}

/**
 * The bytes behind a stored image URL, whichever backend holds it.
 *
 * Only needed when something server-side has to look at a picture rather than
 * hand its address to a browser - which today means asking a model to suggest
 * a mark for a drawing.
 */
export async function readMediaByUrl(url, { fetchImpl = fetch } = {}) {
  if (typeof url !== 'string' || url === '') return null;

  if (url.startsWith('/media/')) {
    const file = await mediaStore.get(url.slice('/media/'.length));
    return file ? { buffer: file.buffer, type: file.type } : null;
  }

  // Stored in Supabase, whose bucket is public, so a plain read is enough.
  const response = await fetchImpl(url);
  if (!response.ok) return null;

  const buffer = Buffer.from(await response.arrayBuffer());
  const type = detectImageType(buffer)?.type;
  return type ? { buffer, type } : null;
}
