/** A label with a shorter visible form on a phone (≤ 640 px, globals.css), so the race head and the status strip
 * wrap onto fewer lines without cutting anything. The full text is always the accessible name: on a phone it is
 * visually hidden (still read), and the short form is ``aria-hidden``. The short form is a word of the full one,
 * so the visible label stays part of the accessible name (WCAG 2.5.3). */
export function PhoneLabel({ full, short }: { full: string; short: string }) {
  return (
    <>
      <span className="phone-full">{full}</span>
      <span className="phone-short" aria-hidden="true">
        {short}
      </span>
    </>
  );
}
