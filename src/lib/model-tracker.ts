import { getProjectDirectory } from './project-context';

/**
 * Tracks the model selected in the sessions of a project's command center, so
 * jobs can run on the model of the session that launched them. Job sessions
 * are not tracked: a job's model must not become the default for later jobs.
 *
 * Model is captured from multiple sources (in priority order):
 * 1. Per-session Map[sessionID] — stores model per OpenCode session
 * 2. lastSetModel — the most recently set model (any session), used as fallback
 * 3. config fallback — the server's default model, read at plugin init
 */

export interface ModelInfo {
  providerID: string;
  modelID: string;
}

const MAX_SESSION_ENTRIES = 20;

interface ProjectModels {
  /** Per-session model storage, keyed by sessionID. Capped at MAX_SESSION_ENTRIES. */
  sessionModels: Map<string, ModelInfo>;
  /** The last model set from any session of the project. */
  lastSetModel?: ModelInfo;
  /** Config-based fallback model string (format: "provider/model"). */
  configFallbackModel?: string;
}

// Keyed by project directory: one server hosts a plugin instance per project,
// and one project's model must never leak into another project's jobs.
const projects = new Map<string, ProjectModels>();

function current(): ProjectModels {
  const directory = getProjectDirectory();
  let models = projects.get(directory);
  if (!models) {
    models = { sessionModels: new Map() };
    projects.set(directory, models);
  }
  return models;
}

/**
 * Evict the oldest entry from sessionModels if at capacity.
 * Uses Map iteration order (insertion order) for FIFO eviction.
 */
function evictIfNeeded(sessionModels: Map<string, ModelInfo>): void {
  if (sessionModels.size >= MAX_SESSION_ENTRIES) {
    const oldest = sessionModels.keys().next().value;
    if (oldest !== undefined) {
      sessionModels.delete(oldest);
    }
  }
}

/**
 * Update the tracked model of the current project.
 * If sessionID is provided, stores per-session. Always updates lastSetModel.
 */
export function setCurrentModel(model: ModelInfo | undefined, sessionID?: string): void {
  if (!model?.providerID || !model?.modelID) {
    return;
  }
  const info: ModelInfo = { providerID: model.providerID, modelID: model.modelID };
  const models = current();

  models.lastSetModel = info;

  if (sessionID) {
    // Delete first to refresh insertion order on re-set
    models.sessionModels.delete(sessionID);
    evictIfNeeded(models.sessionModels);
    models.sessionModels.set(sessionID, info);
  }
}

/**
 * Set the fallback model string from opencode config (format: "provider/model").
 * Used when no model has been captured from events yet.
 */
export function setConfigFallbackModel(modelString: string | undefined): void {
  if (modelString && modelString.includes('/')) {
    current().configFallbackModel = modelString;
  }
}

/**
 * Get the current model as a "provider/model" string.
 *
 * Priority chain:
 * 1. sessionModels[sessionID] (if sessionID provided and present)
 * 2. lastSetModel (most recently set from any session of this project)
 * 3. configFallbackModel (from opencode config)
 * 4. undefined
 */
export function getCurrentModel(sessionID?: string): string | undefined {
  const models = current();
  const model = (sessionID ? models.sessionModels.get(sessionID) : undefined) ?? models.lastSetModel;

  return model
    ? `${model.providerID}/${model.modelID}`
    : models.configFallbackModel;
}

/** Forget the current project's models (when its plugin instance unloads). */
export function clearProjectModels(): void {
  projects.delete(getProjectDirectory());
}

/**
 * Set the current model from a model reference (as received in the session `context` hook).
 * Maps Model.id → ModelInfo.modelID and Model.providerID → ModelInfo.providerID.
 */
export function setCurrentModelFromSDK(
  model: { id: string; providerID: string } | undefined,
  sessionID?: string,
): void {
  if (!model?.id || !model?.providerID) {
    return;
  }
  setCurrentModel({ providerID: model.providerID, modelID: model.id }, sessionID);
}

/**
 * Reset all state. Exported for testing only.
 * @internal
 */
export function _resetForTesting(): void {
  projects.clear();
}

/**
 * Get the session models map size. Exported for testing only.
 * @internal
 */
export function _getSessionMapSize(): number {
  return current().sessionModels.size;
}
