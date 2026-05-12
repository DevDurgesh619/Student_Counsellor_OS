import { loadEnv } from '@wgc/config';
import { logger } from '../logger.js';

/**
 * Best-effort OCR via Google Cloud Vision REST. Feature-flagged on
 * WGC_GOOGLE_VISION_KEY — if not set, returns null and Worker 1 falls back to
 * counsellor-manual-entry mode.
 *
 * The caller passes raw bytes; we send `images.annotate` with feature
 * `DOCUMENT_TEXT_DETECTION` (best for printed marksheets) and return the full
 * recognised text. Subject-level extraction happens in the Worker 1 LLM call,
 * not here.
 */
export async function ocrMarksheet(buffer: Buffer): Promise<string | null> {
  const env = loadEnv();
  if (!env.WGC_GOOGLE_VISION_KEY) {
    logger.info('Google Vision key not set; skipping OCR');
    return null;
  }

  const body = {
    requests: [
      {
        image: { content: buffer.toString('base64') },
        features: [{ type: 'DOCUMENT_TEXT_DETECTION', maxResults: 1 }],
      },
    ],
  };

  try {
    const res = await fetch(
      `https://vision.googleapis.com/v1/images:annotate?key=${env.WGC_GOOGLE_VISION_KEY}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      },
    );
    if (!res.ok) {
      logger.warn({ status: res.status }, 'Vision OCR returned non-2xx');
      return null;
    }
    const json = (await res.json()) as {
      responses?: Array<{ fullTextAnnotation?: { text?: string } }>;
    };
    const text = json.responses?.[0]?.fullTextAnnotation?.text ?? null;
    return text;
  } catch (err) {
    logger.warn({ err }, 'Vision OCR threw; treating as failure');
    return null;
  }
}
