/** Paired artwork follows the page's light and dark theme selectors. */

/**
 * The wrapper and image classes are parameters rather than a stylesheet import:
 * this module ships inside the deferred artwork chunk, and a chunk that shared
 * the feature stylesheet with the startup bundle would need a cross-chunk
 * require the module loader cannot resolve.
 * @param props - artwork URLs, feature-owned geometry, and the pair's theme classes.
 * @returns decorative theme variants.
 */
export function OnboardingIllustration({ className = '', rootClassName, lightClassName, darkClassName, src, darkSrc }: {
  className?: string | undefined
  rootClassName: string | undefined
  lightClassName: string | undefined
  darkClassName: string | undefined
  src: string
  darkSrc: string
}) {
  return <div className={`${rootClassName} ${className}`} aria-hidden="true">
    <img className={lightClassName} src={src} alt="" />
    <img className={darkClassName} src={darkSrc} alt="" />
  </div>
}
