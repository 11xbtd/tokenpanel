import { createContext, useContext, useEffect, useState } from 'react'
import type { Settings } from '../../core/types'

export const DarkContext = createContext(false)
export const useDark = (): boolean => useContext(DarkContext)

export function useResolvedDark(theme: Settings['theme']): boolean {
  const [dark, setDark] = useState(() => {
    if (theme === 'dark') return true
    if (theme === 'light') return false
    return typeof window !== 'undefined' && window.matchMedia('(prefers-color-scheme: dark)').matches
  })

  useEffect(() => {
    const media = window.matchMedia('(prefers-color-scheme: dark)')
    const apply = () => {
      const next = theme === 'dark' || (theme === 'system' && media.matches)
      document.documentElement.classList.toggle('dark', next)
      document.documentElement.style.colorScheme = next ? 'dark' : 'light'
      setDark(next)
    }
    apply()
    media.addEventListener('change', apply)
    return () => media.removeEventListener('change', apply)
  }, [theme])

  return dark
}
