const paths = {
  play: 'm8 5 11 7-11 7V5Z',
  upload: 'M12 16V3m-5 5 5-5 5 5M4 15v5h16v-5',
  download: 'M12 3v13m-5-5 5 5 5-5M4 17v4h16v-4',
  file: 'M14 2H5v20h14V7l-5-5Zm0 0v6h5M8 12h8m-8 4h6',
  folder: 'M3 6h7l2 3h9v12H3V6Z',
  shield: 'm12 3 8 3v6c0 5-8 9-8 9s-8-4-8-9V6l8-3Zm-4 9 3 3 5-6',
  compare: 'M4 4v16m16-16v16M8 8h8m-3-3 3 3-3 3M16 16H8m3-3-3 3 3 3',
  clock: 'M12 8v5l3 2M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0Z',
  close: 'm6 6 12 12M6 18 18 6',
  check: 'm5 12 4 4L19 6',
  plus: 'M12 5v14M5 12h14',
  arrow: 'M5 12h14m-5-5 5 5-5 5',
  chevron: 'm9 5 7 7-7 7',
  trash: 'M3 6h18M9 6V3h6v3M5 6l1 15h12l1-15M10 10v7m4-7v7',
  refresh: 'M20 7a9 9 0 1 0 1 8M20 3v5h-5',
  info: 'M12 11v6m0-10v1M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0Z',
  menu: 'M4 6h16M4 12h16M4 18h16',
  lab: 'M9 3h6m-5 0v6L4 19a1 1 0 0 0 1 2h14a1 1 0 0 0 1-2L14 9V3M8 14h8',
} as const;

export function Icon({ name, size = 18, className = '' }: { name: keyof typeof paths; size?: number; className?: string }) {
  return <svg className={className} width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.65" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={paths[name]} /></svg>;
}
