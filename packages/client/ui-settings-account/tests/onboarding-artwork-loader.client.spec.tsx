// @vitest-environment jsdom
/** Geometry of an onboarding illustration without a step-specific wrapper class. */
import { cleanup, render, waitFor } from '@testing-library/react'
import { afterEach, expect, it } from 'vitest'
import { OnboardingArtworkLoader } from '../src/client/OnboardingArtworkLoader.tsx'
import css from '../src/client/DesktopOnboarding.module.css'

afterEach(cleanup)
it('reserves the illustration root and loads its pair when no extra class is supplied', async () => {
  const { container } = render(<OnboardingArtworkLoader step="welcome" locale="en" className={undefined} />)
  expect(container.querySelector('[aria-hidden="true"]')?.classList.contains(css.illustration!)).toBe(true)
  await waitFor(() => { expect(container.querySelectorAll('img')).toHaveLength(2) })
  expect(container.querySelector('[aria-hidden="true"]')?.classList.contains(css.illustration!)).toBe(true)
})
