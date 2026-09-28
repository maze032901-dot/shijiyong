export function collectionRoute(cards, sourceId, themeId) {
  if (!Array.isArray(cards) || cards.length === 0) return null;
  if (cards.length === 1) {
    return {
      kind: 'card',
      cardId: cards[0].id,
      href: `/topic?topic=${encodeURIComponent(themeId)}&card=${encodeURIComponent(cards[0].id)}`
    };
  }
  return {
    kind: 'group',
    href: `/interaction?source=${encodeURIComponent(sourceId)}&topic=${encodeURIComponent(themeId)}`
  };
}
