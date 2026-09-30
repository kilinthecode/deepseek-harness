/** Fetches the onboarding artwork chunk when a step first renders its illustration. */
import { lazy, Suspense, type ReactNode } from 'react'
import type { OnboardingArtworkProps } from './OnboardingArtwork.tsx'
import css from './DesktopOnboarding.module.css'

const LoadedOnboardingArtwork = lazy(async () => ({ default: (await import('./OnboardingArtwork.tsx')).OnboardingArtwork }))

/** One onboarding step's illustration, deferred until that step renders. */
export interface OnboardingArtworkLoaderProps {
  /** Step whose PNG set to show. */
  step: OnboardingArtworkProps['step']
  /** Active interface language. */
  locale: string
  /** Step-owned geometry appended to the paired wrapper. */
  className: string | undefined
}

/**
 * @param props - owning step, active interface language and step-owned geometry.
 * @returns the step's illustration once its chunk has arrived, nothing before that.
 */
export function OnboardingArtworkLoader({ step, locale, className }: OnboardingArtworkLoaderProps): ReactNode {
  return <Suspense fallback={null}>
    <LoadedOnboardingArtwork step={step} locale={locale} className={className}
      rootClassName={css.illustration} lightClassName={css.lightIllustration} darkClassName={css.darkIllustration} />
  </Suspense>
}
