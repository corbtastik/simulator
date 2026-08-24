// server/src/mediaService.js
// Image selection, caption generation, and embedding for incidents
// Supports both local filesystem and GCS bucket sources

import fs from 'fs/promises';
import path from 'path';
import { EventEmitter } from 'events';
import { Storage } from '@google-cloud/storage';
import { CONFIG } from './config.js';
import { embedImage } from './voyageai.js';

// Increase default max listeners to avoid warnings during rapid sequential GCS downloads.
// Default is 10, but we may download 30+ images in a batch (30% of 100 incidents).
// The warning comes from internal PassThrough streams in @google-cloud/storage.
EventEmitter.defaultMaxListeners = 50;

// GCS client (lazy initialized)
let gcsStorage = null;

function getGcsStorage() {
  if (!gcsStorage) {
    gcsStorage = new Storage();
  }
  return gcsStorage;
}

// Cache of available images (shared across sources)
let imageCache = null;
let currentSource = null;
let currentDataset = null;

/**
 * Load available images from local filesystem
 * Structure: {category}/{type}-{id}.png
 */
async function loadLocalImageCache(imagesDir) {
  const cache = {};

  try {
    const categories = await fs.readdir(imagesDir);

    for (const cat of categories) {
      const catPath = path.join(imagesDir, cat);
      const stat = await fs.stat(catPath);

      if (stat.isDirectory()) {
        const files = await fs.readdir(catPath);
        const images = files.filter(f => /\.(png|jpg|jpeg|webp)$/i.test(f));

        cache[cat] = {};
        for (const img of images) {
          const match = img.match(/^([a-z0-9_-]+)-[a-f0-9]+\.(png|jpg|jpeg|webp)$/i);
          if (match) {
            const type = match[1];
            if (!cache[cat][type]) cache[cat][type] = [];
            cache[cat][type].push(img);
          } else {
            if (!cache[cat]['general']) cache[cat]['general'] = [];
            cache[cat]['general'].push(img);
          }
        }
      }
    }
  } catch (err) {
    console.error('[mediaService] Failed to load local image cache:', err.message);
  }

  return cache;
}

/**
 * Load available images from GCS bucket manifest
 */
async function loadGcsImageCache(bucket, dataset) {
  const cache = {};

  try {
    const storage = getGcsStorage();
    const manifestPath = `incident-media/datasets/${dataset}/manifest.json`;

    const [content] = await storage.bucket(bucket).file(manifestPath).download();
    const manifest = JSON.parse(content.toString());

    for (const img of manifest.images) {
      const { category, type, filename } = img;
      if (!cache[category]) cache[category] = {};
      if (!cache[category][type]) cache[category][type] = [];
      cache[category][type].push({
        filename: filename.split('/').pop(), // just the filename
        gcsPath: `incident-media/datasets/${dataset}/images/${filename}`,
        ...img
      });
    }

    console.log(`[mediaService] Loaded GCS manifest: ${manifest.totalImages} images from ${dataset}`);
  } catch (err) {
    console.error('[mediaService] Failed to load GCS manifest:', err.message);
  }

  return cache;
}

/**
 * Load image cache based on source type
 */
async function loadImageCache(source = CONFIG.MEDIA_SOURCE, dataset = CONFIG.MEDIA_DATASET) {
  // Return cached if source/dataset unchanged
  if (imageCache && currentSource === source && currentDataset === dataset) {
    return imageCache;
  }

  currentSource = source;
  currentDataset = dataset;

  if (source === 'gcs') {
    imageCache = await loadGcsImageCache(CONFIG.MEDIA_GCS_BUCKET, dataset);
  } else {
    imageCache = await loadLocalImageCache(CONFIG.MEDIA_IMAGES_DIR);
  }

  const totalImages = Object.values(imageCache).reduce(
    (sum, cat) => sum + Object.values(cat).reduce((s, arr) => s + arr.length, 0),
    0
  );
  console.log(`[mediaService] Loaded ${totalImages} images from ${source} (dataset: ${dataset})`);

  return imageCache;
}

/**
 * Clear image cache (useful when switching sources)
 */
export function clearImageCache() {
  imageCache = null;
  currentSource = null;
  currentDataset = null;
}

/**
 * Select a random image matching incident category and type
 * @param {string} category - Incident category (e.g., 'infrastructure')
 * @param {string} type - Incident type (e.g., 'backhaul')
 * @param {function} rand - Optional random function (for seeded selection)
 * @param {string} source - 'local' or 'gcs'
 * @param {string} dataset - Dataset name for GCS
 * @returns {Promise<{filename, source, path?, gcsPath?, category, type}|null>}
 */
export async function selectImageForIncident(category, type, rand = Math.random, source = CONFIG.MEDIA_SOURCE, dataset = CONFIG.MEDIA_DATASET) {
  const cache = await loadImageCache(source, dataset);

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

  // Handle both local (string) and GCS (object) formats
  if (typeof selected === 'string') {
    // Local format
    return {
      filename: selected,
      source: 'local',
      path: path.join(CONFIG.MEDIA_IMAGES_DIR, category, selected),
      category,
      type
    };
  } else {
    // GCS format (object from manifest)
    return {
      filename: selected.filename,
      source: 'gcs',
      gcsPath: selected.gcsPath,
      category: selected.category,
      type: selected.type
    };
  }
}

