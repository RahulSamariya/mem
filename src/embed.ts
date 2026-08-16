import { pipeline } from '@xenova/transformers';
import { env } from '@xenova/transformers';
import { EMBEDDING_DIMS, MODEL_CACHE_DIR, DEFAULT_MODEL } from './core';

env.cacheDir = MODEL_CACHE_DIR;
env.allowRemoteModels = true;

let extractor: any = null;

async function getExtractor(): Promise<any> {
  if (!extractor) {
    extractor = await pipeline('feature-extraction', DEFAULT_MODEL, {
      quantized: true,
    });
  }
  return extractor;
}

export async function embed(text: string): Promise<number[]> {
  const ex = await getExtractor();
  const output = await ex(text, { pooling: 'mean', normalize: true });
  const data = Array.from(output.data as Float32Array);
  if (data.length !== EMBEDDING_DIMS) {
    throw new Error(
      `Embedding dim mismatch: got ${data.length}, expected ${EMBEDDING_DIMS}`
    );
  }
  return data;
}

export async function embedMany(texts: string[]): Promise<number[][]> {
  const ex = await getExtractor();
  const output = await ex(texts, { pooling: 'mean', normalize: true });
  const toArray = (t: any): number[] => Array.from(t.data as Float32Array);
  if (Array.isArray(output)) {
    return output.map(toArray);
  }
  // Single output but asked for many — model returned a single tensor.
  return [toArray(output)];
}

export function toBuffer(vector: number[]): Buffer {
  return Buffer.from(new Float32Array(vector).buffer);
}

export function fromBuffer(buf: Buffer): number[] {
  return Array.from(new Float32Array(buf.buffer, buf.byteOffset, buf.length / 4));
}
