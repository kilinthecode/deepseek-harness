/** Illustration imports are embedded in the account package's client artifacts. */
declare module '*.png' {
  const svg: string
  export default svg
}
declare module '*.svg' {
  const url: string
  export default url
}
