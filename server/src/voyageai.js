// server/src/voyageai.js
// Atlas Model API client for VoyageAI multimodal embeddings

import { CONFIG } from './config.js';

const ATLAS_MULTIMODAL_URL = 'https://ai.mongodb.com/v1/multimodalembeddings';
const MODEL = 'voyage-multimodal-3.5';

/**
 * Embed an image with optional caption using Atlas Model API
 * @param {Buffer} imageBuffer - Image file buffer
 * @param {string} caption - Optional caption to embed with image
 * @returns {Promise<number[]>} - 1024-dimensional embedding vector
 */
export async function embedImage(imageBuffer, caption = null) {
  if (!CONFIG.ATLAS_MODEL_API_KEY) {
    throw new Error('ATLAS_MODEL_API_KEY not configured');
  }

  const base64Image = imageBuffer.toString('base64');

  // Build content array (image + optional text)
  const content = [
    {
      type: 'image_base64',
      image_base64: `data:image/png;base64,${base64Image}`
    }
  ];

  if (caption) {
    content.push({ type: 'text', text: caption });
  }

  const response = await fetch(ATLAS_MULTIMODAL_URL, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${CONFIG.ATLAS_MODEL_API_KEY}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      inputs: [{ content }],
      model: MODEL,
      input_type: 'document'
    })
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Atlas Model API error ${response.status}: ${error}`);
  }

  const data = await response.json();

  if (!data?.data?.[0]?.embedding) {
    throw new Error('Unexpected response format: ' + JSON.stringify(data));
  }

  return data.data[0].embedding;
}

/**
 * Embed a text query for searching images
 * @param {string} text - Search query text
 * @returns {Promise<number[]>} - 1024-dimensional embedding vector
 */
export async function embedQuery(text) {
  if (!CONFIG.ATLAS_MODEL_API_KEY) {
    throw new Error('ATLAS_MODEL_API_KEY not configured');
  }

  const response = await fetch(ATLAS_MULTIMODAL_URL, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${CONFIG.ATLAS_MODEL_API_KEY}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      inputs: [{ content: [{ type: 'text', text }] }],
      model: MODEL,
      input_type: 'query'
    })
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Atlas Model API error ${response.status}: ${error}`);
  }

  const data = await response.json();

  if (!data?.data?.[0]?.embedding) {
    throw new Error('Unexpected response format: ' + JSON.stringify(data));
  }

  return data.data[0].embedding;
}
