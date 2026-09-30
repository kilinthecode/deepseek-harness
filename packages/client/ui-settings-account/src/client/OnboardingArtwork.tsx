/**
 * The eight onboarding PNGs and their paired markup, as one package-local
 * chunk: the artwork is fetched only when a step first renders it, so a page
 * load that never shows onboarding transfers none of its image bytes.
 */
import { OnboardingIllustration } from './OnboardingIllustration.tsx'
import welcome from './assets/onboarding-welcome.png'
import welcomeDark from './assets/onboarding-welcome-dark.png'
import welcomeZh from './assets/onboarding-welcome-zh.png'
import welcomeZhDark from './assets/onboarding-welcome-zh-dark.png'
import recharge from './assets/onboarding-recharge.png'
import rechargeDark from './assets/onboarding-recharge-dark.png'
import rechargeZh from './assets/onboarding-recharge-zh.png'
import rechargeZhDark from './assets/onboarding-recharge-zh-dark.png'

/** Onboarding steps whose artwork this chunk carries. */
export type OnboardingArtworkStep = 'welcome' | 'credit'

/** The light and dark variants of one step's illustration. */
interface OnboardingArtworkPair {
  light: string
  dark: string
}

/** Every step's artwork, keyed by step and interface language. */
const artwork: Record<OnboardingArtworkStep, Record<'en' | 'zh', OnboardingArtworkPair>> = {
  welcome: { en: { light: welcome, dark: welcomeDark }, zh: { light: welcomeZh, dark: welcomeZhDark } },
  credit: { en: { light: recharge, dark: rechargeDark }, zh: { light: rechargeZh, dark: rechargeZhDark } },
}

/** Inputs the entry-side loader supplies: the step, the active language, and its geometry. */
export interface OnboardingArtworkProps {
  /** Step whose PNG set this render shows. */
  step: OnboardingArtworkStep
  /** Active interface language. */
  locale: string
  /** Step-owned geometry appended to the paired wrapper. */
  className: string | undefined
  /** Wrapper class of the light/dark image pair. */
  rootClassName: string | undefined
  /** Light-theme image class. */
  lightClassName: string | undefined
  /** Dark-theme image class. */
  darkClassName: string | undefined
}

/**
 * @param props - owning step, active interface language and feature-owned geometry.
 * @returns the step's light/dark illustration pair.
 */
export function OnboardingArtwork({ step, locale, className, rootClassName, lightClassName, darkClassName }: OnboardingArtworkProps) {
  const pair = artwork[step][locale === 'zh' ? 'zh' : 'en']
  return <OnboardingIllustration className={className} rootClassName={rootClassName} lightClassName={lightClassName}
    darkClassName={darkClassName} src={pair.light} darkSrc={pair.dark} />
}
