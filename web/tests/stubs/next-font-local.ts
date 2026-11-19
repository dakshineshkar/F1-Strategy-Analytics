/** Vitest stand-in for ``next/font/local``. That module is a build-time transform of the Next compiler and
 * exports nothing at runtime, so the layout's font loaders return the class names a build would. */
export default function localFont(options: { variable?: string }): { className: string; variable: string; style: { fontFamily: string } } {
  const name = (options.variable ?? "--font").replace(/^--/, "");
  return { className: `font-${name}`, variable: `font-var-${name}`, style: { fontFamily: name } };
}
