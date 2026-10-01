// Node's built-in test runner (`yarn test`, see tsconfig.test.json). Used in
// place of a test framework so the zero-install .yarn/cache and the Docker
// build's `yarn install --immutable` need no new packages. The installed
// @types/node (17) predates node:test, so the slice the tests use is
// declared here.
declare module 'node:test' {
  type Fn = () => void | Promise<void>
  export function describe(name: string, fn: Fn): void
  export function it(name: string, fn: Fn): void
  export function test(name: string, fn: Fn): void
}
