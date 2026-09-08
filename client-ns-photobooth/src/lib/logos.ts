/**
 * Every selectable logo, in one place.
 *
 * Two slots draw from this set and they are independent: the banner logo shown
 * over the live feed (anim/banner.ts) and the middle footer logo on the photo
 * strip (lib/photoStrip.ts). Keeping one map means adding a company means
 * adding one line here, not two.
 *
 * Only KEYS are persisted in the store, never paths, so a stored selection
 * survives an asset being renamed or re-exported.
 */
import logo11Url from '../assets/icons/11logo.png'
import fusionLogoUrl from '../assets/icons/fusionlogo.png'
import atlasLogoUrl from '../assets/icons/Atlas Logo.png'
import boreasLogoUrl from '../assets/icons/Boreas Logo.png'
import hqLogoUrl from '../assets/icons/HQ Logo.png'
import rstaLogoUrl from '../assets/icons/RSTA Logo.png'
import signalLogoUrl from '../assets/icons/Signal Logo.png'

export const LOGO_URLS = {
  '11': logo11Url,
  fusion: fusionLogoUrl,
  atlas: atlasLogoUrl,
  boreas: boreasLogoUrl,
  hq: hqLogoUrl,
  rsta: rstaLogoUrl,
  signal: signalLogoUrl,
} as const

export type LogoKey = keyof typeof LOGO_URLS

/** Human labels, shared by both dropdowns. 'none' is not a file, so it is not
 * in LOGO_URLS - each slot handles it by drawing nothing. */
export const LOGO_LABELS: Record<LogoKey, string> = {
  '11': '11',
  fusion: 'Fusion',
  atlas: 'Atlas',
  boreas: 'Boreas',
  hq: 'HQ',
  rsta: 'RSTA',
  signal: 'Signal',
}
