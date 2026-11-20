import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  setCurrentModel,
  getCurrentModel,
  clearProjectModels,
  setConfigFallbackModel,
  setCurrentModelFromSDK,
  _resetForTesting,
  _getSessionMapSize,
} from '../../src/lib/model-tracker';
import { runInProject } from '../../src/lib/project-context';

describe('model-tracker', () => {
  beforeEach(() => {
    _resetForTesting();
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  it('setCurrentModel stores model and getCurrentModel returns provider/model string', () => {
    setCurrentModel({ providerID: 'anthropic', modelID: 'claude-4' });
    expect(getCurrentModel()).toBe('anthropic/claude-4');
  });

  it('setCurrentModel with sessionID stores per-session', () => {
    setCurrentModel({ providerID: 'anthropic', modelID: 'claude-4' }, 'ses_abc');
    expect(getCurrentModel('ses_abc')).toBe('anthropic/claude-4');
  });

  it('getCurrentModel() without sessionID returns lastSetModel', () => {
    setCurrentModel({ providerID: 'openai', modelID: 'gpt-4o' }, 'ses_xyz');
    expect(getCurrentModel()).toBe('openai/gpt-4o');
  });

  it('getCurrentModel(unknownSession) falls back to lastSetModel', () => {
    setCurrentModel({ providerID: 'anthropic', modelID: 'claude-4' }, 'ses_known');
    expect(getCurrentModel('ses_unknown')).toBe('anthropic/claude-4');
  });

  it('getCurrentModel() falls back to configFallbackModel', () => {
    setConfigFallbackModel('google/gemini-pro');
    expect(getCurrentModel()).toBe('google/gemini-pro');
  });

  it('getCurrentModel() returns undefined when nothing set', () => {
    expect(getCurrentModel()).toBeUndefined();
  });

  it('setCurrentModel with missing providerID is no-op', () => {
    setCurrentModel({ providerID: '', modelID: 'claude-4' });
    expect(getCurrentModel()).toBeUndefined();
  });

  it('setCurrentModel with missing modelID is no-op', () => {
    setCurrentModel({ providerID: 'anthropic', modelID: '' });
    expect(getCurrentModel()).toBeUndefined();
  });

  it("keeps each project's models apart", () => {
    runInProject('/projects/a', () => {
      setCurrentModel({ providerID: 'anthropic', modelID: 'claude-4' }, 'ses_a');
      setConfigFallbackModel('anthropic/fallback-a');
    });
    runInProject('/projects/b', () => {
      setCurrentModel({ providerID: 'openai', modelID: 'gpt-4o' }, 'ses_b');
    });

    // Project A's last model is not overwritten by a session of project B,
    // and B never sees A's sessions or fallback.
    expect(runInProject('/projects/a', () => getCurrentModel())).toBe('anthropic/claude-4');
    expect(runInProject('/projects/b', () => getCurrentModel())).toBe('openai/gpt-4o');
    expect(runInProject('/projects/b', () => getCurrentModel('ses_a'))).toBe('openai/gpt-4o');
    expect(runInProject('/projects/c', () => getCurrentModel())).toBeUndefined();
  });

  it("clearProjectModels forgets only the current project's models", () => {
    runInProject('/projects/a', () => setCurrentModel({ providerID: 'anthropic', modelID: 'claude-4' }, 'ses_a'));
    runInProject('/projects/b', () => setCurrentModel({ providerID: 'openai', modelID: 'gpt-4o' }, 'ses_b'));

    runInProject('/projects/a', () => clearProjectModels());

    expect(runInProject('/projects/a', () => getCurrentModel('ses_a'))).toBeUndefined();
    expect(runInProject('/projects/b', () => getCurrentModel('ses_b'))).toBe('openai/gpt-4o');
  });

  it('setCurrentModelFromSDK maps id to modelID correctly', () => {
    setCurrentModelFromSDK({ id: 'claude-opus-4', providerID: 'anthropic' }, 'ses_sdk');
    expect(getCurrentModel('ses_sdk')).toBe('anthropic/claude-opus-4');
  });

  it('session Map evicts oldest at 20 entries', () => {
    for (let i = 0; i < 20; i++) {
      setCurrentModel({ providerID: 'p', modelID: `m${i}` }, `ses_${i}`);
    }
    expect(_getSessionMapSize()).toBe(20);

    setCurrentModel({ providerID: 'p', modelID: 'm20' }, 'ses_20');
    expect(_getSessionMapSize()).toBe(20);

    // ses_0 evicted: session lookup misses, falls back to lastSetModel (m20)
    expect(getCurrentModel('ses_0')).toBe('p/m20');
    // ses_1 still present: session lookup returns its own model
    expect(getCurrentModel('ses_1')).toBe('p/m1');
    // ses_20 present
    expect(getCurrentModel('ses_20')).toBe('p/m20');
  });

  it('setConfigFallbackModel works', () => {
    setConfigFallbackModel('anthropic/claude-4');
    expect(getCurrentModel()).toBe('anthropic/claude-4');
  });

  it('setConfigFallbackModel rejects strings without "/"', () => {
    setConfigFallbackModel('no-slash');
    expect(getCurrentModel()).toBeUndefined();
  });

  it('multiple sessions can have different models', () => {
    setCurrentModel({ providerID: 'anthropic', modelID: 'claude-4' }, 'ses_1');
    setCurrentModel({ providerID: 'openai', modelID: 'gpt-4o' }, 'ses_2');
    setCurrentModel({ providerID: 'google', modelID: 'gemini-pro' }, 'ses_3');

    expect(getCurrentModel('ses_1')).toBe('anthropic/claude-4');
    expect(getCurrentModel('ses_2')).toBe('openai/gpt-4o');
    expect(getCurrentModel('ses_3')).toBe('google/gemini-pro');
  });
});
