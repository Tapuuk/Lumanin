/** The settings app's sections, in sidebar order. `Ctrl+1..4` follow this order. */
export const SECTIONS = [
  { id: 'panel', title: 'Panel' },
  { id: 'search', title: 'Search' },
  { id: 'keys', title: 'Keys' },
  { id: 'plugins', title: 'Plugins' }
] as const

export type SectionId = (typeof SECTIONS)[number]['id']
