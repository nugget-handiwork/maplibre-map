// Reading a colour token into JavaScript is exactly what the other
// templates are told never to do, because a value read once freezes at
// whatever the theme was when it was read. MapLibre leaves no choice: it
// paints through WebGL and needs real RGBA to interpolate between, so a
// `var()` string is not something it can accept.
//
// The way back to a live colour is to re-read and repaint. The frame
// script sets `color-scheme` on the root element when the app changes
// theme, which is what `light-dark()` resolves through, so observing that
// attribute catches every change — and it fires after the frame has
// applied it, where listening for the theme message directly would race.

// Reading the custom property directly is not enough: a custom property
// computes to its token stream, so getPropertyValue hands back the literal
// text `light-dark(#ffffff, #111111)` rather than a colour. Assigning it to
// a real colour property on a probe element is what forces the browser to
// resolve it against the current color-scheme, and `color` computes to an
// rgb() string that MapLibre accepts.
let probe: HTMLElement | undefined

export function token(name: string): string {
  if (!probe) {
    probe = document.createElement('span')
    probe.style.display = 'none'
    document.body.append(probe)
  }
  probe.style.color = `var(--${name})`
  return getComputedStyle(probe).color
}

export function ramp(name: string, steps = 6): string[] {
  return Array.from({ length: steps }, (_, step) => token(`${name}-${step + 1}`))
}

export function onThemeChange(callback: () => void): void {
  new MutationObserver(callback).observe(document.documentElement, {
    attributes: true,
    attributeFilter: ['style'],
  })
}
