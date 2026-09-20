const paths = {
  overview: '<path d="M4 11.5 12 4l8 7.5v8.2a.8.8 0 0 1-.8.8H4.8a.8.8 0 0 1-.8-.8v-8.2Z"/><path d="M9.2 20.5v-5.8h5.6v5.8"/>',
  models: '<rect x="4" y="4" width="16" height="5" rx="1"/><rect x="4" y="15" width="16" height="5" rx="1"/><path d="M7.5 6.5h.01M7.5 17.5h.01"/>',
  playground: '<path d="M7 7.5 4.5 10 7 12.5M17 7.5l2.5 2.5-2.5 2.5M14.5 5l-5 10"/><rect x="3" y="3" width="18" height="18" rx="3"/>',
  tests: '<path d="M9 3h6M12 3v5M7.4 11.5 4.8 18a2 2 0 0 0 1.9 2.7h10.6a2 2 0 0 0 1.9-2.7l-2.6-6.5"/><path d="M8.5 15h7"/>',
  settings: '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .34 1.88l.06.06-2.66 2.66-.06-.06a1.7 1.7 0 0 0-1.88-.34 1.7 1.7 0 0 0-1.03 1.56v.09h-3.76v-.09a1.7 1.7 0 0 0-1.03-1.56 1.7 1.7 0 0 0-1.88.34l-.06.06-2.66-2.66.06-.06A1.7 1.7 0 0 0 5.16 15a1.7 1.7 0 0 0-1.56-1.03h-.09v-3.76h.09A1.7 1.7 0 0 0 5.16 9.2a1.7 1.7 0 0 0-.34-1.88l-.06-.06L7.42 4.6l.06.06a1.7 1.7 0 0 0 1.88.34 1.7 1.7 0 0 0 1.03-1.56v-.09h3.76v.09a1.7 1.7 0 0 0 1.03 1.56 1.7 1.7 0 0 0 1.88-.34l.06-.06 2.66 2.66-.06.06a1.7 1.7 0 0 0-.34 1.88 1.7 1.7 0 0 0 1.56 1.03h.09v3.76h-.09A1.7 1.7 0 0 0 19.4 15Z"/>',
  logs: '<path d="M5 4.5h14v15H5zM8 8h8M8 12h8M8 16h5"/>',
  logout: '<path d="M10 5H5v14h5M14 8l4 4-4 4M18 12H9"/>',
  refresh: '<path d="M20 12a8 8 0 1 1-2.34-5.66L20 8.67M20 4v4.67h-4.67"/>',
  stop: '<rect x="7" y="7" width="10" height="10" rx="1"/>',
  check: '<path d="m5 12 4.2 4.2L19 6.5"/>',
  alert: '<path d="M12 3 2.8 20h18.4L12 3Z"/><path d="M12 9v4M12 17h.01"/>',
  arrow: '<path d="m9 18 6-6-6-6"/>',
};

export function icon(name, label = '') {
  const title = label ? `<title>${label}</title>` : '';
  return `<svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="${label ? 'false' : 'true'}"${label ? ' role="img" aria-label="' + label + '"' : ''}>${title}${paths[name] || ''}</svg>`;
}
