/**
 * Tracks the current model selected in the control center session.
 * Used to spawn child agents with the same model as the parent.
 */

export interface ModelInfo {
  providerID: string;
  modelID: string;
}

let currentModel: ModelInfo | undefined;

/**
 * Update the tracked model from a UserMessage event.
 */
export function setCurrentModel(model: ModelInfo | undefined): void {
  if (model?.providerID && model?.modelID) {
    currentModel = { ...model };
  }
}

/**
 * Get the current model as a CLI-compatible string (provider/model).
 * Returns undefined if no model has been captured yet.
 */
export function getCurrentModel(): string | undefined {
  if (!currentModel) {
    return undefined;
  }
  return `${currentModel.providerID}/${currentModel.modelID}`;
}

/**
 * Get the raw model info object.
 */
export function getCurrentModelInfo(): ModelInfo | undefined {
  return currentModel ? { ...currentModel } : undefined;
}

/**
 * Clear the tracked model.
 */
export function clearCurrentModel(): void {
  currentModel = undefined;
}