/**
 * Get image buffer from local or GCS source
 */
async function getImageBuffer(imageInfo) {
  if (imageInfo.source === 'local') {
    return fs.readFile(imageInfo.path);
  } else if (imageInfo.source === 'gcs') {
    const storage = getGcsStorage();
    const [content] = await storage.bucket(CONFIG.MEDIA_GCS_BUCKET).file(imageInfo.gcsPath).download();
    return content;
  }
  throw new Error(`Unknown image source: ${imageInfo.source}`);
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
 * @param {string} source - 'local' or 'gcs'
 * @param {string} dataset - Dataset name for GCS
 * @returns {Promise<Object|null>} - Media document ready for insertion, or null
 */
export async function createMediaDocument(incident, simRunId, rand = Math.random, source = CONFIG.MEDIA_SOURCE, dataset = CONFIG.MEDIA_DATASET) {
  const { serviceIssue } = incident;
  if (!serviceIssue) return null;

  const imageInfo = await selectImageForIncident(
    serviceIssue.category,
    serviceIssue.type,
    rand,
    source,
    dataset
  );

  if (!imageInfo) {
    return null;
  }

  try {
    const imageBuffer = await getImageBuffer(imageInfo);
    const caption = generateCaption(incident, imageInfo);

    console.log(`[mediaService] Embedding image for ${incident.city}: ${imageInfo.filename} (${imageInfo.source})`);
    const embedding = await embedImage(imageBuffer, caption);

    return {
      incidentId: incident._id,
      simRunId,
      mediaType: 'image',
      category: imageInfo.category,
      type: imageInfo.type,
      filename: imageInfo.filename,
      source: imageInfo.source,
      dataset: source === 'gcs' ? dataset : null,
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
export async function isMediaServiceReady(source = CONFIG.MEDIA_SOURCE, dataset = CONFIG.MEDIA_DATASET) {
  if (!CONFIG.MEDIA_ENABLED && source === CONFIG.MEDIA_SOURCE) {
    return { ready: false, reason: 'MEDIA_ENABLED is false' };
  }

  if (!CONFIG.ATLAS_MODEL_API_KEY) {
    return { ready: false, reason: 'ATLAS_MODEL_API_KEY not configured' };
  }

  try {
    if (source === 'gcs') {
      // Check GCS access
      const storage = getGcsStorage();
      const manifestPath = `incident-media/datasets/${dataset}/manifest.json`;
      const [exists] = await storage.bucket(CONFIG.MEDIA_GCS_BUCKET).file(manifestPath).exists();

      if (!exists) {
        return { ready: false, reason: `GCS manifest not found: ${manifestPath}` };
      }

      const cache = await loadImageCache(source, dataset);
      const totalImages = Object.values(cache).reduce(
        (sum, cat) => sum + Object.values(cat).reduce((s, arr) => s + arr.length, 0),
        0
      );

      return { ready: true, source: 'gcs', dataset, imageCount: totalImages };

    } else {
      // Check local filesystem
      await fs.access(CONFIG.MEDIA_IMAGES_DIR);
      const cache = await loadImageCache(source, dataset);
      const totalImages = Object.values(cache).reduce(
        (sum, cat) => sum + Object.values(cat).reduce((s, arr) => s + arr.length, 0),
        0
      );

      if (totalImages === 0) {
        return { ready: false, reason: 'No images found in MEDIA_IMAGES_DIR' };
      }

      return { ready: true, source: 'local', imageCount: totalImages };
    }

  } catch (err) {
    return { ready: false, reason: `Media service error: ${err.message}` };
  }
}

/**
 * List available datasets in GCS bucket
 */
export async function listGcsDatasets() {
  try {
    const storage = getGcsStorage();
    const [files] = await storage.bucket(CONFIG.MEDIA_GCS_BUCKET).getFiles({
      prefix: 'incident-media/datasets/',
      delimiter: '/'
    });

    // Extract dataset names from prefixes
    const datasets = [];
    const prefixes = files.prefixes || [];
    for (const prefix of prefixes) {
      const match = prefix.match(/incident-media\/datasets\/([^/]+)\//);
      if (match) datasets.push(match[1]);
    }

    // Also check for manifest files directly
    const [manifestFiles] = await storage.bucket(CONFIG.MEDIA_GCS_BUCKET).getFiles({
      prefix: 'incident-media/datasets/'
    });

    for (const file of manifestFiles) {
      const match = file.name.match(/incident-media\/datasets\/([^/]+)\/manifest\.json/);
      if (match && !datasets.includes(match[1])) {
        datasets.push(match[1]);
      }
    }

    return datasets;
  } catch (err) {
    console.error('[mediaService] Failed to list GCS datasets:', err.message);
    return [];
  }
}
