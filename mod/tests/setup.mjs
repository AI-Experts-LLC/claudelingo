/**
 * The two globals a hooks module's environment provides, for the specs that
 * run under vitest.
 *
 * `h` and `Fragment` are what JSX compiles against. Claude Code supplies them;
 * a spec running outside it has to. This mirrors the documented contract
 * rather than approximating it: children arrive flattened, and `false`, `null`
 * and `undefined` are dropped, so `{ok && <Text/>}` behaves in a spec exactly
 * as it does in the band.
 */
const flatten = (children) =>
  children
    .flat(Infinity)
    .filter((child) => child !== false && child !== null && child !== undefined)

globalThis.h = (tag, props, ...children) =>
  tag({ ...(props ?? {}), children: flatten(children) })

globalThis.Fragment = (props) => ({ type: 'Box', props: { flexDirection: 'column' }, children: props.children ?? [] })
