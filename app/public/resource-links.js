/** Mirrors the original card detail's project-entry rule, with URL validation. */
export function projectResourceLinks(resources = []) {
  return resources.filter((resource) => {
    if (resource?.availability !== 'available' || typeof resource.url !== 'string') return false;
    try { return ['https:', 'http:'].includes(new URL(resource.url).protocol); }
    catch { return false; }
  });
}
