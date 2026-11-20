import { AsyncLocalStorage } from 'node:async_hooks';

interface ProjectContext {
  directory: string;
}

const storage = new AsyncLocalStorage<ProjectContext>();

/**
 * Run `fn` with `directory` as the project directory for everything it calls,
 * including async continuations and timers it creates.
 *
 * OpenCode V2 loads plugins into a shared background server whose process cwd
 * is unrelated to the project, and one server hosts a plugin instance per
 * location. Every entry point (setup, tools, commands, hooks) must therefore
 * enter the context of its own instance's location.
 */
export function runInProject<T>(directory: string, fn: () => T): T {
  return storage.run({ directory }, fn);
}

/**
 * Bind `fn` to a project directory. The host invokes tools, commands and hooks
 * from its own async context, so every callback handed to it must re-enter the
 * project it was registered for.
 */
export function bindToDirectory<A extends unknown[], R>(
  directory: string,
  fn: (...args: A) => R,
): (...args: A) => R {
  return (...args) => runInProject(directory, () => fn(...args));
}

/**
 * Bind `fn` to the current project directory. Call this while still inside the
 * project context: transform callbacks are replayed by the host outside it, so
 * capture the directory before registering a transform and use `bindToDirectory`.
 */
export function bindToProject<A extends unknown[], R>(
  fn: (...args: A) => R,
): (...args: A) => R {
  return bindToDirectory(getProjectDirectory(), fn);
}

// Command-center project directories registered by live plugin instances.
const registered = new Set<string>();

/**
 * Register the current project as loaded. Used only as a fallback for
 * `getProjectDirectory` (see there); the returned function unregisters it.
 */
export function registerProject(): () => void {
  const directory = getProjectDirectory();
  registered.add(directory);
  return () => {
    registered.delete(directory);
  };
}

/**
 * The project directory of the current plugin instance.
 *
 * Outside a project context this falls back to the only registered project,
 * if there is exactly one: the host runtime can drop async context across some
 * continuations, and in a single-project server that project is still the
 * right answer. With several projects loaded there is no right answer, and
 * guessing would read or change another project's state, so it throws. With
 * no plugin instance loaded at all (tests, scripts) the process runs in the
 * project, and its working directory is used.
 */
export function getProjectDirectory(): string {
  const store = storage.getStore();
  if (store) {
    return store.directory;
  }
  if (registered.size === 1) {
    const [only] = registered;
    return only;
  }
  if (registered.size > 1) {
    throw new Error(
      'Mission Control lost track of which project it is working in (several projects are loaded and this code ran outside a project context). ' +
        'This is a bug: a callback was not bound to its project.',
    );
  }
  return process.cwd();
}
