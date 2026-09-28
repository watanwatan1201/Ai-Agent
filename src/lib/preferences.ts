import type { AppLocale } from './i18n'

export type AccentTheme = 'green' | 'ocean' | 'coral' | 'gold'
export type CookieConsent = 'all' | 'reject' | null

const COOKIE_YEAR = 60 * 60 * 24 * 365

export function readCookie(name: string): string | null {
  const value = document.cookie.split('; ').find((cookie) => cookie.startsWith(`${name}=`))
  if (!value) return null
  try {
    return decodeURIComponent(value.slice(name.length + 1))
  } catch {
    return null
  }
}

export function writeCookie(name: string, value: string, maxAge = COOKIE_YEAR) {
  const secure = window.location.protocol === 'https:' ? '; Secure' : ''
  document.cookie = `${name}=${encodeURIComponent(value)}; Path=/; Max-Age=${maxAge}; SameSite=Lax${secure}`
}

export function readCookieConsent(): CookieConsent {
  const value = readCookie('daleel_cookie_consent')
  return value === 'all' || value === 'reject' ? value : null
}

export function readGuestName() {
  return readCookie('daleel_student_name') || ''
}

export function readAccentTheme(): AccentTheme {
  const value = readCookie('daleel_theme')
  return value === 'ocean' || value === 'coral' || value === 'gold' ? value : 'green'
}

export function savePreferences(locale: AppLocale, theme: AccentTheme) {
  writeCookie('daleel_locale', locale)
  writeCookie('daleel_theme', theme)
}

export function removeGuestName() {
  writeCookie('daleel_student_name', '', 0)
}