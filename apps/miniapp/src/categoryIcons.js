export function categoryIconSvg(slug) {
  const icons = {
    food_cafe: '<path d="M5 8h11v5a5 5 0 0 1-5 5H10a5 5 0 0 1-5-5z"/><path d="M16 10h2a2 2 0 0 1 0 4h-2M7 5h7"/>',
    groceries: '<path d="M5 9h14l-1 11H6z"/><path d="M9 9a3 3 0 0 1 6 0"/>',
    transport: '<rect x="4" y="5" width="16" height="13" rx="3"/><path d="M7 9h10M7 14h10"/><circle cx="8" cy="19" r="1"/><circle cx="16" cy="19" r="1"/>',
    health: '<path d="M12 21s-7-4.4-7-10a4 4 0 0 1 7-2.6A4 4 0 0 1 19 11c0 5.6-7 10-7 10z"/><path d="M9 13h6m-3-3v6"/>',
    sport_activities: '<path d="m7 5 3 3-4 4-3-3zm10 0-3 3 4 4 3-3zM9 15h6m-5-7h4"/>',
    home: '<path d="m4 11 8-7 8 7v9h-5v-6H9v6H4z"/>',
    travel: '<path d="M4 16 20 8l-6 12-3-5zM11 15l-3-3"/>',
    subscriptions: '<rect x="5" y="3" width="14" height="18" rx="3"/><path d="M9 7h6m-6 4h6m-6 4h4"/>',
    education: '<path d="m3 9 9-5 9 5-9 5z"/><path d="M7 12v5c3 2 7 2 10 0v-5"/>',
    gifts_help: '<rect x="4" y="9" width="16" height="11" rx="2"/><path d="M12 9v11M3 9h18V6H3zM12 6c-4 0-4-4-1-4 2 0 1 4 1 4zm0 0c4 0 4-4 1-4-2 0-1 4-1 4z"/>',
    entertainment: '<path d="M7 4h10l2 16-7-3-7 3z"/><circle cx="9" cy="10" r="1"/><circle cx="15" cy="10" r="1"/><path d="M9 14h6"/>',
    gear: '<path d="M6 7h12l2 13H4z"/><path d="M9 7a3 3 0 0 1 6 0"/>'
  };
  const content = icons[slug] ?? '<circle cx="12" cy="12" r="8"/><path d="M8 12h8m-4-4v8"/>';
  return `<svg viewBox="0 0 24 24" focusable="false">${content}</svg>`;
}
