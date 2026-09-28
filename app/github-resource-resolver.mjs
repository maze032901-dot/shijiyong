const REPO_PATH = /^([A-Za-z0-9](?:[A-Za-z0-9-]{0,38}))\/([A-Za-z0-9_.-]{1,100})(?=$|[\s（(])/;
const REPO_NAME = /^([A-Za-z0-9_.-]{1,100})(?=$|[\s（(])/;
const LOOKUP_LIMIT = 8;

function resourceKey(cardTitle, label) { return `${cardTitle}\u0000${label}`; }

function exactRepo(label) {
  return REPO_PATH.exec(String(label || '').trim())?.slice(1) || null;
}

function siblingRepo(label) {
  if (!/GitHub|仓库|插件|plugin/i.test(String(label || ''))) return null;
  return REPO_NAME.exec(String(label || '').trim())?.[1] || null;
}

async function verifiedRepo(owner, repo, fetchImpl, timeoutMs) {
  try {
    const response = await fetchImpl(`https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`, {
      headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'ShiJiYong-Preview' },
      redirect: 'error', signal: AbortSignal.timeout(timeoutMs)
    });
    if (!response.ok) return null;
    const result = await response.json();
    if (String(result.full_name || '').toLowerCase() !== `${owner}/${repo}`.toLowerCase()) return null;
    const url = new URL(String(result.html_url || ''));
    return url.protocol === 'https:' && url.hostname === 'github.com' &&
      url.pathname.toLowerCase() === `/${owner}/${repo}`.toLowerCase() ? url.href : null;
  } catch { return null; }
}

/** Verifies only explicit repository names against GitHub; never guesses a URL from prose. */
export async function verifyGithubResources({ cards, fetchImpl = fetch, timeoutMs = 4_000, enabled = true }) {
  const verified = [];
  if (!enabled) return verified;
  let lookups = 0;
  const cache = new Map();
  const check = async (owner, repo) => {
    const key = `${owner}/${repo}`.toLowerCase();
    if (cache.has(key)) return cache.get(key);
    if (lookups >= LOOKUP_LIMIT) return null;
    lookups += 1;
    const result = await verifiedRepo(owner, repo, fetchImpl, timeoutMs);
    cache.set(key, result);
    return result;
  };
  for (const card of cards || []) {
    const resources = (card.resources || []).filter((item) => !item.url && item.availability === 'unverified');
    const owners = new Set();
    for (const resource of resources) {
      const exact = exactRepo(resource.label);
      if (!exact) continue;
      const url = await check(...exact);
      if (!url) continue;
      owners.add(exact[0]);
      verified.push({ key: resourceKey(card.title, resource.label), url });
    }
    if (owners.size !== 1) continue;
    const owner = [...owners][0];
    for (const resource of resources) {
      if (exactRepo(resource.label)) continue;
      const name = siblingRepo(resource.label);
      if (!name) continue;
      const url = await check(owner, name);
      if (url) verified.push({ key: resourceKey(card.title, resource.label), url });
    }
  }
  return verified;
}

export function applyVerifiedGithubResources(card, verifiedResources) {
  const urls = new Map(verifiedResources.map((item) => [item.key, item.url]));
  return (card.resources || []).map((resource) => {
    const url = urls.get(resourceKey(card.title, resource.label));
    return !url || resource.url ? resource : {
      ...resource, type: 'github', availability: 'available', url,
      note: [resource.note, 'GitHub 仓库地址已核实。'].filter(Boolean).join(' ')
    };
  });
}
