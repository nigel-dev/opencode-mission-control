import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  setCurrentModel,
  getCurrentModel,
  getCurrentModelInfo,
  clearCurrentModel,
  setConfigFallbackModel,
  setCurrentModelFromSDK,
  _resetForTesting,
  _getSessionMapSize,
} from '../../src/lib/model-tracker';

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

  it('clearCurrentModel() clears lastSetModel', () => {
    setCurrentModel({ providerID: 'anthropic', modelID: 'claude-4' });
    expect(getCurrentModel()).toBe('anthropic/claude-4');
    clearCurrentModel();
    expect(getCurrentModel()).toBeUndefined();
  });

  it('clearCurrentModel(sessionID) clears only that session', () => {
    setCurrentModel({ providerID: 'anthropic', modelID: 'claude-4' }, 'ses_a');
    setCurrentModel({ providerID: 'openai', modelID: 'gpt-4o' }, 'ses_b');
    clearCurrentModel('ses_a');
    expect(getCurrentModel('ses_a')).toBe('openai/gpt-4o'); // falls back to lastSetModel
    expect(getCurrentModel('ses_b')).toBe('openai/gpt-4o'); // still in session map
  });

  it('setCurrentModelFromSDK maps id to modelID correctly', () => {
    setCurrentModelFromSDK({ id: 'claude-opus-4', providerID: 'anthropic' }, 'ses_sdk');
    expect(getCurrentModel('ses_sdk')).toBe('anthropic/claude-opus-4');
    const info = getCurrentModelInfo('ses_sdk');
    expect(info).toEqual({ providerID: 'anthropic', modelID: 'claude-opus-4' });
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
