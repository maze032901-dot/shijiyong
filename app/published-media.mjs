import { readFile, realpath, stat } from 'node:fs/promises';
import path from 'node:path';

const imageExtensions = new Set(['.jpg', '.jpeg', '.png', '.webp']);
const validId = (value) => /^[A-Za-z0-9._-]{1,128}$/.test(String(value ?? ''));

export async function resolvePublishedImage(projectDirectory, sourceId, assetId) {
  if (!validId(sourceId) || !validId(assetId)) return null;
  const publicationPath = path.join(projectDirectory, 'runtime', 'card-library', 'published', `${sourceId}.json`);
  let publication;
  try { publication = JSON.parse(await readFile(publicationPath, 'utf8')); }
  catch { return null; }
  if (String(publication.source_id) !== sourceId) return null;
  const cards = publication.fixture?.cards || [];
  if (!cards.some((card) => card.image_ids?.includes(assetId))) return null;
  const evidencePath = path.resolve(projectDirectory, publication.evidence_path || '');
  const runtimeRoot = await realpath(path.join(projectDirectory, 'runtime'));
  let actualEvidence;
  try { actualEvidence = await realpath(evidencePath); }
  catch { return null; }
  if (!actualEvidence.startsWith(`${runtimeRoot}${path.sep}`)) return null;
  let evidence;
  try { evidence = JSON.parse(await readFile(actualEvidence, 'utf8')); }
  catch { return null; }
  if (String(evidence.source?.id) !== sourceId) return null;
  const asset = evidence.items?.find((item) => item.id === assetId && ['asset', 'ocr'].includes(item.kind));
  if (!asset?.locator?.local_path) return null;
  const evidenceRoot = path.dirname(actualEvidence);
  let target;
  try { target = await realpath(path.resolve(evidenceRoot, asset.locator.local_path)); }
  catch { return null; }
  if (!target.startsWith(`${evidenceRoot}${path.sep}`) || !imageExtensions.has(path.extname(target).toLowerCase())) return null;
  return (await stat(target)).isFile() ? target : null;
}
