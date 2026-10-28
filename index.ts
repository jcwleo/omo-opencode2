// OpenCode 2.1.4 loads a local plugin directory from its root file names (server.ts, else index.ts)
// and ignores package.json "exports", so the root entry re-exports the real one.
export { default } from "./src/index.ts"
