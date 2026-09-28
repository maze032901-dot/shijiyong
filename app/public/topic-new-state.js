const key = 'hermes-topic-seen-sources-v1';

function read(storage) {
  try {
    const value = JSON.parse(storage.getItem(key) || '{}');
    return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  } catch { return {}; }
}

function write(storage, value) {
  try { storage.setItem(key, JSON.stringify(value)); } catch { /* Private browsing can deny storage. */ }
}

export function newSourcesForTheme(storage, theme, sourceKeys) {
  const state = read(storage);
  const current = [...new Set(sourceKeys)];
  if (!Array.isArray(state[theme.id])) {
    if (theme.dynamic) return current.length;
    state[theme.id] = current;
    write(storage, state);
    return 0;
  }
  const seen = new Set(state[theme.id]);
  return current.filter(id => !seen.has(id)).length;
}

export function markThemeSeen(storage, themeId, sourceKeys) {
  const state = read(storage);
  state[themeId] = [...new Set(sourceKeys)];
  write(storage, state);
}
