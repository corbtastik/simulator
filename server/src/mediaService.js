// server/src/mediaService.js
// Image selection, caption generation, and embedding for incidents

import fs from 'fs/promises';
import path from 'path';
import { CONFIG } from './config.js';
import { embedImage } from './voyageai.js';

// Path to generated images (from OpenAI script)
const IMAGES_DIR = CONFIG.MEDIA_IMAGES_DIR;

// Cache of available images per category
let imageCache = null;

/**
 * Load available images from the images directory
 * Structure: {category}/{type}-{id}.png
 */
async function loadImageCache() {
  if (imageCache) return imageCache;

  imageCache = {};

  try {
    const categories = await fs.readdir(IMAGES_DIR);

    for (const cat of categories) {
      const catPath = path.join(IMAGES_DIR, cat);
      const stat = await fs.stat(catPath);

      if (stat.isDirectory()) {
        const files = await fs.readdir(catPath);
        const images = files.filter(f => /\.(png|jpg|jpeg|webp)$/i.test(f));

        // Group by type (filename format: {type}-{id}.png)
        imageCache[cat] = {};
        for (const img of images) {
          const match = img.match(/^([a-z0-9_-]+)-[a-f0-9]+\.(png|jpg|jpeg|webp)$/i);
          if (match) {
            const type = match[1];
            if (!imageCache[cat][type]) imageCache[cat][type] = [];
            imageCache[cat][type].push(img);
          } else {
            // Fallback: put in 'general' bucket
            if (!imageCache[cat]['general']) imageCache[cat]['general'] = [];
            imageCache[cat]['general'].push(img);
          }
        }
      }
    }

    const totalImages = Object.values(imageCache).reduce(
      (sum, cat) => sum + Object.values(cat).reduce((s, arr) => s + arr.length, 0),
      0
    );
    console.log(`[mediaService] Loaded ${totalImages} images across ${Object.keys(imageCache).length} categories`);

  } catch (err) {
    console.error('[mediaService] Failed to load image cache:', err.message);
    imageCache = {};
  }

  return imageCache;
}

/**
 * Select a random image matching incident category and type
 * @param {string} category - Incident category (e.g., 'infrastructure')
 * @param {string} type - Incident type (e.g., 'backhaul')
 * @param {function} rand - Optional random function (for seeded selection)
 * @returns {Promise<{filename, path, category, type}|null>}
 */
export async function selectImageForIncident(category, type, rand = Math.random) {
  const cache = await loadImageCache();

  // Try exact category + type match
  let images = cache[category]?.[type] || [];

  // Fallback to general images in category
  if (images.length === 0) {
    images = cache[category]?.['general'] || [];
  }

  // Fallback to any image in category
  if (images.length === 0 && cache[category]) {
    const allInCat = Object.values(cache[category]).flat();
    images = allInCat;
  }

  // No images available
  if (images.length === 0) {
    return null;
  }

  const selected = images[Math.floor(rand() * images.length)];

  return {
    filename: selected,
    path: path.join(IMAGES_DIR, category, selected),
    category,
    type
  };
}

/**
 * Generate a descriptive caption for the incident image
 */
export function generateCaption(incident, imageInfo) {
  const { city, state, serviceIssue } = incident;
  const { type, category, issue, narrative } = serviceIssue || {};

  // Use narrative if available (truncated), otherwise generate from fields
  if (narrative && narrative.length > 10) {
    const truncated = narrative.length > 200 ? narrative.slice(0, 197) + '...' : narrative;
    return `${category} incident in ${city}, ${state}: ${truncated}`;
  }

  return `${category || 'Network'} ${type || 'service'} incident in ${city}, ${state}. Issue: ${issue || 'service disruption'}.`;
}

/**
 * Create a media document with embedding for an incident
 * @param {Object} incident - The incident document
 * @param {string} simRunId - Current simulation run ID
 * @param {function} rand - Optional random function for image selection
 * @returns {Promise<Object|null>} - Media document ready for insertion, or null
 */
export async function createMediaDocument(incident, simRunId, rand = Math.random) {
  const { serviceIssue } = incident;
  if (!serviceIssue) return null;

  const imageInfo = await selectImageForIncident(
    serviceIssue.category,
    serviceIssue.type,
    rand
  );

  if (!imageInfo) {
    return null;
  }

  try {
    const imageBuffer = await fs.readFile(imageInfo.path);
    const caption = generateCaption(incident, imageInfo);

    console.log(`[mediaService] Embedding image for ${incident.city}: ${imageInfo.filename}`);
    const embedding = await embedImage(imageBuffer, caption);

    return {
      incidentId: incident._id,
      simRunId,
      mediaType: 'image',
      category: imageInfo.category,
      type: imageInfo.type,
      filename: imageInfo.filename,
      caption,
      embedding,
      ts: new Date()
    };

  } catch (err) {
    console.error('[mediaService] Failed to create media doc:', err.message);
    return null;
  }
}

/**
 * Check if media service is properly configured
 */
export async function isMediaServiceReady() {
  if (!CONFIG.MEDIA_ENABLED) {
    return { ready: false, reason: 'MEDIA_ENABLED is false' };
  }

  if (!CONFIG.ATLAS_MODEL_API_KEY) {
    return { ready: false, reason: 'ATLAS_MODEL_API_KEY not configured' };
  }

  try {
    await fs.access(IMAGES_DIR);
    const cache = await loadImageCache();
    const totalImages = Object.values(cache).reduce(
      (sum, cat) => sum + Object.values(cat).reduce((s, arr) => s + arr.length, 0),
      0
    );

    if (totalImages === 0) {
      return { ready: false, reason: 'No images found in MEDIA_IMAGES_DIR' };
    }

    return { ready: true, imageCount: totalImages };

  } catch (err) {
    return { ready: false, reason: `Cannot access MEDIA_IMAGES_DIR: ${err.message}` };
  }
}
