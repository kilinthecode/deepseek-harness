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
 * @returns the step's illustration once its chunk has arrived; before that, the
 * same image-free root so the step keeps its geometry while the chunk loads.
 */
export function OnboardingArtworkLoader({ step, locale, className }: OnboardingArtworkLoaderProps): ReactNode {
  // The fallback is the artwork root's own markup without its images — same
  // classes and aria-hidden — so the step reserves the illustration geometry
  // and the arriving pair replaces it without reflowing the page.
  return <Suspense fallback={<div className={`${css.illustration} ${className ?? ''}`} aria-hidden="true" />}>
    <LoadedOnboardingArtwork step={step} locale={locale} className={className}
      rootClassName={css.illustration} lightClassName={css.lightIllustration} darkClassName={css.darkIllustration} />
  </Suspense>
}
